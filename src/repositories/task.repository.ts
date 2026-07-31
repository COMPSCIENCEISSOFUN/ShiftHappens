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

export class TaskRepository {
  /** Creates a new task within an organization */
  async create(data: {
    title: string;
    description?: string;
    organizationId: string;
    departmentId?: string;
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
        organizationId: data.organizationId,
        departmentId: data.departmentId,
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
        createdBy: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Lists tasks for an organization with optional filters.
   * Supports filtering by status, departmentId, and priority.
   */
  async findByOrganizationId(organizationId: string, filters?: { status?: string; departmentId?: string; priority?: string }) {
    return prisma.task.findMany({
      where: {
        organizationId,
        ...(filters?.status && { status: filters.status }),
        ...(filters?.departmentId && { departmentId: filters.departmentId }),
        ...(filters?.priority && { priority: filters.priority }),
      },
      include: {
        department: { select: { id: true, name: true, color: true } },
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
  /**
   * Returns the subset of the given task ids that belong to this organisation.
   *
   * Used to validate caller-supplied id lists in one query instead of N, so a
   * batch operation can refuse cross-tenant rows without a per-row round trip.
   */
  /**
   * A task's departmentId for scope checks: `undefined` when the task does not
   * exist, `null` when it exists with no department. The caller must be able to
   * tell those apart — a missing task is refused, a department-less task is
   * refused only for a scoped member.
   */
  async getDepartmentId(id: string): Promise<string | null | undefined> {
    const task = await prisma.task.findUnique({
      where: { id },
      select: { departmentId: true },
    });
    return task === null ? undefined : task.departmentId;
  }

  async findManyByIdsInOrg(ids: string[], organizationId: string) {
    if (ids.length === 0) return [];
    return prisma.task.findMany({
      where: { id: { in: ids }, organizationId },
      select: { id: true },
    });
  }

  async update(
    id: string,
    data: {
      title?: string;
      description?: string;
      departmentId?: string | null;
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
  async delete(id: string) {
    return prisma.task.delete({ where: { id } });
  }

  /**
   * Finds tasks that conflict with a given time range for a specific member.
   * Used for scheduling conflict detection (US-38).
   * Only considers active assignments (pending or accepted).
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
            status: { in: ["pending", "accepted"] },
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

  /**
   * The task row on its own, with no relations loaded.
   *
   * The eligibility engine reads only the task's own columns (org, department,
   * schedule, required certifications) and runs once per candidate list, so it
   * must not pay for `findById`'s assignment/membership/user joins.
   */
  async findByIdWithoutRelations(id: string) {
    return prisma.task.findUnique({ where: { id } });
  }

  /**
   * The owning organisation and title of a task, for callers that must
   * tenant-check before writing and then name the task in an audit entry.
   * Kept to two columns so the check stays cheap enough to always run.
   */
  async findOrgAndTitleById(id: string) {
    return prisma.task.findUnique({
      where: { id },
      select: { organizationId: true, title: true },
    });
  }

  /**
   * Titles of the tasks a member is already committed to that overlap a time
   * window — what the eligibility engine reports back as the clash.
   *
   * Unlike `findConflictingTasks`, a pending withdrawal request still counts:
   * the slot stays reserved until a manager resolves it, so double-booking
   * over it would hand the member two shifts at once if the request is denied.
   */
  async findConflictingTaskTitles(
    membershipId: string,
    scheduledStart: Date,
    scheduledEnd: Date,
    excludeTaskId: string
  ) {
    return prisma.task.findMany({
      where: {
        assignments: {
          some: {
            membershipId,
            status: { in: ["pending", "accepted", "withdrawal_requested"] },
          },
        },
        scheduledStart: { lt: scheduledEnd },
        scheduledEnd: { gt: scheduledStart },
        id: { not: excludeTaskId },
      },
      select: { title: true },
    });
  }
}