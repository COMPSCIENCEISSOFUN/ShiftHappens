import { SERVER_LOCALE } from "@/lib/timezone";
/**
 * Availability Service (Control Layer)
 * 
 * Business logic for managing staff availability schedules.
 * Supports weekly recurring patterns and date-specific overrides.
 * 
 * Used by the eligibility engine to check if staff can work
 * at a specific date/time before assignment.
 */
import {
  AvailabilityRepository,
  isLapsedLeave,
  overrideDateKey,
} from "@/repositories/availability.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { EligibilityService } from "@/services/eligibility.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { MembershipRepository } from "@/repositories/membership.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import {
  AuditLogService,
  ACTIONS,
  type AuditAction,
} from "@/services/audit-log.service";
import { taskWatcherUserIds } from "@/services/task-watchers";
import { isFullTime } from "@/lib/role-config";

/**
 * The audit entry each verdict raises.
 *
 * A map rather than a ternary chain, and typed on the verdict union, so adding
 * a fourth verdict fails to COMPILE until it has an audit action — the same
 * device the audit-log page uses with `Record<AuditAction, string>` for
 * labels. The ternary this replaced would have silently filed a new verdict as
 * a rejection.
 */
const LEAVE_AUDIT_ACTION: Record<LeaveVerdict, AuditAction> = {
  approved: ACTIONS.LEAVE_APPROVED,
  rejected: ACTIONS.LEAVE_REJECTED,
  dismissed: ACTIONS.LEAVE_DISMISSED,
};

/** What a reviewer may do to a leave request. See `reviewLeave`. */
export type LeaveVerdict = "approved" | "rejected" | "dismissed";
import { memberInScope } from "@/lib/department-scope";
import { DATE_RANGE_MESSAGE, parseDateRange } from "@/lib/date-range";
import {
  chaseBoundaries,
  chaseStageFor,
  isClosingSoon,
} from "@/lib/leave-timing";
import { DEFAULT_HORIZON_DAYS } from "@/lib/scheduling-horizon";
import {
  DEFAULT_LEAVE_VIEW,
  LEAVE_PAGE_SIZE,
  LEAVE_TILE_VIEWS,
  leaveOrderFor,
  type LeaveView,
} from "@/lib/leave-filters";
import type {
  SetAvailabilityInput,
  CreateAvailabilityOverrideInput,
} from "@/lib/validations";

/**
 * How close to a shift automation stops being appropriate.
 *
 * Two days is enough for somebody to see a notification, decide, and answer;
 * inside it, filling the gap is a conversation. The exact figure is a judgement
 * rather than a rule, which is why it is named here instead of inlined.
 */
const SHORT_NOTICE_HOURS = 48;

/** A shift the member is still expected to work. */
interface Commitment {
  /** The row to cancel — the task id alone cannot identify it. */
  assignmentId: string;
  taskId: string;
  taskTitle: string;
  organizationId: string;
  departmentId: string | null;
  scheduledStart: Date | null;
}

/**
 * Rejected because the window has no length.
 *
 * Exported so the two routes that map it to a 400 match a value rather than a
 * substring. They matched `includes("End time")` against the old message, and
 * when the wording changed — narrowing "end must be after start" to "start and
 * end cannot be the same" — both silently began returning 500 for a form
 * mistake a user makes by leaving a picker alone. A constant makes that class
 * of drift a compile error instead of a status code nobody notices.
 */
export const WINDOW_LENGTH_ERROR = "Start and end time cannot be the same";

export class AvailabilityService {
  private availRepo = new AvailabilityRepository();
  private taskRepo = new TaskRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private eligibilityService = new EligibilityService();
  private notificationService = new NotificationService();
  private membershipRepo = new MembershipRepository();
  private settingsRepo = new SettingsRepository();
  private auditService = new AuditLogService();

  /**
   * Asks a member to review their own availability.
   *
   * ## Why this exists rather than a manager edit
   *
   * There is no path for a manager to change another member's availability,
   * and there should not be. Availability is that person's statement about
   * when they can work, and for casual staff the eligibility engine treats it
   * as a hard constraint. A manager able to rewrite it turns "unavailable"
   * into "unavailable unless someone disagreed" — which is exactly what the
   * documented, per-task, reason-carrying eligibility override already does,
   * and doing it a second way silently would weaken the mechanism that can be
   * defended.
   *
   * The dashboard used to recommend "Update Alex's availability", pointing at
   * a page that shows the MANAGER their own schedule. This is that
   * recommendation made real: the question goes to the one person who can
   * answer it.
   *
   * Nothing is asserted about the availability being wrong. The notification
   * says declines were noticed and asks them to confirm — because repeated
   * declines for schedule conflicts do not establish that a schedule is stale.
   */
  async requestAvailabilityReview(
    organizationId: string,
    targetUserId: string,
    requestedByName: string,
    actorUserId?: string,
    /**
     * The caller's departments, or null/undefined for a company admin.
     *
     * The notification is signed with the sender's name, so without this any
     * manager could send a nudge, apparently personally, to every member of the
     * organisation. Reported as "not found" when out of scope — the same answer
     * as a member who does not exist.
     */
    departmentScope?: string[] | null
  ) {
    const membership = await this.membershipRepo.findByUserAndOrg(
      targetUserId,
      organizationId
    );
    // Cross-tenant guard: the id arrives from a request body, so belonging to
    // this organisation has to be proved rather than assumed.
    if (!membership) throw new Error("Member not found");

    if (departmentScope !== undefined && departmentScope !== null) {
      const scope = new Set(departmentScope);
      const inScope = (membership.departmentMemberships ?? []).some(
        (dm: { department: { id: string } }) => scope.has(dm.department.id)
      );
      if (!inScope) throw new Error("Member not found");
    }

    /*
     * One nudge a day, per member.
     *
     * This had no guard of any kind: the button posts, the service writes, so a
     * manager clicking it four times sent four identical rows, and two managers
     * who both noticed the same stale availability sent two. The member is
     * being asked to do a five-minute task — repeating the ask within a day
     * adds nothing and reads as nagging.
     *
     * Silently satisfied rather than refused. The manager's intent is "make
     * sure they have been asked", which is already true; an error would tell
     * them off for something that had worked.
     */
    const alreadyAsked = await this.notificationService.wasNotifiedSince(
      targetUserId,
      organizationId,
      NOTIFICATION_TYPES.AVAILABILITY_REVIEW_REQUESTED,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      membership.id
    );

    if (!alreadyAsked) {
      await this.notificationService.notify(
        organizationId,
        targetUserId,
        NOTIFICATION_TYPES.AVAILABILITY_REVIEW_REQUESTED,
        "Please review your availability",
        `${requestedByName} asked you to check your weekly availability is still right.`,
        "availability",
        membership.id
      );
    }

    await this.auditService.log({
      organizationId,
      userId: actorUserId,
      action: ACTIONS.AVAILABILITY_REVIEW_REQUESTED,
      entityType: "member",
      entityId: membership.id,
    });

    return { requested: true };
  }

