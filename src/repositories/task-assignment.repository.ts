/**
 * TaskAssignment Repository (Entity Layer)
 * 
 * Data access layer for task assignment operations.
 * Handles immediate assignment creation, status transitions,
 * withdrawal requests, and clock in/out tracking.
 * 
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { prisma } from "@/lib/prisma";
import {
  ASSIGNMENT_STATUSES,
  SLOT_OCCUPYING_ASSIGNMENT_STATUSES,
} from "@/lib/assignment-status";

export class TaskAssignmentRepository {
  /** Creates a new active task assignment */
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
        status: data.status ?? ASSIGNMENT_STATUSES.ASSIGNED,
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
            department: { select: { id: true, name: true } },
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
            department: { select: { id: true, name: true } },
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

  /** Records clock-in time and moves the assignment into progress */
  async clockIn(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        clockInTime: new Date(),
        status: ASSIGNMENT_STATUSES.IN_PROGRESS,
      },
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
        status: ASSIGNMENT_STATUSES.CLOCKED_OUT,
      },
    });
  }

  /** Marks a clocked-out assignment as completed (staff confirmation). */
  async complete(id: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: { status: ASSIGNMENT_STATUSES.COMPLETED },
    });
  }

  /** Records a staff withdrawal request with a reason. Slot stays reserved. */
  async requestWithdrawal(id: string, reason: string, statusBeforeRequest: string) {
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: ASSIGNMENT_STATUSES.WITHDRAWAL_REQUESTED,
        withdrawalReason: reason,
        withdrawalRequestedAt: new Date(),
        withdrawalStatusBeforeRequest: statusBeforeRequest,
        withdrawalReviewedAt: null,
        withdrawalReviewedById: null,
        withdrawalDecision: null,
      },
    });
  }

  /** Manager approves a withdrawal request while preserving the work record. */
  async approveWithdrawal(id: string, reviewerUserId: string) {
    const assignment = await prisma.taskAssignment.findUnique({ where: { id } });
    const shouldClosePartialInterval =
      Boolean(assignment?.clockInTime) && !assignment?.clockOutTime;

    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: ASSIGNMENT_STATUSES.WITHDRAWN,
        withdrawalReviewedAt: new Date(),
        withdrawalReviewedById: reviewerUserId,
        withdrawalDecision: "approved",
        ...(shouldClosePartialInterval ? { clockOutTime: new Date() } : {}),
      },
    });
  }

  /** Manager denies a withdrawal request; assignment returns to its active path. */
  async denyWithdrawal(id: string, reviewerUserId: string) {
    const assignment = await prisma.taskAssignment.findUnique({ where: { id } });
    const nextStatus =
      assignment?.withdrawalStatusBeforeRequest ?? ASSIGNMENT_STATUSES.ASSIGNED;

    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status: nextStatus,
        withdrawalReviewedAt: new Date(),
        withdrawalReviewedById: reviewerUserId,
        withdrawalDecision: "denied",
      },
    });
  }

  /**
   * Counts active (slot-occupying) assignments for a task.
   * Active, in-progress, clocked-out, and withdrawal-requested assignments
   * reserve a slot until they are completed, withdrawn, cancelled, or removed.
   * Used to check against requiredHeadcount before adding more.
   */
  async countActiveByTaskId(taskId: string): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        taskId,
        status: { in: SLOT_OCCUPYING_ASSIGNMENT_STATUSES },
      },
    });
  }

  /** Memberships currently occupying task slots, used during replacement. */
  async findActiveMembershipIdsByTaskId(taskId: string): Promise<string[]> {
    const assignments = await prisma.taskAssignment.findMany({
      where: {
        taskId,
        status: { in: SLOT_OCCUPYING_ASSIGNMENT_STATUSES },
      },
      select: { membershipId: true },
    });
    return assignments.map((assignment) => assignment.membershipId);
  }

  /** Cancels (deletes) an assignment — admin/manager action */
  async cancel(id: string) {
    return prisma.taskAssignment.delete({ where: { id } });
  }
}
