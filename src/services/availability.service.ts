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
  overrideDateKey,
} from "@/repositories/availability.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { EligibilityService } from "@/services/eligibility.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { MembershipRepository } from "@/repositories/membership.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { taskWatcherUserIds } from "@/services/task-watchers";
import { isFullTime } from "@/lib/role-config";
import { memberInScope } from "@/lib/department-scope";
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

    await this.notificationService.notify(
      organizationId,
      targetUserId,
      NOTIFICATION_TYPES.AVAILABILITY_REVIEW_REQUESTED,
      "Please review your availability",
      `${requestedByName} asked you to check your weekly availability is still right.`,
      "availability",
      membership.id
    );

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
    return this.writeWeeklySchedule(membershipId, schedule);
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
    const requested = overrideDateKey(new Date(input.date));
    if (requested < overrideDateKey(new Date())) {
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
      const when = date.toLocaleDateString("en-GB", {
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
   * Approves or rejects a leave request.
   *
   * Approving is the moment the absence becomes real, so it runs through the
   * same ineligibility check every other availability change does: a shift the
   * member already holds on that date now has nobody who can work it, and the
   * managers watching that task need to hear about it.
   *
   * Rejecting cannot make anyone ineligible — the row was inert while pending
   * and stays inert — so it skips the check rather than paying for a query
   * whose answer cannot change.
   */
  async reviewLeave(
    overrideId: string,
    decision: "approved" | "rejected",
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
        action:
          decision === "approved"
            ? ACTIONS.LEAVE_APPROVED
            : ACTIONS.LEAVE_REJECTED,
        entityType: "availability",
        entityId: overrideId,
        details: { date: override.date.toISOString(), membershipId: override.membershipId },
      });

      void this.notificationService.notifyIfEnabled(
        membership.organizationId,
        membership.userId,
        decision === "approved"
          ? NOTIFICATION_TYPES.LEAVE_APPROVED
          : NOTIFICATION_TYPES.LEAVE_REJECTED,
        decision === "approved" ? "Leave approved" : "Leave not approved",
        `Your request for ${override.date.toLocaleDateString("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        })} was ${decision === "approved" ? "approved" : "declined"}.`,
        "availability",
        override.membershipId
      );
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

  /** Leave awaiting a decision, within the reviewer's scope. */
  async getPendingLeave(organizationId: string, departmentIds?: string[] | null) {
    const members = await this.membershipRepo.findRosterableInScope(
      organizationId,
      departmentIds
    );
    return this.availRepo.findPendingForMembers(members.map((m) => m.id));
  }

  /** Gets overrides for a member, optionally within a date range */
  async getOverrides(membershipId: string, startDate?: Date, endDate?: Date) {
    return this.availRepo.getOverrides(membershipId, startDate, endDate);
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
   */
  private async findCover(
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
