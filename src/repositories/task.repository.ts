/**
 * Task Repository (Entity Layer)
 * 
 * Data access layer for Task model operations.
 * Supports CRUD, filtering by status/department/priority,
 * and scheduling conflict detection for assignments.
 * 
 * All queries are org-scoped for multi-tenant isolation.
 * Security: Prisma parameterized queries prevent SQL injection.
 * 
 * Note: Every department select MUST include color: true
 * for calendar view and any UI that shows department colors.
 */
import { prisma } from "@/lib/prisma";
import { SLOT_OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/assignment-status";

export class TaskRepository {
  /** Creates a new task within an organization */
  async create(data: {
    title: string;
    description?: string;
    location?: string;
    instructions?: string;
    organizationId: string;
    departmentId?: string;
    projectId?: string;
    requiredHeadcount?: number;
    requiredCertifications?: string[];
    priority?: string;
    scheduledStart?: Date;
    scheduledEnd?: Date;
    isRecurring?: boolean;
    recurringPattern?: string;
    parentTaskId?: string;
    createdById: string;
  }) {
    return prisma.task.create({
      data: {
        title: data.title,
        description: data.description,
        location: data.location,
        instructions: data.instructions,
        organizationId: data.organizationId,
        departmentId: data.departmentId,
        projectId: data.projectId,
        requiredHeadcount: data.requiredHeadcount ?? 1,
        requiredCertifications: data.requiredCertifications ?? [],
        priority: data.priority ?? "medium",
        scheduledStart: data.scheduledStart,
        scheduledEnd: data.scheduledEnd,
        isRecurring: data.isRecurring ?? false,
        recurringPattern: data.recurringPattern,
        parentTaskId: data.parentTaskId,
        createdById: data.createdById,
      },
      include: {
        assignments: true,
        department: { select: { id: true, name: true, color: true } },
        project: { select: { id: true, title: true, status: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Finds the series templates in an org: recurring tasks that are themselves
   * the first occurrence (no parent), still active, and actually schedulable.
   * These are the tasks the generator expands into future instances.
   */
  async findRecurringTemplates(organizationId: string) {
    return prisma.task.findMany({
      where: {
        organizationId,
        isRecurring: true,
        parentTaskId: null,
        status: { notIn: ["cancelled", "completed"] },
        recurringPattern: { not: null },
        scheduledStart: { not: null },
        scheduledEnd: { not: null },
      },
    });
  }

  /**
   * Start times of every instance already generated for a series.
   * Used to make generation idempotent — re-running never duplicates.
   */
  async findInstanceStarts(parentTaskId: string): Promise<Date[]> {
    const rows = await prisma.task.findMany({
      where: { parentTaskId },
      select: { scheduledStart: true },
    });
    return rows
      .map((r) => r.scheduledStart)
      .filter((d): d is Date => d !== null);
  }

  /** Finds a task by ID with assignments and related data */
  async findById(id: string) {
    return prisma.task.findUnique({
      where: { id },
      include: {
        assignments: {
          include: {
            membership: {
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
            assignedBy: { select: { id: true, name: true } },
          },
        },
        department: { select: { id: true, name: true, color: true } },
        project: { select: { id: true, title: true, status: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Lists tasks for an organization with optional filters.
   * Supports filtering by status, departmentId, and priority.
   */
  async findByOrganizationId(
    organizationId: string,
    filters?: {
      status?: string;
      departmentId?: string;
      priority?: string;
      projectId?: string;
      departmentIds?: string[];
    },
    pagination?: { limit: number; offset: number }
  ) {
    return prisma.task.findMany({
      where: {
        organizationId,
        ...(filters?.status && {
          status: filters.status,
        }),
        ...(filters?.departmentId && {
          departmentId: filters.departmentId,
        }),
        ...(filters?.priority && {
          priority: filters.priority,
        }),
        ...(filters?.projectId && {
          projectId: filters.projectId,
        }),
        ...(filters?.departmentIds && {
          departmentId: { in: filters.departmentIds },
        }),
      },
      include: {
        department: { select: { id: true, name: true, color: true } },
        project: { select: { id: true, title: true, status: true } },
        createdBy: { select: { id: true, name: true } },
        assignments: {
          include: {
            membership: {
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      ...(pagination ? { take: pagination.limit, skip: pagination.offset } : {}),
    });
  }

  async countByOrganizationId(
    organizationId: string,
    filters?: {
      status?: string;
      departmentId?: string;
      priority?: string;
      projectId?: string;
      departmentIds?: string[];
    }
  ) {
    return prisma.task.count({
      where: {
        organizationId,
        ...(filters?.status && {
          status: filters.status,
        }),
        ...(filters?.departmentId && {
          departmentId: filters.departmentId,
        }),
        ...(filters?.priority && {
          priority: filters.priority,
        }),
        ...(filters?.projectId && {
          projectId: filters.projectId,
        }),
        ...(filters?.departmentIds && {
          departmentId: { in: filters.departmentIds },
        }),
      },
    });
  }

  /** Lists tasks for a specific department (manager view) */
  async findByDepartmentId(departmentId: string) {
    return prisma.task.findMany({
      where: { departmentId },
      include: {
        assignments: {
          include: {
            membership: {
              include: {
                user: { select: { id: true, name: true } },
              },
            },
          },
        },
        department: { select: { id: true, name: true, color: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Updates a task's fields */
  async update(
    id: string,
    data: {
      title?: string;
      description?: string;
      location?: string | null;
      instructions?: string | null;
      departmentId?: string;
      requiredHeadcount?: number;
      requiredCertifications?: string[];
      priority?: string;
      status?: string;
      scheduledStart?: Date | null;
      scheduledEnd?: Date | null;
    }
  ) {
    return prisma.task.update({
      where: { id },
      data,
      include: {
        assignments: true,
        department: { select: { id: true, name: true, color: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
  }

  /** Deletes a task — cascade deletes assignments */
  async cancel(
    id: string,
    data: Parameters<TaskRepository["update"]>[1] = {},
    cancelledById?: string,
    reason: string = "Task cancelled"
  ) {
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.taskAssignment.updateMany({
        where: {
          taskId: id,
          status: { notIn: ["completed", "withdrawn", "cancelled"] },
          clockInTime: { not: null },
          clockOutTime: null,
        },
        data: {
          status: "cancelled",
          clockOutTime: now,
          cancelledAt: now,
          cancelledById,
          cancellationReason: reason,
        },
      });
      await tx.taskAssignment.updateMany({
        where: {
          taskId: id,
          status: { notIn: ["completed", "withdrawn", "cancelled"] },
        },
        data: {
          status: "cancelled",
          cancelledAt: now,
          cancelledById,
          cancellationReason: reason,
        },
      });
      return tx.task.update({
        where: { id },
        data: { ...data, status: "cancelled" },
        include: {
          assignments: true,
          department: { select: { id: true, name: true, color: true } },
          createdBy: { select: { id: true, name: true } },
        },
      });
    }, { isolationLevel: "Serializable" });
  }

  /**
   * Finds tasks that conflict with a given time range for a specific member.
   * Used for scheduling conflict detection (US-38).
   * Only considers active slot-occupying assignments.
   * Excludes optional taskId to allow checking conflicts for updates.
   */
  async findConflictingTasks(
    membershipId: string,
    scheduledStart: Date,
    scheduledEnd: Date,
    excludeTaskId?: string
  ) {
    return prisma.task.findMany({
      where: {
        assignments: {
          some: {
            membershipId,
            status: { in: SLOT_OCCUPYING_ASSIGNMENT_STATUSES },
          },
        },
        scheduledStart: { lt: scheduledEnd },
        scheduledEnd: { gt: scheduledStart },
        ...(excludeTaskId && { id: { not: excludeTaskId } }),
      },
      include: {
        department: { select: { id: true, name: true, color: true } },
      },
    });
  }
}