  /**
   * Sets availability for a single day of the week.
   *
   * ## A window may now wrap past midnight
   *
   * This refused `startTime >= endTime` outright, so a genuine night worker
   * could not declare 22:00–06:00 — they had to split it across two days and
   * hope both halves were read together. Only the SHIFT could wrap. The
   * repository now reads a window that ends before it starts as running into
   * the next morning, which is the same rule it already applied to shifts.
   *
   * EQUAL is still refused, and is the reason this is not simply the check
   * removed: 09:00–09:00 is a window of no length. It is what an empty form or
   * a mis-clicked time picker produces, and storing it would mean "available"
   * for a period nobody can be rostered in.
   */
  async setDayAvailability(membershipId: string, input: SetAvailabilityInput) {
    if (input.isAvailable && input.startTime === input.endTime) {
      throw new Error(WINDOW_LENGTH_ERROR);
    }

    return this.availRepo.setDayAvailability({
      membershipId,
      dayOfWeek: input.dayOfWeek,
      startTime: input.startTime,
      endTime: input.endTime,
      isAvailable: input.isAvailable,
    });
  }

  /**
   * Writes a whole week, whoever asked for it.
   *
   * Wrapped in the ineligibility guard as ONE unit, not per day. Hooking
   * `setDayAvailability` instead would run the check seven times for a single
   * save and could fire an alert off a half-applied week — Monday saved,
   * Tuesday not yet — describing a state that never existed.
   *
   * Private because the two callers below differ on WHO may write, and that is
   * the whole point of them being separate.
   */
  private async writeWeeklySchedule(
    membershipId: string,
    schedule: SetAvailabilityInput[]
  ) {
    return this.withIneligibilityCheck(membershipId, async () => {
      const results = [];
      for (const day of schedule) {
        const result = await this.setDayAvailability(membershipId, day);
        results.push(result);
      }
      return results;
    });
  }

  /**
   * A member setting their OWN weekly pattern.
   *
   * ## Why a full-time member is refused
   *
   * `createOverride` already makes a full-timer's absence a request rather than
   * a declaration, and that gate is worth nothing on its own: a contracted
   * member who wanted Wednesday off never had to ask for it. They could open
   * this endpoint, untick Wednesday, and be off every Wednesday from then on
   * with nobody told. The approval queue only ever guarded the polite door.
   *
   * So the pattern is now the employer's to set. A full-timer changes a single
   * day by requesting leave, and their contracted days move only when somebody
   * with `members:set_contracted_days` moves them.
   *
   * Refused HERE rather than in the route because the read-only screen is a
   * courtesy and this is the enforcement — a hand-written PUT reaches the
   * service either way.
   */
  async setWeeklySchedule(
    membershipId: string,
    schedule: SetAvailabilityInput[]
  ) {
    const membership = await this.membershipRepo.findById(membershipId);
    if (isFullTime(membership?.employmentType)) {
      throw new Error("Contracted days are set by your organisation");
    }

    const result = await this.writeWeeklySchedule(membershipId, schedule);

    /*
     * Recorded here rather than in `writeWeeklySchedule`.
     *
     * That helper is shared with `setContractedDaysForUser`, which already
     * raises `CONTRACTED_DAYS_SET` — logging in the shared path would write two
     * entries for one employer-set save and describe the admin's action as the
     * member's own. This is the branch where the member is the actor, and it is
     * the branch that had no record.
     *
     * ONE entry for the week, not one per day, for the same reason
     * `writeWeeklySchedule` runs the ineligibility check once: a member saves a
     * pattern, not seven patterns, and seven rows would bury every other event
     * in the log.
     *
     * The days are in the details because the entry has to answer the question
     * it exists for. "Availability changed" tells a reader something happened;
     * "Tuesday became unavailable" tells them why somebody stopped being
     * eligible for Tuesday's shift.
     *
     * Fire-and-forget and after the write, per the house rule — an audit
     * failure must not cost the member the save.
     */
    if (membership) {
      void this.auditService.log({
        organizationId: membership.organizationId,
        userId: membership.userId,
        action: ACTIONS.AVAILABILITY_UPDATED,
        entityType: "availability",
        entityId: membershipId,
        details: {
          days: schedule.map((d) => ({
            dayOfWeek: d.dayOfWeek,
            isAvailable: d.isAvailable,
            startTime: d.startTime,
            endTime: d.endTime,
          })),
        },
      });
    }

    return result;
  }

  /**
   * An admin setting somebody ELSE's contracted days.
   *
   * Reached by user id rather than membership id because that is what the
   * member drawer holds, matching `SeniorityService.setOverrideForUser` next
   * door.
   *
   * Applies to casual members too. Their pattern is normally theirs to give,
   * but a manager correcting a pattern a member cannot currently be bothered to
   * fix is a real situation, and refusing it here would mean the drawer's
   * behaviour changed depending on a field the person editing may not have
   * looked at. The audit entry records who did it either way.
   */
  /**
   * Another member's weekly pattern, for whoever may set it.
   *
   * `getWeeklySchedule` next door takes a membership id and answers for the
   * caller's own row; there was no way to READ somebody else's, which made the
   * setter unusable from a screen — an editor that cannot show the current
   * value can only overwrite it blind.
   *
   * Same resolution and same scope rules as the setter, so a caller who may not
   * write a member's pattern cannot read it either.
   */
  async getContractedDaysForUser(
    organizationId: string,
    userId: string,
    departmentScope?: string[] | null
  ) {
    const membership = await this.membershipRepo.findByUserAndOrgIncludingInactive(
      userId,
      organizationId
    );
    if (!membership) throw new Error("Member not found");
    if (!memberInScope(membership, departmentScope)) {
      throw new Error("Member not found");
    }
    return this.availRepo.getWeeklySchedule(membership.id);
  }

  async setContractedDaysForUser(
    organizationId: string,
    userId: string,
    schedule: SetAvailabilityInput[],
    actorUserId?: string,
    /**
     * The caller's departments, or null for a company admin. Admin-only by
     * default, but the permission is delegable through a custom role — and a
     * scoped manager must not be able to rewrite the contract of somebody in a
     * department they have nothing to do with. Out of scope reports as "not
     * found", the convention this codebase already uses so a caller cannot
     * probe for members they may not see.
     */
    departmentScope?: string[] | null
  ) {
    const membership = await this.membershipRepo.findByUserAndOrgIncludingInactive(
      userId,
      organizationId
    );
    if (!membership) throw new Error("Member not found");
    if (!memberInScope(membership, departmentScope)) {
      throw new Error("Member not found");
    }

    const results = await this.writeWeeklySchedule(membership.id, schedule);

    void this.auditService.log({
      organizationId,
      userId: actorUserId,
      action: ACTIONS.CONTRACTED_DAYS_SET,
      entityType: "member",
      entityId: membership.id,
      details: {
        days: schedule
          .filter((d) => d.isAvailable)
          .map((d) => ({ dayOfWeek: d.dayOfWeek, start: d.startTime, end: d.endTime })),
      },
    });

    return results;
  }

  /** Gets the weekly schedule for a member */
  async getWeeklySchedule(membershipId: string) {
    return this.availRepo.getWeeklySchedule(membershipId);
  }

