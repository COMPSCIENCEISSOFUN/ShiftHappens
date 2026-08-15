/**
 * TaskAssignment Service (Control Layer)
 *
 * Business logic for task assignment lifecycle:
 * - Accept/reject assignments (staff actions)
 * - Clock in/out (time tracking)
 * - Notification triggers on accept/reject
 *
 * Enforces status transition rules:
 * - pending → accepted (accept)
 * - pending → rejected (reject, requires reason)
 * - accepted → clocked in (clockIn)
 * - clocked in → completed (clockOut)
 *
 * Authorization: Only the assigned member can perform
 * accept, reject, clockIn, and clockOut actions.
 */
import { reasonLabel } from "@/lib/decline-reasons";
import { isFullTime } from "@/lib/role-config";
import { shiftOutcome, workedHours } from "@/lib/shift-outcome";
import type { HistoryFilters } from "@/repositories/task-assignment.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { HourAlertService } from "@/services/hour-alert.service";
import { taskWatcherUserIds } from "@/services/task-watchers";

export class TaskAssignmentService {
  private assignmentRepo = new TaskAssignmentRepository();
  private auditService = new AuditLogService();
  private notificationService = new NotificationService();
  private hourAlertService = new HourAlertService();

  /**
   * Accepts a pending task assignment.
   * Notifies the admin/manager who assigned the task.
   */
  async accept(assignmentId: string, membershipId: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (assignment.status !== "pending") {
      throw new Error("Can only accept pending assignments");
    }

    const result = await this.assignmentRepo.accept(assignmentId);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_ACCEPTED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle: assignment.task.title },
    });

    // Notify the admin/manager who assigned the task
    const staffName = assignment.membership.user?.name || "A staff member";
    void this.notificationService.notify(
      assignment.task.organizationId,
      assignment.assignedById,
      NOTIFICATION_TYPES.ASSIGNMENT_ACCEPTED,
      "Assignment accepted",
      `${staffName} accepted "${assignment.task.title}"`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * Rejects a pending task assignment with a required reason.
   * Notifies the admin/manager who assigned the task.
   */
  async reject(assignmentId: string, membershipId: string, reason: string, notes?: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (assignment.status !== "pending") {
      throw new Error("Can only reject pending assignments");
    }

    /*
     * A full-time member declining a rostered shift is not the same act as a
     * casual turning down an offer, and until now the system could not tell
     * them apart — anyone could empty a slot instantly.
     *
     * Blocking it outright was the other option and it is worse: people still
     * get ill and buses still do not run, so the decline simply happens by
     * phone instead, and the reason, the timestamp and the audit entry are all
     * lost. Routing it through a manager keeps the event on the system and
     * keeps the slot filled while the answer is pending.
     *
     * Casual staff are unchanged. They are under no obligation to take an
     * offered shift, and making them ask permission to decline one would be
     * asserting a contractual relationship that does not exist.
     */
    if (isFullTime(assignment.membership.employmentType)) {
      return this.requestDecline(assignment, assignmentId, reason, notes);
    }

    const result = await this.assignmentRepo.reject(assignmentId, reason, notes);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_REJECTED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { reason, notes, taskTitle: assignment.task.title },
    });

    // Notify the admin/manager who assigned the task
    const staffName = assignment.membership.user?.name || "A staff member";
    void this.notificationService.notify(
      assignment.task.organizationId,
      assignment.assignedById,
      NOTIFICATION_TYPES.ASSIGNMENT_REJECTED,
      "Assignment rejected",
      `${staffName} rejected "${assignment.task.title}" — ${reason.replace(/_/g, " ")}`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * Records clock-in for an accepted assignment.
   * Must be accepted and not already clocked in.
   */
  async clockIn(assignmentId: string, membershipId: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (assignment.status !== "accepted") {
      throw new Error("Can only clock in to accepted assignments");
    }

    if (assignment.clockInTime) {
      throw new Error("Already clocked in");
    }

    const result = await this.assignmentRepo.clockIn(assignmentId);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_CLOCKED_IN,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle: assignment.task.title },
    });

    return result;
  }

  /**
   * Records clock-out — moves the assignment to "clocked_out".
   * The staff member confirms the work is done separately via `complete`.
   * Must be clocked in and not already clocked out.
   */
  async clockOut(assignmentId: string, membershipId: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (!assignment.clockInTime) {
      throw new Error("Must clock in before clocking out");
    }

    if (assignment.clockOutTime) {
      throw new Error("Already clocked out");
    }

    const result = await this.assignmentRepo.clockOut(assignmentId);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_CLOCKED_OUT,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle: assignment.task.title },
    });

    // Worked hours just changed — alert staff/managers if a limit is near (US-72, US-85).
    // Fire-and-forget: never blocks or fails the clock-out.
    void this.hourAlertService.checkAndAlertMember(
      membershipId,
      assignment.task.organizationId
    );

    return result;
  }

  /**
   * Staff marks a clocked-out assignment as completed (US-78).
   * Confirms the work is finished. Notifies the assigning manager.
   */
  async complete(assignmentId: string, membershipId: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (assignment.status !== "clocked_out") {
      throw new Error("Can only complete a task after clocking out");
    }

    const result = await this.assignmentRepo.complete(assignmentId);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_COMPLETED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle: assignment.task.title },
    });

    const staffName = assignment.membership.user?.name || "A staff member";
    void this.notificationService.notify(
      assignment.task.organizationId,
      assignment.assignedById,
      NOTIFICATION_TYPES.TASK_COMPLETED,
      "Task completed",
      `${staffName} completed "${assignment.task.title}"`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * The staff member's own rating of a shift they worked, 1–5.
   *
   * ## Why the staff member and not the manager
   *
   * The system already collects why people say no — decline and withdrawal
   * reasons. It collects nothing about the shifts they say yes to and then
   * work, so a department that everyone quietly dreads looks identical to one
   * everyone likes. This is the missing half of that record.
   *
   * It is also the only feedback that can be joined against the allocation
   * columns to ask whether the engine's high-scoring picks were actually
   * better shifts for the people placed on them, rather than merely accepted.
   *
   * ## Which shifts can be rated
   *
   * Clocked out or completed — the work is done in both cases. Requiring
   * "completed" alone would leave anyone who forgets the final confirmation
   * unable to rate a shift they genuinely worked, and that silence would be
   * read as indifference rather than a missed button.
   *
   * ## Why re-rating is allowed
   *
   * A rating given on a phone at the end of a shift is easy to mis-tap, and a
   * permanent wrong score is worse for the data than a corrected one. The
   * audit log keeps every submission, so the history is not lost.
   */
  async rate(
    assignmentId: string,
    membershipId: string,
    rating: number,
    comment?: string
  ) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (!["clocked_out", "completed"].includes(assignment.status)) {
      throw new Error("Can only rate a shift you have worked");
    }

    // Validated at the boundary and constrained in the database too. Repeated
    // here because this is the layer that owns the rule, and a future caller
    // reaching the service directly must not be able to store a 0 or a 9.
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new Error("Rating must be a whole number from 1 to 5");
    }

    const trimmed = comment?.trim();
    const result = await this.assignmentRepo.rate(
      assignmentId,
      rating,
      trimmed ? trimmed : undefined
    );

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_RATED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { rating, comment: trimmed, taskTitle: assignment.task.title },
    });

    // Only low scores notify. A manager who is pinged for every rating stops
    // reading them, and a 4 needs no response — the aggregate panel is where
    // ordinary scores belong. A 1 or a 2 is someone saying something went
    // wrong on a shift they worked, which is worth interrupting for.
    if (rating <= 2) {
      const staffName = assignment.membership.user?.name || "A staff member";
      void this.notificationService.notify(
        assignment.task.organizationId,
        assignment.assignedById,
        NOTIFICATION_TYPES.SHIFT_RATED_LOW,
        "Shift rated poorly",
        `${staffName} rated "${assignment.task.title}" ${rating} out of 5${
          trimmed ? ` — ${trimmed}` : ""
        }`,
        "task",
        assignment.task.id
      );
    }

    return result;
  }

  /**
   * A full-time member's decline, held for a manager's decision.
   *
   * Private and reached only from `reject`, so the branch cannot be bypassed by
   * calling a different entry point. Takes the already-loaded assignment rather
   * than re-reading it — `reject` has verified ownership and status, and a
   * second read would be a second chance for them to disagree.
   */
  private async requestDecline(
    assignment: NonNullable<
      Awaited<ReturnType<TaskAssignmentRepository["findById"]>>
    >,
    assignmentId: string,
    reason: string,
    notes?: string
  ) {
    const result = await this.assignmentRepo.requestDecline(
      assignmentId,
      reason,
      notes
    );

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_DECLINE_REQUESTED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { reason, notes, taskTitle: assignment.task.title },
    });

    const staffName = assignment.membership.user?.name || "A staff member";
    void this.notificationService.notify(
      assignment.task.organizationId,
      assignment.assignedById,
      NOTIFICATION_TYPES.DECLINE_REQUESTED,
      "Decline needs your approval",
      `${staffName} (full-time) asked to be taken off "${assignment.task.title}" — ${reasonLabel(reason)}${notes ? `: ${notes}` : ""}`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * Manager approves or denies a full-time member's decline request.
   *
   * Approve frees the slot and records the rejection with the reason the member
   * already gave. Deny returns the row to PENDING — not to accepted: a manager
   * refusing the request has not thereby accepted the shift on the member's
   * behalf, and the member still owes an answer.
   *
   * Authorization (manager/admin, department scope) is enforced at the route.
   */
  async resolveDecline(
    assignmentId: string,
    decision: "approve" | "deny",
    actorUserId: string,
    organizationId: string
  ) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    // A manager may only resolve declines for their own org's assignments.
    if (!assignment || assignment.task.organizationId !== organizationId) {
      throw new Error("Assignment not found");
    }

    if (assignment.status !== "decline_requested") {
      throw new Error("No pending decline request for this assignment");
    }

    /*
     * Not your own.
     *
     * Full-time declines exist because a full-time member's shift is an
     * obligation somebody else has to agree to release them from. A manager is
     * both rosterable (`canBeRostered` includes them) and holds `tasks:assign`
     * by default, so without this the whole approval step collapses for the
     * people most likely to be full-time: request the decline, approve it, no
     * second human involved. The route's permission check cannot catch it —
     * they legitimately hold the permission, just not over this row.
     */
    if (assignment.membership.userId === actorUserId) {
      throw new Error("You cannot resolve your own decline request");
    }

    const staffUserId = assignment.membership.userId;
    const taskTitle = assignment.task.title;
    const reason = assignment.rejectionReason;

    if (decision === "approve") {
      const result = await this.assignmentRepo.approveDecline(assignmentId);

      await this.auditService.log({
        organizationId,
        userId: actorUserId,
        action: ACTIONS.ASSIGNMENT_DECLINE_APPROVED,
        entityType: "assignment",
        entityId: assignmentId,
        details: { taskTitle, reason },
      });

      void this.notificationService.notify(
        organizationId,
        staffUserId,
        NOTIFICATION_TYPES.DECLINE_APPROVED,
        "Decline approved",
        `You have been taken off "${taskTitle}"`,
        "task",
        assignment.task.id
      );

      await this.seekCover(assignment, actorUserId);

      return result;
    }

    const result = await this.assignmentRepo.denyDecline(assignmentId);

    await this.auditService.log({
      organizationId,
      userId: actorUserId,
      action: ACTIONS.ASSIGNMENT_DECLINE_DENIED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle, reason },
    });

    void this.notificationService.notify(
      organizationId,
      staffUserId,
      NOTIFICATION_TYPES.DECLINE_DENIED,
      "Decline not approved",
      // Says what is now true rather than only what was refused: the row has
      // gone back to pending, so the member has something to do about it.
      `You are still rostered on "${taskTitle}" — please accept or speak to your manager`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * Staff requests to withdraw/abort an accepted assignment with a reason (US-76).
   * The slot stays reserved (status "withdrawal_requested") until a manager
   * approves or denies. Notifies the assigning manager.
   */
  async requestWithdrawal(
    assignmentId: string,
    membershipId: string,
    reason: string,
    notes?: string
  ) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (assignment.status !== "accepted") {
      throw new Error("Can only withdraw from an accepted task");
    }

    const result = await this.assignmentRepo.requestWithdrawal(assignmentId, reason, notes);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_WITHDRAWAL_REQUESTED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { reason, notes, taskTitle: assignment.task.title },
    });

    const staffName = assignment.membership.user?.name || "A staff member";
    /*
     * Everyone who can ANSWER this, not only whoever assigned the shift.
     *
     * `assignedById` was the sole recipient, and it is the wrong question. It
     * names the person who created the assignment — which may be an admin, a
     * manager who has since moved department, or, on an auto-allocated shift,
     * whoever happened to trigger the run. Meanwhile the tasks board shows the
     * request, with approve and deny on it, to every manager holding
     * `tasks:assign` in that department. So the people looking at the buttons
     * were not the people being told, and a request could sit on the board
     * with nobody notified that it was there.
     *
     * `taskWatcherUserIds` is the same set the board uses — active members
     * with `tasks:assign`, department-scoped — so who is told and who can act
     * are now one list rather than two that happen to overlap.
     */
    const deciders = await taskWatcherUserIds(
      assignment.task.organizationId,
      assignment.task.departmentId ?? null
    );
    void this.notificationService.notifyMany(
      assignment.task.organizationId,
      /*
       * The assigner is kept even when they are not a current watcher — they
       * own the decision they made — and de-duplicated, because they usually
       * ARE one and `notifyMany` writes a row per id.
       */
      [...new Set([...deciders, assignment.assignedById])],
      NOTIFICATION_TYPES.WITHDRAWAL_REQUESTED,
      "Withdrawal requested",
      // The stored value is an enum key; a manager reading a notification should
      // not be shown "personal_reasons". Notes are appended when given, because
      // the reason alone rarely says enough to decide on.
      `${staffName} requested to withdraw from "${assignment.task.title}" — ${reasonLabel(reason)}${notes ? `: ${notes}` : ""}`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * Manager approves or denies a pending withdrawal request.
   * Approve removes the staff member from the task (frees the slot);
   * deny reverts the assignment to accepted. Notifies the staff member.
   * Authorization (manager/admin) is enforced at the route layer.
   */
  async resolveWithdrawal(
    assignmentId: string,
    decision: "approve" | "deny",
    actorUserId: string,
    organizationId: string
  ) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    // A manager may only resolve withdrawals for their own org's assignments.
    if (!assignment || assignment.task.organizationId !== organizationId) {
      throw new Error("Assignment not found");
    }

    if (assignment.status !== "withdrawal_requested") {
      throw new Error("No pending withdrawal request for this assignment");
    }

    // Same rule as `resolveDecline` — a request for someone else's agreement
    // is not a request if you can answer it yourself.
    if (assignment.membership.userId === actorUserId) {
      throw new Error("You cannot resolve your own withdrawal request");
    }

    const staffUserId = assignment.membership.userId;
    const taskTitle = assignment.task.title;

    if (decision === "approve") {
      /*
       * Give the slot back, keep the record.
       *
       * This called `cancel`, which DELETES the row. See
       * `TaskAssignmentRepository.withdraw` for the three things that broke —
       * the shortest of which is that deleting the row deleted the engine's
       * only reason not to offer the shift straight back to the person who had
       * just asked to come off it.
       */
      const result = await this.assignmentRepo.withdraw(assignmentId);

      await this.auditService.log({
        organizationId: assignment.task.organizationId,
        userId: actorUserId,
        action: ACTIONS.ASSIGNMENT_WITHDRAWAL_APPROVED,
        entityType: "assignment",
        entityId: assignmentId,
        details: { taskTitle, reason: assignment.withdrawalReason },
      });

      void this.notificationService.notify(
        assignment.task.organizationId,
        staffUserId,
        NOTIFICATION_TYPES.WITHDRAWAL_APPROVED,
        "Withdrawal approved",
        `Your request to withdraw from "${taskTitle}" was approved. You've been unassigned.`,
        "task",
        assignment.task.id
      );

      await this.seekCover(assignment, actorUserId);

      /*
       * The row, not a hand-built object.
       *
       * This returned `{ id, status: "withdrawn" }` — a literal describing a
       * row that had just been deleted, which is how the deletion stayed
       * invisible for so long: every caller and every test saw the status they
       * expected. Returning what was actually written means the two cannot
       * disagree again.
       */
      return result;
    }

    // Deny — revert to accepted.
    const result = await this.assignmentRepo.denyWithdrawal(assignmentId);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: actorUserId,
      action: ACTIONS.ASSIGNMENT_WITHDRAWAL_DENIED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle },
    });

    void this.notificationService.notify(
      assignment.task.organizationId,
      staffUserId,
      NOTIFICATION_TYPES.WITHDRAWAL_DENIED,
      "Withdrawal declined",
      `Your request to withdraw from "${taskTitle}" was declined. You remain assigned.`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * Somebody has come off a shift. Decide what to do about the empty slot.
   *
   * Delegates to `AvailabilityService.findCover`, which was written for
   * approved leave and is the only place in the product that answers this
   * question properly: it reads the organisation's `allocationMode` instead of
   * inventing a second setting, it refuses to automate a shift starting within
   * 48 hours because that is a phone call, and it notifies the people who can
   * act on EVERY branch — including the one where nobody eligible exists, which
   * is the branch a manager most needs to hear about.
   *
   * An approved decline and an approved withdrawal are the same event as an
   * approved leave. Only leave ever called it.
   *
   * ## Awaited, and wrapped
   *
   * Awaited because in `auto` mode this assigns somebody, and a manager whose
   * page refetches immediately after pressing Approve should see the result
   * rather than race it. Wrapped because cover is a consequence of the
   * decision, not part of it: a ranking failure must not turn an approval the
   * member has already been notified about into an error the manager sees.
   *
   * Imported lazily — `AvailabilityService` reaches for `TaskService`, which
   * holds one of these, and a static import would close the loop at
   * construction time.
   */
  private async seekCover(
    assignment: NonNullable<
      Awaited<ReturnType<TaskAssignmentRepository["findById"]>>
    >,
    actorUserId: string
  ) {
    /*
     * A shift that has already ended needs no cover.
     *
     * Without this, resolving a stale request — the case §5.24 exists for, a
     * withdrawal from May answered in August — would tell the whole watcher
     * list to "arrange cover directly" for a shift nobody can work now. It
     * would arrive as short notice, because `isShortNotice` measures hours
     * until the start and a past shift is comfortably under any threshold.
     */
    const over = assignment.task.scheduledEnd ?? assignment.task.scheduledStart;
    if (over && over.getTime() < Date.now()) return;

    try {
      const { AvailabilityService } = await import(
        "@/services/availability.service"
      );
      await new AvailabilityService().findCover(
        {
          assignmentId: assignment.id,
          taskId: assignment.task.id,
          taskTitle: assignment.task.title,
          organizationId: assignment.task.organizationId,
          departmentId: assignment.task.departmentId,
          scheduledStart: assignment.task.scheduledStart,
        },
        assignment.membership.user?.name || "A staff member",
        actorUserId,
        // An approved decline or withdrawal, not leave. `findCover` opened
        // every notification with "their leave was approved" because leave was
        // its only caller when it was written — so a manager answering a
        // withdrawal was told about a leave request that did not exist.
        "withdrawn"
      );
    } catch (error) {
      console.error("[Cover Search Error]", error);
    }
  }

  /**
   * A member's own shift history — one page of rows, plus totals for the range.
   *
   * ## Whose history
   *
   * Their own, always. `membershipId` comes from the session at the boundary
   * and is never read from the query string, so there is no shape of this
   * request that returns somebody else's record. A manager wanting to see a
   * team member's history is a different feature with a different permission,
   * and building it as a parameter here would have made the two one URL apart.
   *
   * ## Why the totals are computed here
   *
   * They are derived facts, not stored ones, and Control is where derivation
   * belongs — the same figures are wanted by the page, and would be wanted by
   * an export or a payslip check, and three copies of "which statuses count as
   * worked" is how the headcount definitions drifted.
   *
   * ## Hours that are not counted
   *
   * `hoursWorked` sums complete clock pairs and nothing else. A shift clocked
   * into and never out of contributes nothing, and `shiftsMissingHours` says
   * how many did that, so the total can be short without being unexplained.
   * The alternative — falling back to the scheduled span — would produce a
   * number that looks like measured time and is not, on exactly the rows where
   * the difference matters.
   */
  async getHistory(
    membershipId: string,
    options: HistoryFilters & { page?: number; pageSize?: number } = {}
  ) {
    const pageSize = Math.min(Math.max(options.pageSize ?? 20, 1), 100);
    const page = Math.max(options.page ?? 1, 1);

    if (options.from && options.to && options.from > options.to) {
      throw new Error("The start of the range must come before the end");
    }

    /*
     * One object, passed to both queries. The list is paged and the totals are
     * not, so a filter reaching one and not the other would print "3 shifts, 11
     * hours" above a list of one — the same page-versus-range failure the
     * summary was built to avoid, arriving through a different door.
     */
    const range: HistoryFilters = {
      from: options.from,
      to: options.to,
      departmentId: options.departmentId,
      search: options.search,
      outcome: options.outcome,
    };

    const [{ rows, total }, all, departments] = await Promise.all([
      this.assignmentRepo.findHistoryForMember(membershipId, {
        ...range,
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      this.assignmentRepo.summariseHistoryForMember(membershipId, range),
      // Date range only — see the repository. The list of departments a member
      // can pick from must not shrink as they pick.
      this.assignmentRepo.historyDepartments(membershipId, {
        from: options.from,
        to: options.to,
      }),
    ]);

    let hoursWorked = 0;
    let shiftsWorked = 0;
    let shiftsMissingHours = 0;
    let ratingTotal = 0;
    let ratedShifts = 0;

    for (const row of all) {
      const outcome = shiftOutcome({ ...row, task: { status: "" } });
      /*
       * `task.status` is not selected by the summary query, so the cancelled
       * branch cannot fire here — which is deliberate rather than an oversight
       * being papered over. Every figure below is about work done or not done,
       * and `worked` is decided before cancellation is even consulted, so the
       * one branch the summary cannot reach is the one it does not need.
       */
      if (outcome === "worked") {
        shiftsWorked++;
        const hours = workedHours(row);
        if (hours === null) shiftsMissingHours++;
        else hoursWorked += hours;
      } else if (outcome === "not_clocked_out") {
        shiftsMissingHours++;
      }

      if (row.satisfactionRating !== null) {
        ratingTotal += row.satisfactionRating;
        ratedShifts++;
      }
    }

    return {
      rows: rows.map((row) => ({
        ...row,
        outcome: shiftOutcome(row),
        hoursWorked: workedHours(row),
      })),
      departments,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      summary: {
        shiftsInRange: all.length,
        shiftsWorked,
        // One decimal. Payroll-grade precision on a figure derived from a
        // button somebody presses on the way out of the door would be a
        // precision the underlying data does not have.
        hoursWorked: Math.round(hoursWorked * 10) / 10,
        shiftsMissingHours,
        ratedShifts,
        // Null, not 0. An unrated history has no average, and printing 0.0 out
        // of 5 would read as "you rate every shift terribly".
        averageRating:
          ratedShifts > 0 ? Math.round((ratingTotal / ratedShifts) * 10) / 10 : null,
        // Clamped. Ratings are only accepted on worked shifts, but a row
        // predating that rule would otherwise show "-1 shifts left to rate".
        unratedWorkedShifts: Math.max(0, shiftsWorked - ratedShifts),
      },
    };
  }

  /**
   * A manager amends a recorded clock time.
   *
   * ## Why this exists
   *
   * A shift clocked into and never out of contributes no hours to the member's
   * totals, and nothing could put it right. Their own history said the shift
   * was not counted and offered no route to fixing it — a page telling somebody
   * their pay is short and that nothing can be done about it.
   *
   * ## What is refused, and why each
   *
   * A clock-out before the clock-in, because that is not a shift. A clock-in
   * with no clock-out is allowed: it is the state a running shift is genuinely
   * in, and refusing it would stop a manager fixing a mistyped start time until
   * the member had finished.
   *
   * A reason is required. This is the field the hours totals are built from, so
   * an amendment with no stated cause is indistinguishable from someone
   * adjusting what a person gets paid — and the difference between those two is
   * exactly what an audit is for.
   *
   * ## What is kept
   *
   * The row records THAT it was corrected, by whom and why, so the member sees
   * it on their own history without needing an audit screen their plan may not
   * include. The BEFORE and AFTER values go to the audit log, because a value
   * somebody can quietly restate is not evidence. The original is not preserved
   * on the row on purpose: two sets of times on one record invites the question
   * of which is real, and the answer must be "the current one, and here is the
   * record of the change".
   *
   * Audit is awaited here rather than fired and forgotten. Everywhere else in
   * this service a lost audit row costs a line of history; here it costs the
   * only account of who changed somebody's hours, which is the thing that makes
   * the correction legitimate rather than an edit.
   */
  async correctClock(
    assignmentId: string,
    organizationId: string,
    correctedById: string,
    input: { clockInTime: Date | null; clockOutTime: Date | null; reason: string }
  ) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    if (assignment.task.organizationId !== organizationId) {
      throw new Error("Assignment not found");
    }

    const reason = input.reason?.trim();
    if (!reason) throw new Error("A reason is required to correct a clock time");

    if (
      input.clockOutTime &&
      input.clockInTime &&
      input.clockOutTime <= input.clockInTime
    ) {
      throw new Error("Clock out must be after clock in");
    }

    /*
     * A clock-out with no clock-in is not a shift anybody worked — it is half a
     * correction, and it would produce a row the hours calculation reads as
     * unmeasurable while looking complete on screen.
     */
    if (input.clockOutTime && !input.clockInTime) {
      throw new Error("A clock out needs a clock in");
    }

    const before = {
      clockInTime: assignment.clockInTime,
      clockOutTime: assignment.clockOutTime,
    };

    const result = await this.assignmentRepo.correctClock(assignmentId, {
      clockInTime: input.clockInTime,
      clockOutTime: input.clockOutTime,
      correctedById,
      reason,
    });

    await this.auditService.log({
      organizationId,
      userId: correctedById,
      action: ACTIONS.ASSIGNMENT_CLOCK_CORRECTED,
      entityType: "assignment",
      entityId: assignmentId,
      details: {
        taskTitle: assignment.task.title,
        member: assignment.membership.user?.name ?? null,
        reason,
        before,
        after: {
          clockInTime: input.clockInTime,
          clockOutTime: input.clockOutTime,
        },
      },
    });

    /*
     * Told, not just recorded. Somebody else changing the hours you are paid
     * against is not an administrative detail, and a member who disagrees can
     * only say so if they know it happened.
     */
    if (assignment.membership?.userId) {
      void this.notificationService.notifyIfEnabled(
        organizationId,
        assignment.membership.userId,
        NOTIFICATION_TYPES.TASK_ASSIGNED,
        "A clock time was corrected",
        `Your hours for "${assignment.task.title}" were corrected — ${reason}`,
        "task",
        assignment.task.id
      );
    }

    return result;
  }
}
