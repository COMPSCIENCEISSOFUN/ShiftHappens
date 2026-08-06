/**
 * TaskAssignment Repository (Entity Layer)
 * 
 * Data access layer for task assignment operations.
 * Handles assignment creation, status transitions
 * (pending → accepted → clocked in → completed),
 * rejection with reason, and clock in/out tracking.
 * 
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { prisma } from "@/lib/prisma";
import { occupyingStatusFilter } from "@/lib/assignment-status";

export class TaskAssignmentRepository {
  /** Creates a new task assignment with pending status */
  /**
   * The department of an assignment's task, for scope checks. Same tri-state as
   * TaskRepository.getDepartmentId: `undefined` = no such assignment.
   */
  async getTaskDepartmentId(id: string): Promise<string | null | undefined> {
    const assignment = await prisma.taskAssignment.findUnique({
      where: { id },
      select: { task: { select: { departmentId: true } } },
    });
    return assignment === null ? undefined : assignment.task.departmentId;
  }

  async create(data: {
    taskId: string;
    membershipId: string;
    assignedById: string;
    status?: string;
    /** See src/lib/allocation-provenance.ts. Omitted means "not recorded". */
    allocationSource?: string;
    allocationProvider?: string;
    allocationScore?: number;
    allocationRank?: number;
  }) {
    return prisma.taskAssignment.create({
      data: {
        taskId: data.taskId,
        membershipId: data.membershipId,
        assignedById: data.assignedById,
        status: data.status ?? "pending",
        // Prisma treats undefined as "leave alone", which on a create means
        // the column stays NULL — exactly the "not recorded" state wanted for
        // any caller that does not know how the choice was made.
        allocationSource: data.allocationSource,
        allocationProvider: data.allocationProvider,
        allocationScore: data.allocationScore,
        allocationRank: data.allocationRank,
      },
    });
  }

  /** Finds an assignment by ID with full task and user details */
  async findById(id: string) {
    return prisma.taskAssignment.findUnique({
      where: { id },
      include: {
        task: {
          include: {
            department: { select: { id: true, name: true, color: true } },
          },
        },
        membership: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
        assignedBy: { select: { id: true, name: true } },
      },
    });
  }

  /** Lists all assignments for a specific task */
  async findByTaskId(taskId: string) {
    return prisma.taskAssignment.findMany({
      where: { taskId },
      include: {
        membership: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
        assignedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /**
   * Lists all assignments for a member, optionally filtered by status.
   * Used for staff viewing their assigned tasks (US-56).
   */
  async findByMembershipId(membershipId: string, status?: string) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        ...(status && { status }),
      },
      include: {
        task: {
          include: {
            department: { select: { id: true, name: true, color: true } },
            createdBy: { select: { id: true, name: true } },
          },
        },
        assignedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  /** Updates an assignment's status */
  async updateStatus(id: string, status: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status },
    });
  }

  /**
   * A staff member accepting an offered assignment.
   *
   * Separate from `updateStatus("accepted")` because `acceptedAt` must record
   * the staff member's answer and nothing else. `denyWithdrawal` also returns
   * a row to "accepted", and stamping it there would rewrite the original
   * response time every time a manager refused someone's request to drop out.
   */
  async accept(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status: "accepted", acceptedAt: new Date() },
    });
  }

  /** Rejects an assignment with a required reason */
  async reject(id: string, reason: string, notes?: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "rejected",
        rejectionReason: reason,
        rejectionNotes: notes,
        rejectedAt: new Date(),
      },
    });
  }

  /**
   * A full-time member's request to be taken off a shift they were rostered
   * onto but had not accepted.
   *
   * Stored in the rejection columns rather than new ones: this IS a rejection,
   * held pending a manager's agreement, and if it is approved the row must
   * already carry the reason the member gave. Duplicating the columns would
   * mean copying values across on approval and leaving two places where a
   * decline reason could live.
   *
   * `rejectedAt` stays NULL — nothing has been rejected yet. `approveDecline`
   * stamps it, so the response-time figures still measure the member's answer
   * rather than the manager's.
   */
  async requestDecline(id: string, reason: string, notes?: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "decline_requested",
        rejectionReason: reason,
        // null, not undefined — Prisma ignores undefined, so a second request
        // without notes would silently keep the first request's notes.
        rejectionNotes: notes ?? null,
      },
    });
  }

  /**
   * Manager agrees: the decline takes effect and the slot is freed.
   *
   * Reason and notes are already on the row from `requestDecline` and are left
   * untouched — the member's words, not the manager's.
   */
  async approveDecline(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status: "rejected", rejectedAt: new Date() },
    });
  }

  /**
   * Manager refuses: back to pending, NOT to accepted.
   *
   * The member is expected on the shift and still has to answer for
   * themselves. Reverting to "accepted" would have the system record an
   * acceptance the member never gave, which is the reason this flow does not
   * reuse the withdrawal statuses.
   *
   * Reason and notes are cleared: they described a request that was refused,
   * and leaving them would make a later genuine decline look like a repeat.
   */
  async denyDecline(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "pending",
        rejectionReason: null,
        rejectionNotes: null,
      },
    });
  }

  /** Records clock-in time for an accepted assignment */
  async clockIn(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { clockInTime: new Date() },
    });
  }

  /**
   * Records clock-out time and moves the assignment to "clocked_out".
   * The shift is worked but not yet confirmed done — the staff member
   * explicitly marks it completed afterwards (see `complete`).
   */
  async clockOut(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        clockOutTime: new Date(),
        status: "clocked_out",
      },
    });
  }

  /** Marks a clocked-out assignment as completed (staff confirmation). */
  async complete(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status: "completed" },
    });
  }

  /** Records a staff withdrawal request with a reason. Slot stays reserved. */
  async requestWithdrawal(id: string, reason: string, notes?: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "withdrawal_requested",
        withdrawalReason: reason,
        // null, not undefined: Prisma ignores undefined, so a second request
        // without notes would silently keep the notes from the first one.
        withdrawalNotes: notes ?? null,
        // How much warning the shift got. The counterpart to the
        // insufficient_notice reason staff themselves select — this is the
        // same measure taken from the other side.
        withdrawalRequestedAt: new Date(),
      },
    });
  }

  /** Manager denies a withdrawal request — assignment reverts to accepted. */
  async denyWithdrawal(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "accepted",
        withdrawalReason: null,
        withdrawalNotes: null,
        // Cleared with the reason it belongs to. Leaving it set would report
        // a withdrawal that was refused as one that happened, and the member
        // is back on the shift.
        withdrawalRequestedAt: null,
      },
    });
  }

  /**
   * A staff member's own rating of a shift they worked.
   *
   * `comment ?? null` rather than `undefined` — re-rating without a comment
   * must clear the previous one, or the new score is shown next to reasoning
   * for the old one.
   */
  async rate(id: string, rating: number, comment?: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        satisfactionRating: rating,
        satisfactionComment: comment ?? null,
        ratedAt: new Date(),
      },
    });
  }

  /**
   * Counts active (slot-occupying) assignments for a task.
   *
   * "Occupying" is `occupyingStatusFilter()` — everything except rejected and
   * withdrawn. That includes a decision still waiting on a manager, in either
   * direction: a pending withdrawal or a pending full-time decline keeps the
   * seat until it is resolved. Used against requiredHeadcount before adding
   * more.
   */
  async countActiveByTaskId(taskId: string): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        taskId,
        // The shared rule, which also covers clocked_out and completed. The
        // hand-written list here undercounted an in-progress shift, so a
        // manager could assign past requiredHeadcount once people clocked in.
        status: { in: occupyingStatusFilter() },
      },
    });
  }

  /** Cancels (deletes) an assignment — admin/manager action */
  async cancel(id: string) {
    return prisma.taskAssignment.delete({ where: { id } });
  }

  /**
   * A member's finished shifts that started on or after `since`, for summing
   * hours actually worked. Rows without a clock-out are excluded: an open
   * shift has no measurable duration and would otherwise be counted as zero,
   * quietly understating how close the member is to their limit.
   */
  async findWorkedSince(membershipId: string, since: Date) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: ["clocked_out", "completed"] },
        clockInTime: { gte: since },
        clockOutTime: { not: null },
      },
    });
  }

  /**
   * How often a member has actually served a given department. Feeds the AI
   * ranker's familiarity signal, so only assignments the member took count —
   * a pending offer they may still reject says nothing about experience.
   */
  async countDepartmentHistory(
    membershipId: string,
    departmentId: string
  ): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        membershipId,
        task: { departmentId },
        status: { in: ["accepted", "clocked_out", "completed"] },
      },
    });
  }

  /**
   * A member's assignments in the given statuses, paired with their task's
   * scheduled window. The eligibility engine needs BOTH: hours already clocked
   * and hours merely committed to a future shift. Loading only clock times
   * would make an over-booked week look empty until the shifts were worked.
   *
   * `excludeTaskId` drops the task being evaluated so it is not counted
   * against itself when re-checking after a reschedule.
   */
  async findCommittedWithSchedule(
    membershipId: string,
    statuses: string[],
    excludeTaskId?: string
  ) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: statuses },
        ...(excludeTaskId ? { taskId: { not: excludeTaskId } } : {}),
      },
      select: {
        // `taskId` so a caller can exclude the task under evaluation in memory
        // rather than in the query. That is what lets one member's commitments
        // be loaded ONCE for a whole run instead of once per task — see
        // `EligibilityService.loadStoredAssignments`.
        taskId: true,
        clockInTime: true,
        clockOutTime: true,
        task: { select: { scheduledStart: true, scheduledEnd: true } },
      },
    });
  }

  /**
   * A member's live assignments to shifts that have not started yet.
   *
   * "Live" means still standing — the shared occupying set, which includes a
   * decline or a withdrawal still awaiting a manager's decision. A rejected or
   * withdrawn assignment is not at risk because nobody is expecting that
   * person to turn up.
   *
   * Deliberately future-only. When someone changes their availability, alerting
   * a manager about a shift that has already been worked is noise about
   * something nobody can act on.
   */
  async findUpcomingCommitments(membershipId: string, from: Date) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: occupyingStatusFilter() },
        task: { scheduledStart: { gte: from } },
      },
      select: {
        id: true,
        task: {
          select: {
            id: true,
            title: true,
            organizationId: true,
            departmentId: true,
            scheduledStart: true,
          },
        },
      },
      orderBy: { task: { scheduledStart: "asc" } },
    });
  }

  /**
   * Recent rejections across an organisation, with the rejecting member.
   * Scoped through the task's org because an assignment has no organizationId
   * of its own — joining on the member instead would let a person who moved
   * organisations drag their old rejections into the new tenant's analysis.
   */
  async findRecentRejections(organizationId: string, since: Date) {
    return prisma.taskAssignment.findMany({
      where: {
        task: { organizationId },
        status: "rejected",
        createdAt: { gte: since },
      },
      include: {
        membership: {
          // `id` for grouping, `userId` because the dashboard's follow-up
          // action addresses a person rather than a membership — the member
          // routes are keyed on user id.
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });
  }

  /**
   * Shifts finished across an organisation since a cut-off. Counts on
   * clock-OUT time, not the assignment's creation date: a shift created
   * yesterday and finished this morning belongs to today's tally.
   */
  async countCompletedSince(
    organizationId: string,
    since: Date
  ): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        task: { organizationId },
        status: { in: ["clocked_out", "completed"] },
        clockOutTime: { gte: since },
      },
    });
  }

  /**
   * Clock times for a member's committed shifts whose task sits entirely
   * inside a window — the auto-scheduler's "hours already on this week"
   * figure. Only assignments that have been clocked into are considered, so
   * the number reflects work under way rather than intentions.
   */
  /**
   * Everything a member is COMMITTED to in a window, worked or not.
   *
   * Distinct from `findClockedWithinWindow` beside it, which requires a
   * clock-in and so answers "what have they actually done". That is the right
   * question for a timesheet and the wrong one for a scheduler: a shift booked
   * for next Tuesday has no clock-in, so it counted as zero load and the
   * fully-booked member read as the freshest person available — while the
   * ranker weights "fewest hours worked" at 30%.
   *
   * Returns both the clock times and the scheduled window so the caller can
   * prefer actuals where they exist and fall back to what was planned.
   */
  async findCommitmentsWithinWindow(
    membershipId: string,
    windowStart: Date,
    windowEnd: Date
  ) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: occupyingStatusFilter() },
        task: {
          scheduledStart: { gte: windowStart },
          scheduledEnd: { lte: windowEnd },
        },
      },
      select: {
        clockInTime: true,
        clockOutTime: true,
        task: { select: { scheduledStart: true, scheduledEnd: true } },
      },
    });
  }

  async findClockedWithinWindow(
    membershipId: string,
    windowStart: Date,
    windowEnd: Date
  ) {
    return prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: ["accepted", "clocked_out", "completed"] },
        clockInTime: { not: null },
        task: {
          scheduledStart: { gte: windowStart },
          scheduledEnd: { lte: windowEnd },
        },
      },
      select: { clockInTime: true, clockOutTime: true },
    });
  }
}