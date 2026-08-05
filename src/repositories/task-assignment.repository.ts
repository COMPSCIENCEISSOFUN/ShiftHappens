/**
 * TaskAssignment Repository (Entity Layer)
 * 
 * Data access layer for task assignment operations.
 * Handles immediate assignment creation, status transitions,
 * withdrawal requests, and clock in/out tracking.
 * 
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { Prisma } from "@prisma/client";
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
   * Creates a selected assignment batch atomically. Serializable isolation
   * makes concurrent requests re-check the same authoritative headcount.
   */
  async createBatchAtomic(data: {
    taskId: string;
    organizationId: string;
    membershipIds: string[];
    assignedById: string;
  }) {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await prisma.$transaction(
          async (tx) => {
            const task = await tx.task.findUnique({
              where: { id: data.taskId },
              select: {
                organizationId: true,
                departmentId: true,
                requiredHeadcount: true,
              },
            });
            if (!task || task.organizationId !== data.organizationId) {
              throw new Error("Task not found");
            }

            const activeCount = await tx.taskAssignment.count({
              where: {
                taskId: data.taskId,
                status: { in: SLOT_OCCUPYING_ASSIGNMENT_STATUSES },
              },
            });
            if (activeCount + data.membershipIds.length > task.requiredHeadcount) {
              throw new Error(
                `Assignment exceeds required headcount of ${task.requiredHeadcount}`
              );
            }

            const eligibleMembershipCount = await tx.membership.count({
              where: {
                id: { in: data.membershipIds },
                organizationId: data.organizationId,
                status: "active",
                role: "staff",
                user: { isPlatformAdmin: false },
                ...(task.departmentId
                  ? {
                      departmentMemberships: {
                        some: { departmentId: task.departmentId },
                      },
                    }
                  : {}),
              },
            });
            if (eligibleMembershipCount !== data.membershipIds.length) {
              throw new Error(
                "Staff member cannot be assigned because eligibility changed"
              );
            }

            const existingCount = await tx.taskAssignment.count({
              where: {
                taskId: data.taskId,
                membershipId: { in: data.membershipIds },
              },
            });
            if (existingCount > 0) {
              throw new Error(
                "Staff member already has an assignment for this task"
              );
            }

            const assignments = [];
            for (const membershipId of data.membershipIds) {
              assignments.push(
                await tx.taskAssignment.create({
                  data: {
                    taskId: data.taskId,
                    membershipId,
                    assignedById: data.assignedById,
                    status: ASSIGNMENT_STATUSES.ASSIGNED,
                  },
                })
              );
            }
            return assignments;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5_000,
            timeout: 15_000,
          }
        );
      } catch (error) {
        const isWriteConflict =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034";
        if (!isWriteConflict || attempt === maxAttempts) throw error;
      }
    }

    throw new Error("Assignment transaction failed");
  }

  /** Creates every task/member pair in a confirmed schedule as one transaction. */
  async createScheduleAtomic(data: {
    organizationId: string;
    assignments: { taskId: string; membershipId: string }[];
    assignedById: string;
  }) {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await prisma.$transaction(
          async (tx) => {
            const taskIds = [...new Set(data.assignments.map((item) => item.taskId))];
            const membershipIds = [
              ...new Set(data.assignments.map((item) => item.membershipId)),
            ];
            const tasks = await tx.task.findMany({
              where: {
                id: { in: taskIds },
                organizationId: data.organizationId,
                status: "open",
              },
              select: {
                id: true,
                departmentId: true,
                requiredHeadcount: true,
                scheduledStart: true,
                scheduledEnd: true,
              },
            });
            if (tasks.length !== taskIds.length) throw new Error("Task not found");

            const members = await tx.membership.findMany({
              where: {
                id: { in: membershipIds },
                organizationId: data.organizationId,
                status: "active",
                role: "staff",
                user: { isPlatformAdmin: false },
              },
              select: {
                id: true,
                departmentMemberships: { select: { departmentId: true } },
              },
            });
            if (members.length !== membershipIds.length) {
              throw new Error("Schedule contains an invalid staff member");
            }

            const tasksById = new Map(tasks.map((task) => [task.id, task]));
            const membersById = new Map(members.map((member) => [member.id, member]));
            const additionsByTask = new Map<string, number>();
            for (const assignment of data.assignments) {
              const task = tasksById.get(assignment.taskId)!;
              const member = membersById.get(assignment.membershipId)!;
              if (
                task.departmentId &&
                !member.departmentMemberships.some(
                  (department) => department.departmentId === task.departmentId
                )
              ) {
                throw new Error("Schedule contains a staff member outside the task department");
              }
              additionsByTask.set(
                task.id,
                (additionsByTask.get(task.id) ?? 0) + 1
              );
            }

            for (const task of tasks) {
              const activeCount = await tx.taskAssignment.count({
                where: {
                  taskId: task.id,
                  status: { in: SLOT_OCCUPYING_ASSIGNMENT_STATUSES },
                },
              });
              if (
                activeCount + (additionsByTask.get(task.id) ?? 0) >
                task.requiredHeadcount
              ) {
                throw new Error(
                  `Assignment exceeds required headcount of ${task.requiredHeadcount}`
                );
              }
            }

            for (const assignment of data.assignments) {
              const task = tasksById.get(assignment.taskId)!;
              if (!task.scheduledStart || !task.scheduledEnd) {
                throw new Error("Schedule contains an unscheduled task");
              }
              const conflictCount = await tx.taskAssignment.count({
                where: {
                  membershipId: assignment.membershipId,
                  status: { in: SLOT_OCCUPYING_ASSIGNMENT_STATUSES },
                  task: {
                    scheduledStart: { lt: task.scheduledEnd },
                    scheduledEnd: { gt: task.scheduledStart },
                  },
                },
              });
              if (conflictCount > 0) {
                throw new Error(
                  "Staff member cannot be assigned to overlapping tasks"
                );
              }
            }

            const existingCount = await tx.taskAssignment.count({
              where: {
                OR: data.assignments.map((assignment) => ({
                  taskId: assignment.taskId,
                  membershipId: assignment.membershipId,
                })),
              },
            });
            if (existingCount > 0) {
              throw new Error("Staff member already has an assignment for this task");
            }

            const created = [];
            for (const assignment of data.assignments) {
              created.push(
                await tx.taskAssignment.create({
                  data: {
                    ...assignment,
                    assignedById: data.assignedById,
                    status: ASSIGNMENT_STATUSES.ASSIGNED,
                  },
                })
              );
            }
            return created;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5_000,
            timeout: 20_000,
          }
        );
      } catch (error) {
        const isWriteConflict =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034";
        if (!isWriteConflict || attempt === maxAttempts) throw error;
      }
    }

    throw new Error("Schedule confirmation transaction failed");
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

  /** Marks a clocked-out assignment as completed and closes fully completed work. */
  async complete(id: string) {
    return prisma.$transaction(async (tx) => {
      const completed = await tx.taskAssignment.update({
        where: { id },
        data: { status: ASSIGNMENT_STATUSES.COMPLETED },
      });
      const task = await tx.task.findUniqueOrThrow({
        where: { id: completed.taskId },
        select: { id: true, requiredHeadcount: true },
      });
      const assignments = await tx.taskAssignment.findMany({
        where: { taskId: task.id, status: { notIn: ["withdrawn", "cancelled"] } },
        select: { status: true },
      });
      if (assignments.length >= task.requiredHeadcount && assignments.every((assignment) => assignment.status === ASSIGNMENT_STATUSES.COMPLETED)) {
        await tx.task.update({ where: { id: task.id }, data: { status: "completed" } });
      }
      return completed;
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
