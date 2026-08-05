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
import { occupyingStatusFilter } from "@/lib/assignment-status";

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
    /** Serialised JSON; null or absent both mean no constraints. */
    compositionRules?: string | null;
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
        compositionRules: data.compositionRules ?? null,
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
  async findRecurringTemplates(
    organizationId: string,
    /**
     * The caller's departments, or null/undefined for an unscoped caller
     * (a company admin, or the cron job, which has no caller at all).
     *
     * An empty array means "no departments" and matches nothing — never "all".
     * A task with NO department is out of scope for anyone who is scoped, the
     * same rule `TaskService.getByOrganization` applies.
     */
    departmentIds?: string[] | null
  ) {
    return prisma.task.findMany({
      where: {
        organizationId,
        ...(departmentIds != null
          ? { departmentId: { in: departmentIds } }
          : {}),
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
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
      // `requiredHeadcount` because the only caller — confirming an
      // auto-schedule draft — has to bound what it writes against the task's
      // own limit, and the draft it is handed is client-supplied.
      //
      // `compositionRules` so that caller can tell which tasks constrain the
      // MIX of people as well as the number, and load the fuller picture for
      // those alone. It is one column against a set of ids already being read,
      // and the alternative is a second query per task to discover most of them
      // have no rules.
      select: { id: true, requiredHeadcount: true, compositionRules: true },
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
      // `undefined` leaves the rules alone, `null` clears them. Prisma ignores
      // undefined, which is exactly the distinction the API needs: omitting
      // the key on a partial update must not wipe a task's constraints.
      compositionRules?: string | null;
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
   *
   * Counts every assignment that still ties the member to a shift — see
   * `occupiesSlot`. This said "pending or accepted" and meant it, which left a
   * pending withdrawal (and later a pending decline) invisible to the conflict
   * check while the member was still expected to turn up.
   *
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
            status: { in: occupyingStatusFilter() },
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
   * Same rule as `findConflictingTasks` — both now share `occupiesSlot`. They
   * disagreed before: this one counted a pending withdrawal and that one did
   * not, so the eligibility engine and the conflict finder could give different
   * answers about the same member at the same moment.
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
            status: { in: occupyingStatusFilter() },
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