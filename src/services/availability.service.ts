/**
 * Availability Service (Control Layer)
 * 
 * Business logic for managing staff availability schedules.
 * Supports weekly recurring patterns and date-specific overrides.
 * 
 * Used by the eligibility engine to check if staff can work
 * at a specific date/time before assignment.
 */
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { EligibilityService } from "@/services/eligibility.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { MembershipRepository } from "@/repositories/membership.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { taskWatcherUserIds } from "@/services/task-watchers";
import { isFullTime } from "@/lib/role-config";
import type {
  SetAvailabilityInput,
  CreateAvailabilityOverrideInput,
} from "@/lib/validations";

/** A shift the member is still expected to work. */
interface Commitment {
  taskId: string;
  taskTitle: string;
  organizationId: string;
  departmentId: string | null;
  scheduledStart: Date | null;
}

export class AvailabilityService {
  private availRepo = new AvailabilityRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private eligibilityService = new EligibilityService();
  private notificationService = new NotificationService();
  private membershipRepo = new MembershipRepository();
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
      entityType: "membership",
      entityId: membership.id,
    });

    return { requested: true };
  }

  /** Sets availability for a single day of the week */
  async setDayAvailability(membershipId: string, input: SetAvailabilityInput) {
    if (input.isAvailable && input.startTime >= input.endTime) {
      throw new Error("End time must be after start time");
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
   * Sets the full weekly schedule (bulk upsert).
   *
   * Wrapped in the ineligibility guard as ONE unit, not per day. Hooking
   * `setDayAvailability` instead would run the check seven times for a single
   * save and could fire an alert off a half-applied week — Monday saved,
   * Tuesday not yet — describing a state that never existed.
   */
  async setWeeklySchedule(
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

  /** Gets the weekly schedule for a member */
  async getWeeklySchedule(membershipId: string) {
    return this.availRepo.getWeeklySchedule(membershipId);
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
    reviewerUserId: string
  ) {
    const override = await this.availRepo.getOverrideById(overrideId);
    if (!override) throw new Error("Leave request not found");
    if (override.status !== "pending") {
      throw new Error("This request has already been reviewed");
    }

    const apply = () =>
      this.availRepo.reviewOverride(overrideId, decision, reviewerUserId);

    const result =
      decision === "approved"
        ? await this.withIneligibilityCheck(override.membershipId, apply)
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
  async deleteOverride(overrideId: string) {
    const override = await this.availRepo.getOverrideById(overrideId);
    if (!override) return this.availRepo.deleteOverride(overrideId);

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