  /**
   * Opens every day a member has said nothing about.
   *
   * ## Why a full-timer needs this at all
   *
   * `availableWithinDay` treats a MISSING day as unavailable — silence means
   * no. Combined with full-timers no longer setting their own pattern, a new
   * contracted member would be unrostearable on all seven days until somebody
   * went and filled the week in by hand. Not flexible: absent, and absent in a
   * way that looks like the engine failing to find anybody.
   *
   * ## Why open rather than Monday–Friday
   *
   * A full-timer is the person who covers the gap when a casual cannot. Seeding
   * them Mon–Fri would fence in the only people who are supposed to be
   * flexible, and the first Saturday somebody called in sick the engine would
   * report no candidates while a full-time employee sat at home willing to
   * come in. Narrowing is then a deliberate admin act for the person who
   * genuinely works weekdays only — visible, and undone as easily as it was
   * done.
   *
   * ## Why only the missing days
   *
   * A casual being converted has already said things about their week, and an
   * explicit "not Sundays" is an answer, not a gap. Overwriting it would use a
   * change of employment type to quietly discard what they told us. Days they
   * never mentioned open up; days they did are left exactly as they are.
   */
  async openUnsetDays(membershipId: string) {
    const existing = await this.availRepo.getWeeklySchedule(membershipId);
    const spokenFor = new Set(existing.map((row) => row.dayOfWeek));

    const created = [];
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      if (spokenFor.has(dayOfWeek)) continue;
      created.push(
        await this.availRepo.setDayAvailability({
          membershipId,
          dayOfWeek,
          startTime: "00:00",
          // Matches END_OF_DAY in the repository, which is what the overnight
          // split compares against. A different value here would make the
          // first half of a 22:00–02:00 shift fail on a day meant to be open.
          endTime: "23:59",
          isAvailable: true,
        })
      );
    }
    return created;
  }

  /**
   * Creates a date-specific override — or, for a full-time member, a leave
   * request.
   *
   * ## Two meanings, one row
   *
   * A CASUAL member's availability is an offer. They decide when they are
   * willing to work and the business fits around it, so an override of theirs
   * takes effect the moment they save it — the behaviour this method has always
   * had.
   *
   * A FULL-TIME member is contracted for their days. An absence is therefore
   * not something they declare, it is something they request: the row is
   * written `pending`, `isAvailableAt` ignores it, and it binds only once a
   * manager approves. Without that split a full-timer could remove themselves
   * from the roster unilaterally, which is precisely what a contract is not.
   *
   * The employment type is read from the membership rather than accepted from
   * the caller — a client that could name its own status would make the whole
   * distinction advisory.
   */
  async createOverride(
    membershipId: string,
    input: CreateAvailabilityOverrideInput
  ) {
    const membership = await this.membershipRepo.findById(membershipId);
    const needsApproval = isFullTime(membership?.employmentType);

    /*
     * A contracted member may ask for a day OFF, never to work one on.
     *
     * The two directions were symmetrical while both were requests, but they
     * are not the same kind of thing. Asking for time off is an exception to a
     * contract. Asking to work a day you are not contracted for is asking to
     * change the contract, and that belongs to whoever sets the contracted days
     * — not to a form the member fills in.
     *
     * Casual members keep both directions. Their availability is an offer, so
     * widening it and narrowing it are equally theirs to do.
     */
    if (needsApproval && input.isAvailable) {
      throw new Error("Contracted days are set by your organisation");
    }

    /*
     * A date already past cannot change anything.
     *
     * `isAvailableAt` is only ever asked about a shift being scheduled, so an
     * override for last Tuesday is read by nothing — and the form reported
     * success for it, which is the worst of both: no effect, and no way to tell
     * that from an effect. A full-timer could file leave for a day they had
     * already worked and watch it sit in the manager's queue.
     *
     * Compared on the ORGANISATION's calendar day, not the server's.
     * `overrideDateKey` is the same derivation the write and the read both use,
     * so "today" here means the same day the roster means — without it, a
     * request made at 07:00 in Singapore would be refused as yesterday's on a
     * UTC host.
     */
    if (isLapsedLeave(new Date(input.date))) {
      throw new Error("That date has already passed");
    }

    const created = await this.withIneligibilityCheck(membershipId, () =>
      this.availRepo.createOverride({
        membershipId,
        date: new Date(input.date),
        isAvailable: input.isAvailable,
        reason: input.reason,
        status: needsApproval ? "pending" : "approved",
      })
    );

    if (needsApproval) {
      void this.notifyReviewers(membershipId, created.date, input.isAvailable);
    }

    return created;
  }

  /**
   * Tells the people who can act on it that leave has been requested.
   *
   * Fire-and-forget, like every other notification in the codebase: a member
   * whose request was saved must not be told it failed because a notification
   * did.
   */
  private async notifyReviewers(
    membershipId: string,
    date: Date,
    isAvailable: boolean
  ) {
    try {
      const membership = await this.membershipRepo.findById(membershipId);
      if (!membership) return;

      const name = await this.availRepo.getMemberName(membershipId);
      const when = date.toLocaleDateString(SERVER_LOCALE, {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      });

      // Scoped to the requester's own departments, so the people told about a
      // request are exactly the people the route will let act on it.
      const withDepartments = await this.membershipRepo.findByIdWithDetails(
        membershipId
      );
      const departmentIds = (withDepartments?.departmentMemberships ?? []).map(
        (dm: { department: { id: string } }) => dm.department.id
      );

      const reviewers = await this.membershipRepo.findLeaveReviewers(
        membership.organizationId,
        departmentIds
      );

      await this.notificationService.notifyManyIfEnabled(
        membership.organizationId,
        reviewers.map((r) => r.userId).filter((id) => id !== membership.userId),
        NOTIFICATION_TYPES.LEAVE_REQUESTED,
        "Leave requested",
        `${name ?? "A team member"} requested ${
          isAvailable ? "to work" : "off"
        } on ${when}`,
        "availability",
        membershipId
      );
    } catch (error) {
      console.error("[Availability] Failed to notify reviewers:", error);
    }
  }

  /**
   * Approves, rejects or dismisses a leave request.
   *
   * Approving is the moment the absence becomes real, so it runs through the
   * same ineligibility check every other availability change does: a shift the
   * member already holds on that date now has nobody who can work it, and the
   * managers watching that task need to hear about it.
   *
   * Rejecting cannot make anyone ineligible — the row was inert while pending
   * and stays inert — so it skips the check rather than paying for a query
   * whose answer cannot change.
   *
   * ## Why "dismissed" exists, and why it is the ONLY verdict on a lapsed row
   *
   * A request whose date has passed cannot be granted or refused: the day
   * happened, and whatever the member did on it, they did. Approving one
   * released nothing — `releaseCommitments` reads only future shifts — but
   * still sent "Your request for Tue 21 Jul was approved", which is a
   * notification about an outcome that did not occur.
   *
   * So the two live verdicts are refused on a lapsed row and `dismissed` is
   * refused on a live one. Dismissing clears the queue, records who cleared it,
   * and tells the member nothing, because there is nothing true to tell them
   * beyond what their own screen already says.
   *
   * Enforced here rather than by hiding the buttons. The panel does hide them,
   * but a row lapses with the passage of time and not with a click: a queue
   * left open across midnight has live buttons over a request that is no longer
   * live, and the only place that can be authoritative is the one that reads
   * the row.
   */
  async reviewLeave(
    overrideId: string,
    decision: LeaveVerdict,
    reviewerUserId: string,
    /**
     * The organisation the reviewer is acting in.
     *
     * Proving the request belongs here used to happen in the ROUTE, which
     * reached `AvailabilityRepository` and `MembershipRepository` directly to
     * do it — Boundary touching Entity, which the architecture forbids for
     * exactly this reason: the check is a rule about who may review what, and a
     * rule living in one route is a rule the next route can forget.
     *
     * An id in a URL is a claim, not a fact.
     */
    organizationId: string,
    /**
     * The reviewer's departments, or null for a company admin. Without it a
     * Kitchen manager could approve Front of House leave by id — the class of
     * gap the 2026-08-05 audit found in four reporting surfaces.
     */
    departmentScope?: string[] | null
  ) {
    const override = await this.availRepo.getOverrideById(overrideId);
    if (!override) throw new Error("Leave request not found");

    // Out of the organisation and out of scope both answer "not found": naming
    // the difference would confirm a request exists on somebody the caller is
    // not allowed to see.
    const subject = await this.membershipRepo.findByIdWithDetails(
      override.membershipId
    );
    if (!subject || subject.organizationId !== organizationId) {
      throw new Error("Leave request not found");
    }
    if (!memberInScope(subject, departmentScope)) {
      throw new Error("Leave request not found");
    }

    /*
     * Nobody signs off their own leave.
     *
     * This is reachable only because a MANAGER can be full-time. Full-timers
     * must request time off; managers hold the permission to grant it; and a
     * manager reviewing their own request passes every other gate here — the
     * organisation matches, and they are trivially inside their own department
     * scope. So the request-and-approve flow collapsed into a formality with
     * extra steps for exactly the people senior enough to need watching.
     *
     * Refused rather than silently allowed, and it cannot deadlock: every
     * organisation has at least one company admin, because whoever created it
     * became one. A sole manager still has somebody to ask.
     *
     * Checked before the pending guard on purpose. "You cannot approve your own
     * request" is the more useful thing to be told, and it stays true whatever
     * state the row is in.
     */
    if (subject.userId === reviewerUserId) {
      throw new Error("You cannot review your own leave request");
    }

    if (override.status !== "pending") {
      throw new Error("This request has already been reviewed");
    }

    /*
     * Checked after the pending guard and before anything is written. Both
     * directions are refused: a verdict on a day that has gone, and a dismissal
     * of one still to come — the second would be a way to make a live request
     * disappear without answering it.
     */
    const lapsed = isLapsedLeave(override.date);
    if (lapsed && decision !== "dismissed") {
      throw new Error(
        "That date has already passed — this request can only be dismissed"
      );
    }
    if (!lapsed && decision === "dismissed") {
      throw new Error("A request for a future date must be approved or declined");
    }

    const apply = () =>
      this.availRepo.reviewOverride(overrideId, decision, reviewerUserId);

    /*
     * Approval RELEASES the shifts; rejection changes nothing.
     *
     * Deliberately not `withIneligibilityCheck`. That guard warns watchers that
     * an assigned member has become ineligible and leaves them assigned, which
     * was the right message while availability edits were the only thing that
     * could cause it. Approved leave is different in kind: the manager has just
     * agreed the person is not working, so leaving them on the shift makes the
     * roster claim cover it does not have, and "no longer eligible" describes a
     * state that only exists because nobody acted on it.
     */
    const result =
      decision === "approved"
        ? await this.releaseCommitments(override.membershipId, reviewerUserId, apply)
        : await apply();

    const membership = await this.membershipRepo.findById(override.membershipId);
    if (membership) {
      await this.auditService.log({
        organizationId: membership.organizationId,
        userId: reviewerUserId,
        action: LEAVE_AUDIT_ACTION[decision],
        entityType: "availability",
        entityId: overrideId,
        details: { date: override.date.toISOString(), membershipId: override.membershipId },
      });

      /*
       * Audited always, notified only for a real verdict.
       *
       * A dismissal is a fact about the QUEUE, not about the member's request —
       * nobody decided anything, and the day is gone. "Your request for 21 July
       * was dismissed" would be a message whose only honest content is that
       * their manager did not answer in time, delivered weeks late by a robot.
       * Their own screen already says the request lapsed. The audit entry is
       * where "who cleared this, and when" belongs.
       */
      if (decision !== "dismissed") {
        void this.notificationService.notifyIfEnabled(
          membership.organizationId,
          membership.userId,
          decision === "approved"
            ? NOTIFICATION_TYPES.LEAVE_APPROVED
            : NOTIFICATION_TYPES.LEAVE_REJECTED,
          decision === "approved" ? "Leave approved" : "Leave not approved",
          `Your request for ${override.date.toLocaleDateString(SERVER_LOCALE, {
            weekday: "short",
            day: "numeric",
            month: "short",
            timeZone: "UTC",
          })} was ${decision === "approved" ? "approved" : "declined"}.`,
          "availability",
          override.membershipId
        );
      }
    }

    return result;
  }

  /**
   * Pending leave from anyone, on the day(s) a task runs.
   *
   * ## Why the assign screen needs this
   *
   * You chose "leave binds on approval, but warn the manager first". The
   * binding half shipped in stage 1; without this the warning half did not
   * exist, so the behaviour was the option you did NOT pick — a manager could
   * roster somebody straight over a request nobody had answered, and the first
   * either party heard of it was when the leave was later approved and the
   * shift had to be unpicked.
   *
   * ## Two dates, not one
   *
   * A shift crossing midnight occupies two calendar days and somebody can have
   * booked off either of them. Derived here with the same `overrideDateKey`
   * the availability check uses, so the warning covers exactly the days the
   * eligibility engine would have consulted.
   */
  async getPendingLeaveForTask(
    taskId: string,
    organizationId: string,
    /**
     * The caller's departments, or null for a company admin.
     *
     * This passed a hardcoded `null` — unrestricted — while its two siblings on
     * the same panel (`checkEligibilityForTask`, `describeForTask`) both narrow
     * to the task's population. The rows carry a free-text `reason`, so a
     * Kitchen manager opening a Kitchen shift was reading why Front-of-House
     * staff had asked for time off.
     */
    departmentScope?: string[] | null
  ) {
    const task = await this.taskRepo.findByIdWithoutRelations(taskId);
    if (!task || task.organizationId !== organizationId) {
      throw new Error("Task not found");
    }
    if (!task.scheduledStart || !task.scheduledEnd) return [];

    const dates = [overrideDateKey(task.scheduledStart)];
    const endKey = overrideDateKey(task.scheduledEnd);
    // Compared by time value: two Date objects for the same day are not equal
    // by identity, and a same-day shift would otherwise query its own date
    // twice.
    if (endKey.getTime() !== dates[0].getTime()) dates.push(endKey);

    const members = await this.membershipRepo.findRosterableInScope(
      organizationId,
      departmentScope ?? null
    );

    return this.availRepo.findPendingOnDates(
      members.map((m) => m.id),
      dates
    );
  }

  /**
   * The leave register: every request that ever went through review, filtered.
   *
   * ## Why the department filter narrows the MEMBERS and not the query
   *
   * A reviewer's scope and the department they picked from a dropdown are two
   * different things, and the second must never replace the first. Resolving
   * both into one list of membership ids — before the repository is called —
   * makes that structural: the repository takes ids and has no concept of a
   * department, so asking for one outside your scope resolves to nobody and
   * returns nothing. There is no ordering of these two steps that leaks.
   *
   * This is the shape the 2026-08-05 audit asked for. The four surfaces it
   * found had taken a department id from the query string and used it AS the
   * scope, which is the same code with the two steps collapsed.
   *
   * ## Why `awaiting` is counted separately every time
   *
   * `awaiting` answers the sidebar badge, and the badge is about the reader's
   * whole scope — not about whatever the page is filtered to. Reading it off
   * this page's `total` would make the badge fall to zero when a manager
   * switched the filter to "Approved", which is lying in the most reassuring
   * direction available.
   */
  async getLeaveRegister(
    organizationId: string,
    /** The reviewer's departments, or null for a company admin. */
    departmentScope: string[] | null | undefined,
    filters: {
      view?: LeaveView;
      /** One department, which must lie inside `departmentScope`. */
      departmentId?: string | null;
      from?: string | null;
      to?: string | null;
      search?: string | null;
      page?: number;
    } = {}
  ) {
    const view = filters.view ?? DEFAULT_LEAVE_VIEW;
    const scope = departmentScope ?? null;

    /*
     * Refused, not ignored, and refused HERE rather than only in the browser.
     *
     * A reversed range matches nothing, so applying it would return an empty
     * page — and an empty page reads as "there is no leave in August", not as
     * "you have asked an impossible question". The screen blocks it too; this
     * is the half that survives a hand-written URL, and the reason the message
     * comes from the same table the screen shows.
     */
    const range = parseDateRange(filters.from, filters.to);
    if (range.problem) throw new Error(DATE_RANGE_MESSAGE[range.problem]);

    /*
     * The intersection. `null` scope means unrestricted, so a chosen department
     * simply becomes the scope; a restricted reader asking for a department
     * they do not hold resolves to an empty list rather than an error, because
     * telling them the difference would confirm the department exists.
     */
    const requested = filters.departmentId?.trim() || null;
    const effective =
      requested === null
        ? scope
        : scope !== null && !scope.includes(requested)
          ? []
          : [requested];

    const [members, everyoneInScope] = await Promise.all([
      this.membershipRepo.findRosterableInScope(organizationId, effective),
      // The badge's population is the reader's whole scope, not the filtered
      // one. Skipped entirely when they are the same query.
      requested === null
        ? Promise.resolve(null)
        : this.membershipRepo.findRosterableInScope(organizationId, scope),
    ]);

    const memberIds = members.map((m) => m.id);
    const scopeIds = (everyoneInScope ?? members).map((m) => m.id);

    const now = new Date();
    const todayKey = overrideDateKey(now);
    const page = Math.max(1, Math.floor(filters.page ?? 1));

    const [{ rows, total }, counts, closingSoon] = await Promise.all([
      this.availRepo.findLeaveRegister({
        membershipIds: memberIds,
        view,
        todayKey,
        from: range.from ? overrideDateKey(new Date(range.from)) : null,
        to: range.to ? overrideDateKey(new Date(range.to)) : null,
        search: filters.search ?? null,
        order: leaveOrderFor(view),
        take: LEAVE_PAGE_SIZE,
        skip: (page - 1) * LEAVE_PAGE_SIZE,
      }),
      /*
       * The tiles, over the reader's WHOLE scope — never the current filter.
       *
       * They are the standing picture of what this reader is responsible for.
       * Recomputing them against the filter would make "Lapsed: 3" fall to zero
       * the moment somebody searched for a name, and the Awaiting tile has to
       * agree with the sidebar badge, which cannot see the filter at all.
       *
       * Lapsed earns a tile rather than a chip because it is invisible by
       * nature: nobody goes looking for a filter they do not know has anything
       * behind it, and requests accumulating unseen is the whole defect this
       * page was rebuilt to answer.
       */
      this.availRepo.countLeaveViews(scopeIds, todayKey, LEAVE_TILE_VIEWS),
      /*
       * How many of the waiting ones are running out of time.
       *
       * Not a fifth tile — it is a SUBSET of Awaiting, and a tile row whose
       * numbers overlap invites adding them up. It becomes the Awaiting tile's
       * detail line instead, where "3 closing soon" replaces a caption that
       * only ever said the same thing as the label above it.
       */
      this.availRepo.countClosingSoon(scopeIds, chaseBoundaries(now)),
    ]);

    return {
      rows: rows.map((row) => ({
        ...row,
        lapsed: isLapsedLeave(row.date, now),
        /*
         * Says the request is running out of time — NOT that anybody has been
         * told. A row must not stop looking urgent the moment a reminder goes
         * out; that is exactly backwards, and it is why this is `isClosingSoon`
         * rather than `chaseStageFor`.
         */
        closingSoon: !isLapsedLeave(row.date, now) && isClosingSoon(row, now),
        /*
         * Flattened here rather than in the page. A member can hold several
         * departments, and every screen that has had to unwrap
         * `departmentMemberships` itself has done it slightly differently.
         */
        departments: row.membership.departmentMemberships.map(
          (dm) => dm.department
        ),
      })),
      total,
      page,
      pageSize: LEAVE_PAGE_SIZE,
      /** Waiting, and running out of time. A subset of `counts.awaiting`. */
      closingSoon,
      /**
       * The tile figures, keyed by view. `counts.awaiting` is also what the
       * sidebar badge reads, so the number on the page and the number in the
       * nav are one query rather than two that agree by luck.
       */
      counts,
    };
  }

  /**
   * The scheduled sweep: chase what is running out of time, and tell the member
   * about anything that ran out.
   *
   * ## Why chasing is worth building at all
   *
   * A lapsed request is a failure — a member asked for a day, nobody answered,
   * and the day came anyway. Marking it lapsed after the fact is honest but
   * useless to them. This is the half that tries to stop it.
   *
   * ## Two passes, deliberately narrowing rather than repeating
   *
   * The first goes to the people who can decide it: the requester's own
   * department managers, and the admins above them. The second, a day later,
   * goes to the ADMINS ONLY, and says the reviewers have not answered. That is
   * the "escalate to HR" shape the HR literature settles on rather than
   * auto-approving — a missed deadline becomes a nudge, never an accidental
   * yes. Approving here removes somebody from a roster and starts a search for
   * cover, so nothing about it may happen by default.
   *
   * `findLeaveReviewers(orgId, [])` is admins-only by construction: an empty
   * department list matches no manager, which is the same `[]` vs `null`
   * distinction `departmentScopeFor` turns on everywhere else.
   *
   * After the second there is no third. `escalatedAt` is terminal, so a
   * request nobody ever answers is chased exactly twice — a rule that re-sent
   * on a cooldown would teach every manager to filter the sender.
   *
   * ## Fire-and-forget per row, like everything else here
   *
   * One organisation's failure must not stop the sweep, and a notification that
   * cannot be sent must not leave the row looking un-chased forever — so the
   * mark is written whatever the notification did, and the error is logged.
   */
  async sweepPendingLeave(
    organizationId: string,
    now: Date = new Date(),
    horizonDays: number = DEFAULT_HORIZON_DAYS
  ): Promise<{ reminded: number; escalated: number; lapseNotified: number }> {
    let reminded = 0;
    let escalated = 0;

    const boundaries = chaseBoundaries(now, horizonDays);
    const chaseable = await this.availRepo.findChaseable(
      organizationId,
      boundaries
    );

    for (const row of chaseable) {
      const stage = chaseStageFor(row, now, horizonDays);
      if (stage === "none") continue;

      const departmentIds = row.membership.departmentMemberships.map(
        (dm) => dm.departmentId
      );
      const audience = await this.membershipRepo.findLeaveReviewers(
        organizationId,
        stage === "escalate" ? [] : departmentIds
      );
      const name = row.membership.user.name || row.membership.user.email;
      const when = row.date.toLocaleDateString(SERVER_LOCALE, {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      });

      try {
        await this.notificationService.notifyManyIfEnabled(
          organizationId,
          // Never to the requester. They know; and a full-time MANAGER can be
          // both, which is the same overlap `reviewLeave` refuses.
          audience
            .map((r) => r.userId)
            .filter((id) => id !== row.membership.userId),
          NOTIFICATION_TYPES.LEAVE_REMINDER,
          stage === "escalate"
            ? "Leave request still unanswered"
            : "Leave request needs a decision",
          stage === "escalate"
            ? `${name} asked for ${when} off and nobody has answered. It was already flagged to their managers.`
            : `${name} asked for ${when} off and is still waiting.`,
          "availability",
          row.membership.id
        );
      } catch (error) {
        console.error("[Leave Sweep] reminder failed", error);
      }

      // Marked regardless. A row left un-marked because a notification failed
      // would be picked up on every subsequent run, forever.
      await this.availRepo.markChased(row.id, stage, now);
      if (stage === "escalate") escalated++;
      else reminded++;
    }

    const lapseNotified = await this.notifyLapsed(organizationId, now);
    return { reminded, escalated, lapseNotified };
  }

  /**
   * Tells the member that the day arrived and nobody answered.
   *
   * Not phrased as a decision, because none was made. The alternative was the
   * silence that shipped first: their own screen said "awaiting approval"
   * indefinitely, and nothing ever told them otherwise — so the person with the
   * most reason to chase it was the only one not informed.
   *
   * It does NOT dismiss the request. Clearing it would hide from the reviewer
   * that they dropped one, and the register's Dismiss exists so that closing it
   * is somebody's deliberate act rather than a side effect of a cron job.
   */
  private async notifyLapsed(organizationId: string, now: Date) {
    const todayKey = overrideDateKey(now);
    const lapsed = await this.availRepo.findNewlyLapsed(
      organizationId,
      todayKey
    );

    let sent = 0;
    for (const row of lapsed) {
      const when = row.date.toLocaleDateString(SERVER_LOCALE, {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      });
      try {
        await this.notificationService.notifyIfEnabled(
          organizationId,
          row.membership.userId,
          NOTIFICATION_TYPES.LEAVE_LAPSED,
          "Your leave request was never answered",
          `Nobody answered your request for ${when} before the day arrived. It has not been approved — ask again if you still need the time.`,
          "availability",
          row.membership.id
        );
      } catch (error) {
        console.error("[Leave Sweep] lapse notice failed", error);
      }
      await this.availRepo.markLapseNotified(row.id, now);
      sent++;
    }
    return sent;
  }

  /**
   * Clears every lapsed request the caller may act on, in one go.
   *
   * ## Why it loops through `reviewLeave` rather than issuing one UPDATE
   *
   * A bulk `updateMany` would be one query and would skip every rule: the
   * self-review refusal, the department scope, the pending check, the lapsed
   * check, and the audit entry per row. Those are not incidental — a manager
   * who is themselves full-time can have a lapsed request of their own sitting
   * in their own queue, and "dismiss everything" must not become the one door
   * through which they sign off their own leave.
   *
   * So the rules stay in one place and this pays for them. A tidy-up of a
   * handful of rows is not a hot path, and the alternative is a second
   * implementation of five guards that would drift from the first.
   *
   * ## Why a failure skips rather than aborts
   *
   * One unreachable row must not strand the other nine. Anything refused is
   * counted and reported, so the screen can say what it could not do instead of
   * claiming a clean sweep — a bulk action that silently does 9 of 10 is worse
   * than one that does none.
   */
  async dismissLapsedLeave(
    organizationId: string,
    reviewerUserId: string,
    departmentScope?: string[] | null
  ): Promise<{ dismissed: number; skipped: number }> {
    const members = await this.membershipRepo.findRosterableInScope(
      organizationId,
      departmentScope ?? null
    );
    const todayKey = overrideDateKey(new Date());
    const membershipIds = members.map((m) => m.id);

    let dismissed = 0;
    let skipped = 0;

    /*
     * Batched until there is nothing left, rather than one page and a full stop.
     *
     * The first version read `take: LEAVE_PAGE_SIZE, skip: 0` once — so a button
     * reading "Dismiss all 60" cleared fifty and reported fifty, and the
     * remaining ten came back on the next load with no explanation. A silent
     * cap, in the one place this codebase has repeatedly argued not to put one.
     *
     * `skip: skipped` is the whole trick. A dismissed row leaves the lapsed
     * view, so it is not there to page past; a REFUSED one stays, and offsetting
     * by the number refused so far steps over exactly those and nothing else.
     *
     * The loop terminates because a pass that dismisses nothing breaks out. Some
     * refusals are permanent — a manager's own request can never be dismissed by
     * them — so "keep going while rows remain" would spin forever on a queue
     * containing only those.
     */
    for (;;) {
      const { rows } = await this.availRepo.findLeaveRegister({
        membershipIds,
        view: "lapsed",
        todayKey,
        order: "asc",
        take: LEAVE_PAGE_SIZE,
        skip: skipped,
      });
      if (rows.length === 0) break;

      let progressed = false;
      for (const row of rows) {
        try {
          await this.reviewLeave(
            row.id,
            "dismissed",
            reviewerUserId,
            organizationId,
            departmentScope
          );
          dismissed++;
          progressed = true;
        } catch {
          // Their own request, or one that stopped being lapsed between the read
          // and the write. Both are correct refusals; neither should stop the
          // rest.
          skipped++;
        }
      }

      if (!progressed) break;
    }

    return { dismissed, skipped };
  }

  /**
   * A member's own overrides, each marked with whether its date has passed.
   *
   * The member's screen showed "Awaiting approval" against a day three weeks
   * gone, indistinguishable from one next Tuesday, so the person with the most
   * reason to chase it had no way to know it needed chasing. Same flag and same
   * derivation as the reviewer's queue — the two sides of this disagreeing is
   * the failure mode worth designing against.
   */
  async getOverrides(membershipId: string, startDate?: Date, endDate?: Date) {
    const rows = await this.availRepo.getOverrides(
      membershipId,
      startDate,
      endDate
    );
    const now = new Date();
    return rows.map((row) => ({ ...row, lapsed: isLapsedLeave(row.date, now) }));
  }

  /**
   * Deletes a date override.
   *
   * Also guarded. Deleting an override is not obviously a restriction — it
   * usually widens availability — but removing an "I CAN work the 14th"
   * override narrows it, and that reaches the roster exactly like any other
   * change.
   */
  async deleteOverride(
    overrideId: string,
    /**
     * The membership the override must belong to.
     *
     * Was checked in the route, which read `AvailabilityRepository` directly to
     * do it. Optional so the existing internal callers are unaffected; when
     * given, a mismatch reports "not found" rather than "forbidden", since
     * distinguishing them would confirm an override exists on a membership the
     * caller cannot see.
     */
    ownerMembershipId?: string
  ) {
    const override = await this.availRepo.getOverrideById(overrideId);
    if (!override) {
      // A caller who named an owner is asserting the row is theirs. Nothing
      // there is a failed assertion, not a no-op to swallow.
      if (ownerMembershipId) throw new Error("Override not found");
      return this.availRepo.deleteOverride(overrideId);
    }
    if (ownerMembershipId && override.membershipId !== ownerMembershipId) {
      throw new Error("Override not found");
    }

    /*
     * A member may withdraw a request, not undo a decision.
     *
     * This checked nothing but ownership, so somebody could delete leave a
     * manager had GRANTED, with nothing telling the manager who granted it. It
     * fails in the safe direction — removing approved leave only ever makes
     * them more available — but a decision could still be erased by the person
     * it was made for.
     *
     * ## Why `reviewedById` and not `status === "approved"`
     *
     * The first version tested the status and was wrong, which the suite caught
     * immediately: a CASUAL member's override is written `approved` the moment
     * they save it, because their availability is an offer that binds at once.
     * Testing the status would have locked every casual out of their own date
     * overrides — taking back an offer is precisely what that endpoint is for.
     *
     * `reviewedById` is the fact that actually matters: somebody else made a
     * decision on this row. It is null on every auto-approved casual override
     * and set only when a manager answered a request.
     *
     * Scoped to the SELF path: `ownerMembershipId` is supplied only when a
     * member is deleting their own row. The internal callers that pass nothing
     * are cleanup paths that must stay unconditional.
     */
    if (ownerMembershipId && override.reviewedById) {
      throw new Error(
        "Approved leave can only be changed by a manager — ask them to reverse it."
      );
    }

    return this.withIneligibilityCheck(override.membershipId, () =>
      this.availRepo.deleteOverride(overrideId)
    );
  }

  /** Checks if a member is available at a specific date and time */
  async checkAvailability(
    membershipId: string,
    date: Date,
    startTime: string,
    endTime: string
  ) {
    return this.availRepo.isAvailableAt(membershipId, date, startTime, endTime);
  }

  /* ---------------------------------------------------------------- */
  /*  Ineligibility guard                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Runs an availability change, then tells the right people if it has left
   * someone booked onto a shift they no longer fit.
   *
   * ## Why the check happens twice
   *
   * Once BEFORE the write and once after, comparing the two. Only assignments
   * that were fine and are now not produce an alert.
   *
   * The alternative — alerting on everything currently ineligible — sounds
   * equivalent and is not. Someone who is already flagged for a shift, then
   * corrects a typo in an unrelated day's hours, would generate a fresh alert
   * about a problem the manager already knows about. Do that a few times and
   * managers learn to ignore the notification, which costs more than the
   * feature is worth.
   *
   * ## Why it never throws
   *
   * The staff member's own action must succeed regardless. If the check fails,
   * their availability is still saved and the error goes to the console — the
   * same rule the audit log follows. A person should not be told "could not
   * save" because a notification to somebody else broke.
   *
   * ## What it does not do
   *
   * It does not unassign anyone. The manager may have already recorded an
   * eligibility override, may need a replacement lined up first, or may simply
   * want a conversation. A roster that silently drops people is worse than one
   * that says something needs looking at.
   */
  private async withIneligibilityCheck<T>(
    membershipId: string,
    write: () => Promise<T>
  ): Promise<T> {
    let before: Set<string>;
    try {
      before = await this.ineligibleUpcomingTaskIds(membershipId);
    } catch (error) {
      // Could not establish a baseline, so a comparison afterwards would be
      // meaningless — and alerting on everything would be the noisy behaviour
      // this exists to avoid. Save, stay quiet.
      console.error("[Availability Check Error] baseline failed", error);
      return write();
    }

    const result = await write();

    try {
      await this.notifyNewlyIneligible(membershipId, before);
    } catch (error) {
      console.error("[Availability Check Error]", error);
    }

    return result;
  }

  /**
   * Applies the approval, then takes the member off everything it just made
   * them ineligible for — and starts the search for cover.
   *
   * Mirrors `withIneligibilityCheck`'s before/after shape on purpose: only
   * shifts that were fine BEFORE and are not fine after are touched. A member
   * already ineligible for Thursday for some unrelated reason is not swept up
   * by approving Friday's leave.
   *
   * Everything after the write is wrapped. A leave decision the manager has
   * made and the member has been told about must not fail because the roster
   * tidy-up did — the shift being left covered is a problem, an approval that
   * throws after writing is a worse one.
   */
  private async releaseCommitments<T>(
    membershipId: string,
    reviewerUserId: string,
    write: () => Promise<T>
  ): Promise<T> {
    let before: Set<string>;
    try {
      before = await this.ineligibleUpcomingTaskIds(membershipId);
    } catch (error) {
      console.error("[Leave Release Error] baseline failed", error);
      return write();
    }

    const result = await write();

    try {
      const commitments = await this.upcomingCommitments(membershipId);
      const after = await this.ineligibleUpcomingTaskIds(membershipId);
      const released = commitments.filter(
        (c) => after.has(c.taskId) && !before.has(c.taskId)
      );
      if (released.length === 0) return result;

      const absentName = await this.memberName(membershipId);
      const { TaskService } = await import("@/services/task.service");
      const taskService = new TaskService();

      for (const commitment of released) {
        await taskService.cancelAssignment(
          commitment.assignmentId,
          commitment.organizationId,
          reviewerUserId,
          // The generic smart-swap message does not know this was leave, nor
          // what the org's allocation mode says to do about it. Ours does.
          { suppressSuggestion: true }
        );
        await this.findCover(commitment, absentName, reviewerUserId);
      }
    } catch (error) {
      console.error("[Leave Release Error]", error);
    }

    return result;
  }

  /**
   * Decides what happens to a shift somebody has just been released from.
   *
   * Reads the organisation's existing `allocationMode` rather than introducing
   * a setting of its own — an org that has said it wants the engine to assign
   * has already answered this question, and asking it twice in two vocabularies
   * is how two settings come to contradict each other.
   *
   * ## Why this is public, and why it still lives here
   *
   * It is called from `TaskAssignmentService` too, because an approved decline
   * and an approved withdrawal are the same event as an approved leave — a
   * person has come off a shift — and for a year only one of the three did
   * anything about it.
   *
   * It belongs in a service of its own, and `shift-cover.service.ts` is the
   * honest home for it. It has not moved yet, deliberately: the extraction is
   * ~120 lines with five collaborators, the leave path around it is the most
   * heavily tested flow in this file, and the change that needed making was
   * "call it from two more places", not "move it". Moving it is a follow-up
   * with no behaviour in it — which is exactly the kind of change that should
   * not be bundled with one that has.
   *
   * The exclusion question resolves itself, and only because of a change made
   * at the same time. `buildCandidatePool` excludes anyone holding a row on the
   * shift, so a member whose withdrawal was just approved is not offered it
   * back — but ONLY while an approved withdrawal keeps its row, which it did
   * not until `TaskAssignmentRepository.withdraw` replaced `cancel`. The leave
   * path never needed that protection because approved leave makes the person
   * unavailable and eligibility refuses them on their own merits. Two paths,
   * two different mechanisms, one outcome; `tests/services/shift-cover.test.ts`
   * pins it for both rather than trusting the coincidence.
   */
  async findCover(
    commitment: Commitment,
    absentName: string,
    reviewerUserId: string
  ) {
    const watchers = await taskWatcherUserIds(
      commitment.organizationId,
      commitment.departmentId
    );
    const tell = (type: string, title: string, body: string) =>
      watchers.length > 0
        ? this.notificationService.notifyManyIfEnabled(
            commitment.organizationId,
            watchers,
            type,
            title,
            body,
            "task",
            commitment.taskId
          )
        : Promise.resolve();

    /*
     * Short notice overrides the mode entirely.
     *
     * Filling tomorrow morning's shift is a phone call, and no automation is a
     * substitute for one. Quietly sending an offer that may sit unread until
     * after the shift has started would look like the system had handled it.
     */
    if (this.isShortNotice(commitment.scheduledStart)) {
      await tell(
        NOTIFICATION_TYPES.BACKFILL_NEEDED,
        "Urgent — shift needs cover",
        `${absentName}'s leave was approved and they have come off "${commitment.taskTitle}", which starts soon. Too close to fill automatically — please arrange cover directly.`
      );
      return;
    }

    const settings = await this.settingsRepo.getOrCreate(commitment.organizationId);

    if (settings.allocationMode === "manual") {
      await tell(
        NOTIFICATION_TYPES.BACKFILL_NEEDED,
        "Shift needs cover",
        `${absentName}'s leave was approved and they have come off "${commitment.taskTitle}".`
      );
      return;
    }

    // Algorithmic, never the AI providers: this runs off the back of somebody
    // else's decision, so the org does not control how often it happens.
    const { AllocationService } = await import("@/services/allocation.service");
    const { rankings } = await new AllocationService().rankWithoutAI(
      commitment.taskId,
      commitment.organizationId
    );

    if (rankings.length === 0) {
      await tell(
        NOTIFICATION_TYPES.BACKFILL_NEEDED,
        "Shift needs cover — nobody available",
        `${absentName}'s leave was approved and they have come off "${commitment.taskTitle}". No eligible replacement was found.`
      );
      return;
    }

    if (settings.allocationMode === "suggested") {
      const names = (
        await Promise.all(
          rankings.slice(0, 3).map((r) => this.memberName(r.membershipId))
        )
      ).join(", ");
      await tell(
        NOTIFICATION_TYPES.BACKFILL_NEEDED,
        "Shift needs cover — replacements suggested",
        `${absentName}'s leave was approved and they have come off "${commitment.taskTitle}". Best fit: ${names}.`
      );
      return;
    }

    // "auto" — the engine finds the person, but the person still chooses.
    const pick = rankings[0];
    const { TaskService } = await import("@/services/task.service");
    await new TaskService().assignStaff(
      commitment.taskId,
      commitment.organizationId,
      [pick.membershipId],
      reviewerUserId,
      {
        // Matches what `autoAllocate` records for the same shape of decision —
        // the engine's top-ranked candidate for a single task. The provider
        // says which engine, and here it is always the algorithmic one.
        source: "ai_suggested",
        provider: "algorithmic",
        byMembership: { [pick.membershipId]: { rank: 1, score: pick.score } },
      },
      { asOffer: true }
    );

    const pickName = await this.memberName(pick.membershipId);
    const replacement = await this.membershipRepo.findById(pick.membershipId);
    if (replacement) {
      void this.notificationService.notifyIfEnabled(
        commitment.organizationId,
        replacement.userId,
        NOTIFICATION_TYPES.BACKFILL_OFFERED,
        "Shift offered to you",
        `Cover needed on "${commitment.taskTitle}". Accept or decline — you are not booked in until you accept.`,
        "assignment",
        commitment.taskId
      );
    }

    await tell(
      NOTIFICATION_TYPES.BACKFILL_OFFERED,
      "Cover offered — not yet confirmed",
      `${absentName} has come off "${commitment.taskTitle}". ${pickName} has been offered it and has not answered yet.`
    );
  }

  /**
   * Is this shift too close to hand to automation?
   *
   * A shift with no start time is NOT short notice: an undated task is a
   * backlog item nobody is standing up for at 6am, and treating it as urgent
   * would route every one of them to a manager as an emergency.
   */
  private isShortNotice(scheduledStart: Date | null): boolean {
    if (!scheduledStart) return false;
    const hoursAway = (scheduledStart.getTime() - Date.now()) / 3_600_000;
    return hoursAway < SHORT_NOTICE_HOURS;
  }

  /** Upcoming shifts this member is booked on but no longer eligible for. */
  private async ineligibleUpcomingTaskIds(
    membershipId: string
  ): Promise<Set<string>> {
    const commitments = await this.upcomingCommitments(membershipId);
    const ineligible = new Set<string>();

    for (const commitment of commitments) {
      const eligibility = await this.eligibilityService.checkEligibilityForTask(
        commitment.taskId,
        commitment.organizationId
      );
      const own = eligibility.find((e) => e.membershipId === membershipId);
      // A member absent from the list is not eligible-by-omission: they may
      // have been filtered out by the task's department. Treated as "no
      // finding" rather than as a problem, because inventing one would alert
      // on every save.
      if (own && !own.eligible) ineligible.add(commitment.taskId);
    }

    return ineligible;
  }

  private async upcomingCommitments(
    membershipId: string
  ): Promise<Commitment[]> {
    const rows = await this.assignmentRepo.findUpcomingCommitments(
      membershipId,
      new Date()
    );

    return rows.map((row) => ({
      assignmentId: row.id,
      taskId: row.task.id,
      taskTitle: row.task.title,
      organizationId: row.task.organizationId,
      departmentId: row.task.departmentId,
      scheduledStart: row.task.scheduledStart,
    }));
  }

  private async notifyNewlyIneligible(membershipId: string, before: Set<string>) {
    const commitments = await this.upcomingCommitments(membershipId);
    if (commitments.length === 0) return;

    const after = await this.ineligibleUpcomingTaskIds(membershipId);
    const newlyIneligible = commitments.filter(
      (c) => after.has(c.taskId) && !before.has(c.taskId)
    );
    if (newlyIneligible.length === 0) return;

    const memberName = await this.memberName(membershipId);

    // One notification per shift, not one listing all of them. Each carries a
    // different task id, and the notification's entity link is what makes it
    // actionable — a combined message could only link to one of them.
    for (const commitment of newlyIneligible) {
      const watchers = await taskWatcherUserIds(
        commitment.organizationId,
        commitment.departmentId
      );
      if (watchers.length === 0) continue;

      await this.notificationService.notifyManyIfEnabled(
        commitment.organizationId,
        watchers,
        NOTIFICATION_TYPES.STAFF_INELIGIBLE,
        "Assigned staff no longer eligible",
        `${memberName} updated their availability and is no longer eligible for "${commitment.taskTitle}".`,
        "task",
        commitment.taskId
      );
    }
  }

  private async memberName(membershipId: string): Promise<string> {
    const commitment = await this.availRepo.getMemberName(membershipId);
    return commitment ?? "A staff member";
  }
}
