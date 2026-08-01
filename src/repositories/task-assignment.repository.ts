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
  }) {
    return prisma.taskAssignment.create({
      data: {
        taskId: data.taskId,
        membershipId: data.membershipId,
        assignedById: data.assignedById,
        status: data.status ?? "pending",
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
      orderBy: { createdAt: "asc" },
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
      orderBy: { createdAt: "desc" },
    });
  }

  /** Updates an assignment's status */
  async updateStatus(id: string, status: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status },
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
  async requestWithdrawal(id: string, reason: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: "withdrawal_requested",
        withdrawalReason: reason,
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
      },
    });
  }

  /**
   * Counts active (slot-occupying) assignments for a task.
   * pending, accepted, and withdrawal_requested all reserve a slot —
   * a pending withdrawal keeps the seat until a manager resolves it.
   * Used to check against requiredHeadcount before adding more.
   */
  async countActiveByTaskId(taskId: string): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        taskId,
        status: { in: ["pending", "accepted", "withdrawal_requested"] },
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
        clockInTime: true,
        clockOutTime: true,
        task: { select: { scheduledStart: true, scheduledEnd: true } },
      },
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
          include: { user: { select: { name: true, email: true } } },
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