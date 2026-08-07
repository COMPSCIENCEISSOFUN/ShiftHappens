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
  COMMITTED_ASSIGNMENT_STATUSES,
  SLOT_OCCUPYING_ASSIGNMENT_STATUSES,
} from "@/lib/assignment-status";
import {
  dayOfWeekInTimeZone,
  endOfDayInTimeZone,
  localDateInTimeZone,
  startOfDayInTimeZone,
  timeOfDayInTimeZone,
} from "@/lib/timezone";
import {
  normalizeEmploymentType,
  requiresManagedAvailability,
} from "@/lib/role-config";

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
    return prisma.$transaction(async (tx) => {
      const result = await tx.taskAssignment.updateMany({
        where: {
          id,
          status: ASSIGNMENT_STATUSES.ASSIGNED,
          clockInTime: null,
          // Role eligibility is enforced when the assignment is created.
          // If a role changes later, member lifecycle handling cancels the
          // assignment; this transition only needs the member to remain active.
          membership: { status: "active" },
          task: { status: { notIn: ["cancelled", "completed"] } },
        },
        data: { clockInTime: new Date(), status: ASSIGNMENT_STATUSES.IN_PROGRESS },
      });
      if (result.count !== 1) throw new Error("Assignment can no longer be clocked in");
      return tx.taskAssignment.findUniqueOrThrow({ where: { id } });
    }, { isolationLevel: "Serializable" });
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
                id: true,
                organizationId: true,
                departmentId: true,
                requiredHeadcount: true,
                status: true,
                scheduledStart: true,
                scheduledEnd: true,
                requiredCertifications: true,
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

            const eligibleMemberships = await tx.membership.findMany({
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
              include: {
                user: { select: { isPlatformAdmin: true } },
                departmentMemberships: { select: { departmentId: true } },
                availabilities: true,
                availabilityOverrides: true,
                certifications: true,
              },
            });
            if (eligibleMemberships.length !== data.membershipIds.length) {
              throw new Error(
                "Staff member cannot be assigned because eligibility changed"
              );
            }

            await this.assertFinalEligibility(
              tx,
              task,
              eligibleMemberships,
              data.organizationId
            );

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

  /**
   * Re-evaluates every mutable eligibility input on the same serializable
   * snapshot that creates the assignments. Candidate screens remain advisory;
   * this is the authoritative gate.
   */
  private async assertFinalEligibility(
    tx: Prisma.TransactionClient,
    task: {
      id: string;
      organizationId: string;
      departmentId: string | null;
      status: string;
      scheduledStart: Date | null;
      scheduledEnd: Date | null;
      requiredCertifications: string[];
    },
    memberships: Array<{
      id: string;
      role: string;
      employmentType: string | null;
      customRoleId: string | null;
      departmentMemberships: { departmentId: string }[];
      availabilities: { dayOfWeek: number; startTime: string; endTime: string; isAvailable: boolean }[];
      availabilityOverrides: { date: Date; isAvailable: boolean }[];
      certifications: { name: string; status: string; expiryDate: Date | null }[];
    }>,
    organizationId: string
  ) {
    if (task.status !== "open") throw new Error("Task is no longer open");
    const membershipIds = memberships.map((membership) => membership.id);
    const [settings, rules, assignments, activeOverrides] = await Promise.all([
      tx.companySettings.findUnique({ where: { organizationId } }),
      tx.workRule.findMany({ where: { organizationId, isActive: true } }),
      tx.taskAssignment.findMany({
        where: {
          membershipId: { in: membershipIds },
          taskId: { not: task.id },
          status: { in: COMMITTED_ASSIGNMENT_STATUSES },
        },
        select: {
          membershipId: true,
          clockInTime: true,
          clockOutTime: true,
          task: { select: { title: true, scheduledStart: true, scheduledEnd: true } },
        },
      }),
      tx.eligibilityOverride.findMany({
        where: {
          taskId: task.id,
          membershipId: { in: membershipIds },
          ruleOverridden: "availability",
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { membershipId: true },
      }),
    ]);
    const availabilityWaivers = new Set(activeOverrides.map((item) => item.membershipId));
    const now = new Date();

    for (const member of memberships) {
      const committed = assignments.filter((item) => item.membershipId === member.id);
      if (task.scheduledStart && task.scheduledEnd) {
        const conflict = committed.find(
          (item) =>
            item.task.scheduledStart &&
            item.task.scheduledEnd &&
            item.task.scheduledStart < task.scheduledEnd! &&
            item.task.scheduledEnd > task.scheduledStart!
        );
        if (conflict) throw new Error(`Staff member conflicts with ${conflict.task.title}`);

        if (requiresManagedAvailability(normalizeEmploymentType(member.employmentType))) {
          const dateKey = `${localDateInTimeZone(task.scheduledStart)}T00:00:00.000Z`;
          const dateOverride = member.availabilityOverrides.find(
            (item) => item.date.toISOString() === dateKey
          );
          let available = dateOverride?.isAvailable;
          if (available === undefined) {
            const day = dayOfWeekInTimeZone(task.scheduledStart);
            const previousDay = (day + 6) % 7;
            const startTime = timeOfDayInTimeZone(task.scheduledStart);
            const endTime = timeOfDayInTimeZone(task.scheduledEnd);
            available = member.availabilities.some((window) => {
              if (!window.isAvailable) return false;
              if (window.dayOfWeek === day) {
                return window.startTime < window.endTime
                  ? startTime >= window.startTime && endTime <= window.endTime && endTime > startTime
                  : startTime >= window.startTime && endTime <= window.endTime;
              }
              return (
                window.dayOfWeek === previousDay &&
                window.startTime >= window.endTime &&
                startTime < endTime &&
                endTime <= window.endTime
              );
            });
          }
          if (!available && !availabilityWaivers.has(member.id)) {
            throw new Error("Staff member is unavailable for this task");
          }
        }
      }

      const required = new Set(
        task.requiredCertifications.map((name) => name.trim().toLowerCase())
      );
      const held = new Set(
        member.certifications
          .filter(
            (certification) =>
              certification.status === "verified" &&
              (!certification.expiryDate || certification.expiryDate > now)
          )
          .map((certification) => certification.name.trim().toLowerCase())
      );
      if ([...required].some((name) => !held.has(name))) {
        throw new Error("Staff member is missing a required certification");
      }

      const intervalHours = (start: Date, end: Date) =>
        committed.reduce((total, item) => {
          const intervalStart = item.clockInTime ?? item.task.scheduledStart;
          const intervalEnd =
            item.clockInTime && item.clockOutTime
              ? item.clockOutTime
              : item.task.scheduledEnd;
          if (!intervalStart || !intervalEnd) return total;
          const overlapStart = Math.max(start.getTime(), intervalStart.getTime());
          const overlapEnd = Math.min(end.getTime(), intervalEnd.getTime());
          return total + Math.max(0, overlapEnd - overlapStart) / 3_600_000;
        }, 0);
      const rollingHours = intervalHours(
        new Date(now.getTime() - 24 * 60 * 60 * 1000),
        now
      );
      if (settings && rollingHours >= settings.breakRuleHoursWorked) {
        throw new Error("Staff member has reached the rolling hours limit");
      }

      if (task.scheduledStart && task.scheduledEnd) {
        const duration =
          (task.scheduledEnd.getTime() - task.scheduledStart.getTime()) / 3_600_000;
        const departments = new Set(
          member.departmentMemberships.map((item) => item.departmentId)
        );
        for (const rule of rules) {
          if (rule.departmentId && !departments.has(rule.departmentId)) continue;
          if (rule.roleId && member.customRoleId !== rule.roleId) continue;
          if (rule.type === "break_interval" && rule.hoursThreshold && rollingHours >= rule.hoursThreshold) {
            throw new Error(`Staff member violates work rule: ${rule.name}`);
          }
          if (rule.type === "max_hours_daily" && rule.maxHours) {
            const total = intervalHours(
              startOfDayInTimeZone(task.scheduledStart),
              endOfDayInTimeZone(task.scheduledStart)
            ) + duration;
            if (total > rule.maxHours) throw new Error(`Staff member violates work rule: ${rule.name}`);
          }
          if (rule.type === "max_hours_weekly" && rule.maxHours) {
            const day = dayOfWeekInTimeZone(task.scheduledStart);
            const diff = day === 0 ? -6 : 1 - day;
            const weekStart = startOfDayInTimeZone(
              new Date(task.scheduledStart.getTime() + diff * 86_400_000)
            );
            const total = intervalHours(
              weekStart,
              new Date(weekStart.getTime() + 7 * 86_400_000)
            ) + duration;
            if (total > rule.maxHours) throw new Error(`Staff member violates work rule: ${rule.name}`);
          }
        }
      }
    }
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
                organizationId: true,
                departmentId: true,
                requiredHeadcount: true,
                status: true,
                scheduledStart: true,
                scheduledEnd: true,
                requiredCertifications: true,
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
              include: {
                departmentMemberships: { select: { departmentId: true } },
                availabilities: true,
                availabilityOverrides: true,
                certifications: true,
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
              const selectedMembers = data.assignments
                .filter((assignment) => assignment.taskId === task.id)
                .map((assignment) => membersById.get(assignment.membershipId)!);
              await this.assertFinalEligibility(
                tx,
                task,
                selectedMembers,
                data.organizationId
              );
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
              const overlappingDraft = data.assignments.some((other) => {
                if (
                  other === assignment ||
                  other.membershipId !== assignment.membershipId
                ) return false;
                const otherTask = tasksById.get(other.taskId)!;
                return Boolean(
                  otherTask.scheduledStart &&
                  otherTask.scheduledEnd &&
                  otherTask.scheduledStart < task.scheduledEnd! &&
                  otherTask.scheduledEnd > task.scheduledStart!
                );
              });
              if (overlappingDraft) {
                throw new Error("Schedule contains overlapping assignments");
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
    return prisma.$transaction(async (tx) => {
      const result = await tx.taskAssignment.updateMany({
        where: {
          id,
          status: ASSIGNMENT_STATUSES.IN_PROGRESS,
          clockInTime: { not: null },
          clockOutTime: null,
        },
        data: { clockOutTime: new Date(), status: ASSIGNMENT_STATUSES.CLOCKED_OUT },
      });
      if (result.count !== 1) throw new Error("Assignment can no longer be clocked out");
      return tx.taskAssignment.findUniqueOrThrow({ where: { id } });
    }, { isolationLevel: "Serializable" });
  }

  /** Marks a clocked-out assignment as completed and closes fully completed work. */
  async complete(id: string) {
    return prisma.$transaction(async (tx) => {
      const result = await tx.taskAssignment.updateMany({
        where: { id, status: ASSIGNMENT_STATUSES.CLOCKED_OUT },
        data: { status: ASSIGNMENT_STATUSES.COMPLETED },
      });
      if (result.count !== 1) throw new Error("Assignment can no longer be completed");
      const completed = await tx.taskAssignment.findUniqueOrThrow({ where: { id } });
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
    const result = await prisma.taskAssignment.updateMany({
      where: {
        id,
        status: statusBeforeRequest,
        task: { status: { notIn: ["cancelled", "completed"] } },
      },
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
    if (result.count !== 1) throw new Error("Assignment can no longer be withdrawn from");
    return prisma.taskAssignment.findUniqueOrThrow({ where: { id } });
  }

  /** Manager approves a withdrawal request while preserving the work record. */
  async approveWithdrawal(id: string, reviewerUserId: string) {
    return prisma.$transaction(async (tx) => {
      const assignment = await tx.taskAssignment.findUnique({ where: { id } });
      if (!assignment || assignment.status !== ASSIGNMENT_STATUSES.WITHDRAWAL_REQUESTED) {
        throw new Error("No pending withdrawal request for this assignment");
      }
      const now = new Date();
      const result = await tx.taskAssignment.updateMany({
        where: { id, status: ASSIGNMENT_STATUSES.WITHDRAWAL_REQUESTED },
        data: {
          status: ASSIGNMENT_STATUSES.WITHDRAWN,
          withdrawalReviewedAt: now,
          withdrawalReviewedById: reviewerUserId,
          withdrawalDecision: "approved",
          ...(assignment.clockInTime && !assignment.clockOutTime ? { clockOutTime: now } : {}),
        },
      });
      if (result.count !== 1) throw new Error("Withdrawal request was already resolved");
      return tx.taskAssignment.findUniqueOrThrow({ where: { id } });
    }, { isolationLevel: "Serializable" });
  }

  /** Manager denies a withdrawal request; assignment returns to its active path. */
  async denyWithdrawal(id: string, reviewerUserId: string) {
    return prisma.$transaction(async (tx) => {
      const assignment = await tx.taskAssignment.findUnique({ where: { id } });
      if (!assignment || assignment.status !== ASSIGNMENT_STATUSES.WITHDRAWAL_REQUESTED) {
        throw new Error("No pending withdrawal request for this assignment");
      }
      const nextStatus = assignment.withdrawalStatusBeforeRequest ?? ASSIGNMENT_STATUSES.ASSIGNED;
      const result = await tx.taskAssignment.updateMany({
        where: { id, status: ASSIGNMENT_STATUSES.WITHDRAWAL_REQUESTED },
        data: {
          status: nextStatus,
          withdrawalReviewedAt: new Date(),
          withdrawalReviewedById: reviewerUserId,
          withdrawalDecision: "denied",
        },
      });
      if (result.count !== 1) throw new Error("Withdrawal request was already resolved");
      return tx.taskAssignment.findUniqueOrThrow({ where: { id } });
    }, { isolationLevel: "Serializable" });
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
  async cancel(id: string, cancelledById?: string, reason = "Removed by manager") {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.taskAssignment.findUnique({ where: { id } });
      if (
        !existing ||
        ["completed", "withdrawn", "cancelled"].includes(existing.status)
      ) {
        throw new Error("Assignment can no longer be cancelled");
      }
      const now = new Date();
      return tx.taskAssignment.update({
        where: { id },
        data: {
          status: ASSIGNMENT_STATUSES.CANCELLED,
          cancelledAt: now,
          cancelledById,
          cancellationReason: reason,
          ...(existing.clockInTime && !existing.clockOutTime
            ? { clockOutTime: now }
            : {}),
        },
      });
    }, { isolationLevel: "Serializable" });
  }
}
