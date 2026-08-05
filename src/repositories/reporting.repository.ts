/**
 * Reporting Repository (Entity Layer)
 *
 * Data access layer for dashboard reporting and analytics queries.
 * Provides focused, efficient queries for metrics, alerts, and
 * visualizations across all three role-specific dashboard views
 * (Company Admin, Manager, Staff).
 *
 * Design principles:
 * - One query per method (no N+1 loops)
 * - Minimal data selected (only fields needed by the caller)
 * - All queries org-scoped for multi-tenant isolation
 * - Optional departmentIds enables manager-scoped filtering
 * - Raw data returned; business logic computed in ReportingService
 *
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { prisma } from "@/lib/prisma";
import { occupyingStatusFilter } from "@/lib/assignment-status";

/**
 * A membership filter for a caller who may be limited to some departments.
 *
 * `undefined` means unrestricted (company admin). An ARRAY is the caller's own
 * departments, and an empty one therefore means "no departments" — matching
 * nothing — never "all departments". Getting that distinction the wrong way
 * round is the difference between a manager seeing nothing and a manager
 * seeing the whole organisation.
 */
function departmentScopedMembership(
  organizationId: string,
  departmentIds?: string[]
) {
  return departmentIds != null
    ? {
        organizationId,
        departmentMemberships: {
          some: { departmentId: { in: departmentIds } },
        },
      }
    : { organizationId };
}

// ============================================================
// Return type interfaces
// ============================================================

/** Raw completion timestamp for daily grouping in service layer */
export interface CompletionTimestamp {
  completedAt: Date;
}

/** Clock-in/out record for utilization calculation */
export interface ClockDataRecord {
  membershipId: string;
  staffName: string;
  staffEmail: string;
  clockInTime: Date;
  clockOutTime: Date;
}

/** Task with insufficient staff assigned */
export interface UnderstaffedTaskRecord {
  id: string;
  title: string;
  requiredHeadcount: number;
  assignedCount: number;
  departmentName: string | null;
  departmentColor: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
}

/** Pending assignment awaiting staff response */
export interface PendingAssignmentRecord {
  id: string;
  taskId: string;
  taskTitle: string;
  staffName: string;
  staffEmail: string;
  membershipId: string;
  createdAt: Date;
}

/** Certification approaching expiry */
export interface ExpiringCertRecord {
  id: string;
  certName: string;
  staffName: string;
  staffEmail: string;
  membershipId: string;
  expiryDate: Date;
}

/** Certification awaiting admin verification */
export interface PendingCertVerificationRecord {
  id: string;
  certName: string;
  staffName: string;
  staffEmail: string;
  membershipId: string;
  submittedAt: Date;
}

/** Assignment count grouped by status */
export interface AssignmentStatusCount {
  status: string;
  count: number;
}

/** Individual rejection record with staff and reason details */
export interface RejectionRecord {
  membershipId: string;
  /** The person, not the membership — follow-up actions address a user. */
  userId: string;
  staffName: string;
  staffEmail: string;
  rejectionReason: string | null;
  rejectionNotes: string | null;
}

/** Task scheduled within a date range with assignment breakdown */
export interface ScheduledTaskRecord {
  id: string;
  title: string;
  status: string;
  requiredHeadcount: number;
  assignedCount: number;
  acceptedCount: number;
  departmentName: string | null;
  departmentColor: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
}

/** Department with active task and staff member counts */
export interface DepartmentMetricRecord {
  id: string;
  name: string;
  color: string;
  activeTaskCount: number;
  staffCount: number;
}

/** Team member with today's shift context for manager roster */
export interface TeamMemberRecord {
  membershipId: string;
  staffName: string;
  staffEmail: string;
  todayAssignments: {
    status: string;
    taskTitle: string;
    scheduledStart: Date | null;
    scheduledEnd: Date | null;
  }[];
  availability: {
    isAvailable: boolean;
    startTime: string;
    endTime: string;
  } | null;
  pendingCount: number;
}

/** Staff assignment for personal calendar view */
export interface StaffAssignmentRecord {
  id: string;
  status: string;
  taskId: string;
  taskTitle: string;
  departmentName: string | null;
  departmentColor: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  clockInTime: Date | null;
  clockOutTime: Date | null;
}

/** Staff certification for personal dashboard */
export interface StaffCertRecord {
  id: string;
  name: string;
  status: string;
  expiryDate: Date | null;
  issuedDate: Date;
}

/** Staff weekly availability entry */
export interface StaffAvailabilityRecord {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

/** Active staff member identity for utilization calculations */
export interface ActiveStaffMember {
  membershipId: string;
  name: string;
  email: string;
}

/** Raw assignment data for computing personal stats in service */
export interface StaffAssignmentStatRecord {
  status: string;
  clockInTime: Date | null;
  scheduledStart: Date | null;
  createdAt: Date;
}

/**
 * One thing a staff member wrote, with just enough around it to be read.
 *
 * No name — see `getFeedbackText`.
 */
export interface FeedbackSnippet {
  kind: "rating" | "decline" | "withdrawal";
  /** Verbatim, trimmed. Never rewritten. */
  text: string;
  /** The structured value beside the text: "rated 2/5", or a decline reason. */
  label: string | null;
  departmentName: string | null;
  taskTitle: string;
  at: Date;
}

// ============================================================
// Repository
// ============================================================

export class ReportingRepository {
  // ===== Completion Metrics =====

  /**
   * Fetches completed assignment timestamps within a date range.
   * Used for daily completion trend chart (service groups by day).
   * Single query replaces N individual count queries.
   */
  async getCompletionTimestamps(
    organizationId: string,
    startDate: Date,
    endDate: Date,
    departmentIds?: string[]
  ): Promise<CompletionTimestamp[]> {
    const records = await prisma.taskAssignment.findMany({
      where: {
        task: {
          organizationId,
          ...(departmentIds != null
            ? { departmentId: { in: departmentIds } }
            : {}),
        },
        status: "completed",
        clockOutTime: {
          gte: startDate,
          lt: endDate,
        },
      },
      select: { clockOutTime: true },
    });

    return records
      .filter(
        (r): r is { clockOutTime: Date } => r.clockOutTime !== null
      )
      .map((r) => ({ completedAt: r.clockOutTime }));
  }

  /**
   * Counts total completions within a date range.
   * Used for week-over-week completion rate comparison.
   */
  async countCompletions(
    organizationId: string,
    startDate: Date,
    endDate: Date,
    departmentIds?: string[]
  ): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        task: {
          organizationId,
          ...(departmentIds != null
            ? { departmentId: { in: departmentIds } }
            : {}),
        },
        status: "completed",
        clockOutTime: {
          gte: startDate,
          lt: endDate,
        },
      },
    });
  }

  // ===== Staff & Utilization =====

  /**
   * Fetches clock-in/out records for completed assignments.
   * Service layer groups by staff and computes hours/utilization.
   */
  async getClockData(
    organizationId: string,
    since: Date,
    departmentIds?: string[]
  ): Promise<ClockDataRecord[]> {
    const records = await prisma.taskAssignment.findMany({
      where: {
        task: {
          organizationId,
          ...(departmentIds != null
            ? { departmentId: { in: departmentIds } }
            : {}),
        },
        status: { in: ["clocked_out", "completed"] },
        clockInTime: { gte: since },
        clockOutTime: { not: null },
      },
      select: {
        membershipId: true,
        clockInTime: true,
        clockOutTime: true,
        membership: {
          select: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    return records
      .filter(
        (r): r is typeof r & { clockInTime: Date; clockOutTime: Date } =>
          r.clockInTime !== null && r.clockOutTime !== null
      )
      .map((r) => ({
        membershipId: r.membershipId,
        staffName: r.membership.user.name || r.membership.user.email,
        staffEmail: r.membership.user.email,
        clockInTime: r.clockInTime,
        clockOutTime: r.clockOutTime,
      }));
  }

  /**
   * Counts active staff and manager members in the organization.
   * Optionally filtered by department membership for manager scope.
   */
  async getActiveStaffCount(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<number> {
    return prisma.membership.count({
      where: {
        organizationId,
        status: "active",
        role: { in: ["staff", "manager"] },
        ...(departmentIds != null
          ? {
              departmentMemberships: {
                some: { departmentId: { in: departmentIds } },
              },
            }
          : {}),
      },
    });
  }

  /**
   * Gets active staff/manager members with basic identity info.
   * Used for utilization chart (includes staff with 0 hours worked).
   * Optionally filtered by department for manager scope.
   */
  async getActiveStaffList(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<ActiveStaffMember[]> {
    const members = await prisma.membership.findMany({
      where: {
        organizationId,
        status: "active",
        role: { in: ["staff", "manager"] },
        ...(departmentIds != null
          ? {
              departmentMemberships: {
                some: { departmentId: { in: departmentIds } },
              },
            }
          : {}),
      },
      select: {
        id: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: { user: { name: "asc" } },
    });

    return members.map((m) => ({
      membershipId: m.id,
      name: m.user.name || m.user.email,
      email: m.user.email,
    }));
  }

  /**
   * Gets department IDs for a membership.
   * Used by the dashboard API route to scope manager views.
   */
  async getMemberDepartmentIds(
    membershipId: string
  ): Promise<string[]> {
    const records = await prisma.departmentMembership.findMany({
      where: { membershipId },
      select: { departmentId: true },
    });
    return records.map((r) => r.departmentId);
  }

  /**
   * Gets team members with today's assignments and availability.
   * Used for manager's team roster with shift status badges.
   * Date parameters allow the service to define "today" boundaries.
   */
  async getTeamMembers(
    organizationId: string,
    departmentIds: string[],
    todayStart: Date,
    todayEnd: Date,
    dayOfWeek: number
  ): Promise<TeamMemberRecord[]> {
    const members = await prisma.membership.findMany({
      where: {
        organizationId,
        status: "active",
        role: { in: ["staff", "manager"] },
        departmentMemberships: {
          some: { departmentId: { in: departmentIds } },
        },
      },
      select: {
        id: true,
        user: { select: { name: true, email: true } },
        taskAssignments: {
          where: {
            // Everything that still puts them on a shift today, including a
            // decision waiting on a manager — they are expected to turn up
            // until it is resolved, so the roster has to show them.
            status: { in: occupyingStatusFilter() },
            task: {
              scheduledStart: { lt: todayEnd },
              scheduledEnd: { gt: todayStart },
            },
          },
          select: {
            status: true,
            task: {
              select: {
                title: true,
                scheduledStart: true,
                scheduledEnd: true,
              },
            },
          },
        },
        availabilities: {
          where: { dayOfWeek },
          select: { isAvailable: true, startTime: true, endTime: true },
        },
      },
      orderBy: { user: { name: "asc" } },
    });

    return members.map((m) => ({
      membershipId: m.id,
      staffName: m.user.name || m.user.email,
      staffEmail: m.user.email,
      todayAssignments: m.taskAssignments.map((a) => ({
        status: a.status,
        taskTitle: a.task.title,
        scheduledStart: a.task.scheduledStart,
        scheduledEnd: a.task.scheduledEnd,
      })),
      availability: m.availabilities[0]
        ? {
            isAvailable: m.availabilities[0].isAvailable,
            startTime: m.availabilities[0].startTime,
            endTime: m.availabilities[0].endTime,
          }
        : null,
      pendingCount: m.taskAssignments.filter((a) => a.status === "pending")
        .length,
    }));
  }

  // ===== Task Metrics =====

  /**
   * Gets tasks where active assignment count < requiredHeadcount.
   * Only considers open/in-progress tasks with pending/accepted assignments.
   * Filtering happens in-code after fetch (Prisma lacks HAVING clause).
   */
  async getUnderstaffedTasks(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<UnderstaffedTaskRecord[]> {
    const tasks = await prisma.task.findMany({
      where: {
        organizationId,
        status: { in: ["open", "in_progress"] },
        ...(departmentIds != null
          ? { departmentId: { in: departmentIds } }
          : {}),
      },
      select: {
        id: true,
        title: true,
        requiredHeadcount: true,
        scheduledStart: true,
        scheduledEnd: true,
        department: { select: { name: true, color: true } },
        assignments: {
          // Was ["pending", "accepted"]. That omitted withdrawal_requested,
          // whose whole purpose is to hold the slot while a manager decides —
          // so a shift nobody had actually left was reported as needing a
          // replacement, and the engine would offer it to someone else while
          // the original assignee was still expected to turn up.
          where: { status: { in: occupyingStatusFilter() } },
          select: { id: true },
        },
      },
    });

    return tasks
      .filter((t) => t.assignments.length < t.requiredHeadcount)
      .map((t) => ({
        id: t.id,
        title: t.title,
        requiredHeadcount: t.requiredHeadcount,
        assignedCount: t.assignments.length,
        departmentName: t.department?.name ?? null,
        departmentColor: t.department?.color ?? null,
        scheduledStart: t.scheduledStart,
        scheduledEnd: t.scheduledEnd,
      }));
  }

  /**
   * Gets tasks scheduled within a date range with assignment counts.
   * Used for "tomorrow's schedule" and date-range displays.
   * Tasks are ordered by scheduled start time ascending.
   */
  async getTasksForDateRange(
    organizationId: string,
    startDate: Date,
    endDate: Date,
    departmentIds?: string[]
  ): Promise<ScheduledTaskRecord[]> {
    const tasks = await prisma.task.findMany({
      where: {
        organizationId,
        status: { in: ["open", "in_progress"] },
        scheduledStart: { lt: endDate },
        scheduledEnd: { gt: startDate },
        ...(departmentIds != null
          ? { departmentId: { in: departmentIds } }
          : {}),
      },
      select: {
        id: true,
        title: true,
        status: true,
        requiredHeadcount: true,
        scheduledStart: true,
        scheduledEnd: true,
        department: { select: { name: true, color: true } },
        assignments: {
          // Headcount, so the shared rule. A shift in progress has people
          // clocked in on it; counting only pending and accepted made it look
          // as though they had left.
          where: { status: { in: occupyingStatusFilter() } },
          select: { id: true, status: true },
        },
      },
      orderBy: { scheduledStart: "asc" },
    });

    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      requiredHeadcount: t.requiredHeadcount,
      assignedCount: t.assignments.length,
      acceptedCount: t.assignments.filter((a) => a.status === "accepted")
        .length,
      departmentName: t.department?.name ?? null,
      departmentColor: t.department?.color ?? null,
      scheduledStart: t.scheduledStart,
      scheduledEnd: t.scheduledEnd,
    }));
  }

  /**
   * Gets department-level metrics: active task count and staff count.
   * Used for department workload bars with imbalance detection.
   * Only counts open/in-progress tasks and active staff/manager members.
   *
   * `departmentIds` null/undefined = unrestricted (company admin); an array
   * limits the rows to those departments. Null-tested rather than `.length`-
   * tested so an empty scope yields no departments instead of all of them.
   */
  async getDepartmentMetrics(
    organizationId: string,
    departmentIds?: string[] | null
  ): Promise<DepartmentMetricRecord[]> {
    const departments = await prisma.department.findMany({
      where: {
        organizationId,
        archivedAt: null,
        ...(departmentIds != null ? { id: { in: departmentIds } } : {}),
      },
      select: {
        id: true,
        name: true,
        color: true,
        tasks: {
          where: { status: { in: ["open", "in_progress"] } },
          select: { id: true },
        },
        departmentMemberships: {
          where: {
            membership: {
              status: "active",
              role: { in: ["staff", "manager"] },
            },
          },
          select: { id: true },
        },
      },
    });

    return departments.map((d) => ({
      id: d.id,
      name: d.name,
      color: d.color || "#94A3B8",
      activeTaskCount: d.tasks.length,
      staffCount: d.departmentMemberships.length,
    }));
  }

  // ===== Assignment Metrics =====

  /**
   * Counts assignments grouped by status within a date range.
   * Uses Prisma groupBy for efficient single-query aggregation.
   * Used for assignment pipeline metric card.
   */
  async countAssignmentsByStatus(
    organizationId: string,
    since: Date,
    departmentIds?: string[]
  ): Promise<AssignmentStatusCount[]> {
    const result = await prisma.taskAssignment.groupBy({
      by: ["status"],
      where: {
        task: {
          organizationId,
          ...(departmentIds != null
            ? { departmentId: { in: departmentIds } }
            : {}),
        },
        createdAt: { gte: since },
      },
      _count: { _all: true },
    });

    return result.map((r) => ({
      status: r.status,
      count: r._count._all,
    }));
  }

  /**
   * Gets pending assignments with staff and task details.
   * Used for "pending acceptances" alert in needs-attention section.
   * Ordered by creation date descending (newest first).
   */
  async getPendingAssignments(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<PendingAssignmentRecord[]> {
    const records = await prisma.taskAssignment.findMany({
      where: {
        status: "pending",
        task: {
          organizationId,
          ...(departmentIds != null
            ? { departmentId: { in: departmentIds } }
            : {}),
        },
      },
      select: {
        id: true,
        taskId: true,
        membershipId: true,
        createdAt: true,
        task: { select: { title: true } },
        membership: {
          select: {
            user: { select: { name: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return records.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      taskTitle: r.task.title,
      staffName: r.membership.user.name || r.membership.user.email,
      staffEmail: r.membership.user.email,
      membershipId: r.membershipId,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Gets rejected assignments with staff name and rejection reason.
   * Service layer groups by staff and analyzes patterns.
   * Used for rejection trends narrative display.
   */
  async getRejectionData(
    organizationId: string,
    since: Date,
    departmentIds?: string[]
  ): Promise<RejectionRecord[]> {
    const records = await prisma.taskAssignment.findMany({
      where: {
        status: "rejected",
        updatedAt: { gte: since },
        task: {
          organizationId,
          ...(departmentIds != null
            ? { departmentId: { in: departmentIds } }
            : {}),
        },
      },
      select: {
        membershipId: true,
        rejectionReason: true,
        rejectionNotes: true,
        membership: {
          select: {
            // `id` because follow-up actions address a person, not a membership.
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    return records.map((r) => ({
      membershipId: r.membershipId,
      userId: r.membership.user.id,
      staffName: r.membership.user.name || r.membership.user.email,
      staffEmail: r.membership.user.email,
      rejectionReason: r.rejectionReason,
      rejectionNotes: r.rejectionNotes,
    }));
  }

  // ===== Certification Metrics =====

  /**
   * Gets verified certifications expiring within N days from now.
   * Only includes certifications that haven't expired yet.
   * Used for expiring certification alerts.
   */
  async getExpiringCertifications(
    organizationId: string,
    withinDays: number,
    departmentIds?: string[]
  ): Promise<ExpiringCertRecord[]> {
    const now = new Date();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + withinDays);

    const records = await prisma.certification.findMany({
      where: {
        // Scoped through the OWNER's departments, not the task's — a
        // certification belongs to a person. Six of the eight sources feeding
        // `getNeedsAttention` were scoped and these two were not, so a manager
        // limited to one department was shown other departments' staff names
        // and expiry dates, and those items were serialised into the AI prompt.
        membership: departmentScopedMembership(organizationId, departmentIds),
        status: "verified",
        expiryDate: {
          gte: now,
          lte: cutoff,
        },
      },
      select: {
        id: true,
        name: true,
        expiryDate: true,
        membership: {
          select: {
            id: true,
            user: { select: { name: true, email: true } },
          },
        },
      },
      orderBy: { expiryDate: "asc" },
    });

    return records
      .filter(
        (r): r is typeof r & { expiryDate: Date } => r.expiryDate !== null
      )
      .map((r) => ({
        id: r.id,
        certName: r.name,
        staffName: r.membership.user.name || r.membership.user.email,
        staffEmail: r.membership.user.email,
        membershipId: r.membership.id,
        expiryDate: r.expiryDate,
      }));
  }

  /**
   * Gets certifications with status "pending" (awaiting admin verification).
   * Used for pending verification alert in needs-attention section.
   */
  async getPendingCertVerifications(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<PendingCertVerificationRecord[]> {
    const records = await prisma.certification.findMany({
      where: {
        membership: departmentScopedMembership(organizationId, departmentIds),
        status: "pending",
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
        membership: {
          select: {
            id: true,
            user: { select: { name: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return records.map((r) => ({
      id: r.id,
      certName: r.name,
      staffName: r.membership.user.name || r.membership.user.email,
      staffEmail: r.membership.user.email,
      membershipId: r.membership.id,
      submittedAt: r.createdAt,
    }));
  }

  // ===== Staff Personal (Staff Dashboard) =====

  /**
   * Gets a staff member's task assignments within a date range.
   * Used for personal weekly calendar view.
   *
   * Everything that still ties them to a shift. The list here was "pending,
   * accepted, completed" — which dropped `clocked_out` as well as both
   * awaiting-a-decision states, so a member who had clocked out of a shift saw
   * it vanish from their own calendar before it was marked complete.
   */
  async getStaffAssignments(
    membershipId: string,
    startDate: Date,
    endDate: Date
  ): Promise<StaffAssignmentRecord[]> {
    const records = await prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: occupyingStatusFilter() },
        task: {
          scheduledStart: { lt: endDate },
          scheduledEnd: { gt: startDate },
        },
      },
      select: {
        id: true,
        status: true,
        taskId: true,
        clockInTime: true,
        clockOutTime: true,
        task: {
          select: {
            title: true,
            scheduledStart: true,
            scheduledEnd: true,
            department: { select: { name: true, color: true } },
          },
        },
      },
      orderBy: { task: { scheduledStart: "asc" } },
    });

    return records.map((r) => ({
      id: r.id,
      status: r.status,
      taskId: r.taskId,
      taskTitle: r.task.title,
      departmentName: r.task.department?.name ?? null,
      departmentColor: r.task.department?.color ?? null,
      scheduledStart: r.task.scheduledStart,
      scheduledEnd: r.task.scheduledEnd,
      clockInTime: r.clockInTime,
      clockOutTime: r.clockOutTime,
    }));
  }

  /**
   * Gets a staff member's certifications with status and expiry.
   * Used for personal certifications list on staff dashboard.
   */
  async getStaffCertifications(
    membershipId: string
  ): Promise<StaffCertRecord[]> {
    const records = await prisma.certification.findMany({
      where: { membershipId },
      select: {
        id: true,
        name: true,
        status: true,
        expiryDate: true,
        issuedDate: true,
      },
      orderBy: { issuedDate: "desc" },
    });

    return records.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      expiryDate: r.expiryDate,
      issuedDate: r.issuedDate,
    }));
  }

  /**
   * Gets a staff member's weekly availability schedule.
   * Used for calendar background blocks on staff dashboard.
   * Ordered by day of week (0=Sunday through 6=Saturday).
   */
  async getStaffAvailability(
    membershipId: string
  ): Promise<StaffAvailabilityRecord[]> {
    const records = await prisma.availability.findMany({
      where: { membershipId },
      select: {
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        isAvailable: true,
      },
      orderBy: { dayOfWeek: "asc" },
    });

    return records.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      startTime: r.startTime,
      endTime: r.endTime,
      isAvailable: r.isAvailable,
    }));
  }

  /**
   * Gets raw assignment data for computing personal stats.
   * Service layer calculates acceptance rate, on-time rate, etc.
   * Returns minimal fields to keep the query efficient.
   */
  async getStaffAssignmentHistory(
    membershipId: string,
    since: Date
  ): Promise<StaffAssignmentStatRecord[]> {
    const records = await prisma.taskAssignment.findMany({
      where: {
        membershipId,
        createdAt: { gte: since },
      },
      select: {
        status: true,
        clockInTime: true,
        createdAt: true,
        task: { select: { scheduledStart: true } },
      },
    });

    return records.map((r) => ({
      status: r.status,
      clockInTime: r.clockInTime,
      scheduledStart: r.task.scheduledStart,
      createdAt: r.createdAt,
    }));
  }

  // ===== Calendar Coverage =====

  /**
   * Gets all staff availability schedules for an organization.
   * Used for calendar heatmap coverage computation.
   * Returns weekly recurring schedules for all active staff/managers.
   */
  async getAllStaffAvailability(
    organizationId: string,
    departmentIds?: string[] | null
  ) {
    return prisma.availability.findMany({
      where: {
        membership: {
          organizationId,
          status: "active",
          role: { in: ["staff", "manager"] },
          // Null/undefined = unrestricted (company admin). Tested for null and
          // not for `.length` so an EMPTY scope returns nothing rather than
          // everything — Prisma's `{ in: [] }` matches no rows, which is the
          // correct answer for a manager who belongs to no department.
          ...(departmentIds != null
            ? {
                departmentMemberships: {
                  some: { departmentId: { in: departmentIds } },
                },
              }
            : {}),
        },
      },
      select: {
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        isAvailable: true,
        membershipId: true,
        membership: {
          select: {
            user: { select: { name: true, email: true } },
          },
        },
      },
    });
  }

  // ─── Company-admin dashboard summaries ────────────────────────────────────

  /** Task counts grouped by task status (open, in_progress, completed, cancelled). */
  async countTasksByStatus(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<{ status: string; count: number }[]> {
    const grouped = await prisma.task.groupBy({
      by: ["status"],
      where: {
        organizationId,
        ...(departmentIds != null
          ? { departmentId: { in: departmentIds } }
          : {}),
      },
      _count: { _all: true },
    });

    return grouped.map((g) => ({ status: g.status, count: g._count._all }));
  }

  /**
   * Org-wide certification counts: by verification status, plus how many
   * verified certs are expiring soon or have already lapsed.
   */
  async getCertificationCounts(
    organizationId: string,
    expiringWithinDays = 30
  ): Promise<{
    verified: number;
    pending: number;
    rejected: number;
    expiringSoon: number;
    expired: number;
  }> {
    const now = new Date();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + expiringWithinDays);

    const scope = { membership: { organizationId } };

    const [verified, pending, rejected, expiringSoon, expired] =
      await Promise.all([
        prisma.certification.count({
          where: { ...scope, status: "verified" },
        }),
        prisma.certification.count({
          where: { ...scope, status: "pending" },
        }),
        prisma.certification.count({
          where: { ...scope, status: "rejected" },
        }),
        prisma.certification.count({
          where: {
            ...scope,
            status: "verified",
            expiryDate: { gte: now, lte: cutoff },
          },
        }),
        prisma.certification.count({
          where: {
            ...scope,
            status: "verified",
            expiryDate: { lt: now },
          },
        }),
      ]);

    return { verified, pending, rejected, expiringSoon, expired };
  }

  /**
   * Upcoming tasks with their required headcount and how many slots are
   * actually taken — the raw material for the coverage summary.
   * Only slot-occupying assignments count — the shared rule, which is
   * everything except rejected and withdrawn.
   */
  async getUpcomingCoverage(
    organizationId: string,
    from: Date,
    to: Date,
    departmentIds?: string[]
  ): Promise<{ requiredHeadcount: number; assignedCount: number }[]> {
    const tasks = await prisma.task.findMany({
      where: {
        organizationId,
        status: { notIn: ["completed", "cancelled"] },
        scheduledStart: { gte: from, lte: to },
        ...(departmentIds != null
          ? { departmentId: { in: departmentIds } }
          : {}),
      },
      select: {
        requiredHeadcount: true,
        _count: {
          select: {
            assignments: {
              where: { status: { in: occupyingStatusFilter() } },
            },
          },
        },
      },
    });

    return tasks.map((t) => ({
      requiredHeadcount: t.requiredHeadcount,
      assignedCount: t._count.assignments,
    }));
  }

  // ============================================================
  // Smart-engine evidence
  //
  // These read the allocation provenance recorded on TaskAssignment and the
  // EligibilityOverride table. Both are org-scoped through the parent Task /
  // Membership rather than directly, because neither carries an
  // organizationId of its own.
  // ============================================================

  /**
   * Assignments grouped by how they were created, within a window.
   *
   * `allocationSource: null` is included deliberately and reported as its own
   * bucket. Every assignment written before provenance existed has NULL there,
   * and folding those into "manual" would invent a human decision for each one
   * — which is exactly the overstatement these charts are meant to avoid.
   */
  async countAssignmentsBySource(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<{ source: string | null; count: number }[]> {
    const groups = await prisma.taskAssignment.groupBy({
      by: ["allocationSource"],
      where: {
        task: {
          organizationId,
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
        createdAt: { gte: since },
      },
      _count: { _all: true },
    });

    return groups.map((g) => ({
      source: g.allocationSource,
      count: g._count._all,
    }));
  }

  /** Assignments grouped by the strategy that ranked them. */
  async countAssignmentsByProvider(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<{ provider: string | null; count: number }[]> {
    const groups = await prisma.taskAssignment.groupBy({
      by: ["allocationProvider"],
      where: {
        task: {
          organizationId,
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
        createdAt: { gte: since },
        // Only engine-made assignments have a provider; a manual pick has no
        // strategy and would otherwise dominate the split as a null bucket.
        allocationSource: { in: ["ai_suggested", "auto_scheduled"] },
      },
      _count: { _all: true },
    });

    return groups.map((g) => ({
      provider: g.allocationProvider,
      count: g._count._all,
    }));
  }

  /**
   * Engine-made assignments with their rank, score and eventual status.
   *
   * Returned as rows rather than pre-aggregated because the interesting
   * questions cut across two dimensions at once — "was the top-ranked pick
   * rejected more often than the rest?" — and Prisma cannot express that in a
   * single groupBy. The row count is bounded by the window, and only
   * engine-made assignments qualify.
   */
  async getEngineAssignments(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<
    { rank: number | null; score: number | null; status: string; source: string | null }[]
  > {
    const rows = await prisma.taskAssignment.findMany({
      where: {
        task: {
          organizationId,
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
        createdAt: { gte: since },
        allocationSource: { in: ["ai_suggested", "auto_scheduled"] },
      },
      select: {
        allocationRank: true,
        allocationScore: true,
        status: true,
        allocationSource: true,
      },
    });

    return rows.map((r) => ({
      rank: r.allocationRank,
      score: r.allocationScore,
      status: r.status,
      source: r.allocationSource,
    }));
  }

  /**
   * Eligibility overrides grouped by which rule was bypassed.
   *
   * EligibilityOverride has no organizationId, so this scopes through the
   * task. The repository for that model only ever queries by task or
   * membership id, which is why this lives here rather than there — an
   * org-wide view is a reporting question.
   */
  async countOverridesByRule(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<{ rule: string; count: number }[]> {
    const groups = await prisma.eligibilityOverride.groupBy({
      by: ["ruleOverridden"],
      where: {
        createdAt: { gte: since },
        task: {
          organizationId,
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
      },
      _count: { _all: true },
    });

    return groups.map((g) => ({ rule: g.ruleOverridden, count: g._count._all }));
  }

  /** Total overrides in the window, for "N of M assignments needed one". */
  async countOverrides(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<number> {
    return prisma.eligibilityOverride.count({
      where: {
        createdAt: { gte: since },
        task: {
          organizationId,
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
      },
    });
  }

  /** Assignments created in the window, as the denominator for the above. */
  async countAssignmentsSince(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        task: {
          organizationId,
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
        createdAt: { gte: since },
      },
    });
  }

  // ============================================================
  // Insight queries
  //
  // These differ from everything above in that each one JOINS two facts to
  // produce something neither carries alone. "A certificate expires on the
  // 20th" is a date; "a certificate expires on the 20th and its holder is on
  // four shifts after that which require it" is a problem. The data was always
  // there — nobody had asked the second question.
  // ============================================================

  /**
   * Shifts in the near future that are not yet fully staffed.
   *
   * Deliberately narrower than `getUnderstaffedTasks`, which reports the
   * current state of everything: this is bounded to a forward window and to
   * tasks that still have time to be fixed, because it feeds an expensive
   * per-task eligibility evaluation.
   */
  async getUpcomingUnfilledTasks(
    organizationId: string,
    from: Date,
    to: Date,
    departmentIds?: string[] | null
  ): Promise<
    { id: string; title: string; requiredHeadcount: number; assignedCount: number; scheduledStart: Date | null }[]
  > {
    const tasks = await prisma.task.findMany({
      where: {
        organizationId,
        status: { notIn: ["completed", "cancelled"] },
        scheduledStart: { gte: from, lte: to },
        ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
      },
      select: {
        id: true,
        title: true,
        requiredHeadcount: true,
        scheduledStart: true,
        _count: {
          select: {
            assignments: {
              where: { status: { in: occupyingStatusFilter() } },
            },
          },
        },
      },
      orderBy: { scheduledStart: "asc" },
    });

    // Prisma cannot compare two columns in a `where`, so the shortfall filter
    // happens here — the same approach `getUnderstaffedTasks` takes.
    return tasks
      .filter((t) => t._count.assignments < t.requiredHeadcount)
      .map((t) => ({
        id: t.id,
        title: t.title,
        requiredHeadcount: t.requiredHeadcount,
        assignedCount: t._count.assignments,
        scheduledStart: t.scheduledStart,
      }));
  }

  /**
   * Certifications expiring soon, together with the shifts their holder is
   * booked on AFTER the expiry date that actually require them.
   *
   * The join is the point. An expiry date on its own is a diary note; an
   * expiry date with four shifts behind it is somebody working uncertified.
   *
   * `requiredCertifications` is a string array matched case-insensitively,
   * mirroring how the eligibility engine compares them — a task asking for
   * "food safety" and a certificate named "Food Safety" are the same
   * requirement.
   */
  async getExpiringCertificationImpact(
    organizationId: string,
    withinDays: number,
    departmentIds?: string[] | null
  ): Promise<
    {
      certificationId: string;
      certName: string;
      staffName: string;
      membershipId: string;
      expiryDate: Date;
      affectedTasks: { id: string; title: string; scheduledStart: Date | null }[];
    }[]
  > {
    const horizon = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);

    const certs = await prisma.certification.findMany({
      where: {
        status: "verified",
        expiryDate: { gt: new Date(), lte: horizon },
        membership: { organizationId, status: "active" },
      },
      select: {
        id: true,
        name: true,
        expiryDate: true,
        membershipId: true,
        membership: {
          select: { user: { select: { name: true, email: true } } },
        },
      },
    });

    if (certs.length === 0) return [];

    const assignments = await prisma.taskAssignment.findMany({
      where: {
        membershipId: { in: certs.map((c) => c.membershipId) },
        status: { in: occupyingStatusFilter() },
        task: {
          organizationId,
          status: { notIn: ["completed", "cancelled"] },
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
      },
      select: {
        membershipId: true,
        task: {
          select: {
            id: true,
            title: true,
            scheduledStart: true,
            requiredCertifications: true,
          },
        },
      },
    });

    return certs
      .map((cert) => {
        const certName = cert.name.toLowerCase();
        const affectedTasks = assignments
          .filter((a) => a.membershipId === cert.membershipId)
          .filter((a) => a.task.scheduledStart !== null)
          .filter((a) => a.task.scheduledStart! > cert.expiryDate!)
          .filter((a) =>
            a.task.requiredCertifications.some(
              (required) => required.toLowerCase() === certName
            )
          )
          .map((a) => ({
            id: a.task.id,
            title: a.task.title,
            scheduledStart: a.task.scheduledStart,
          }));

        return {
          certificationId: cert.id,
          certName: cert.name,
          staffName: cert.membership.user.name ?? cert.membership.user.email,
          membershipId: cert.membershipId,
          expiryDate: cert.expiryDate!,
          affectedTasks,
        };
      })
      .filter((c) => c.affectedTasks.length > 0);
  }

  /**
   * Shifts somebody accepted, that have finished, where they never clocked in.
   *
   * No new column was needed for this — the absence of `clockInTime` on a
   * finished shift IS the signal. It went unasked rather than unrecorded.
   *
   * `clocked_out` and `completed` are excluded because reaching either means
   * they did turn up. What remains is accepted-and-silent.
   */
  async getNoShows(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<{ membershipId: string; staffName: string; taskTitle: string; scheduledEnd: Date }[]> {
    const rows = await prisma.taskAssignment.findMany({
      where: {
        status: "accepted",
        clockInTime: null,
        task: {
          organizationId,
          status: { not: "cancelled" },
          scheduledEnd: { gte: since, lt: new Date() },
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
      },
      select: {
        membershipId: true,
        membership: { select: { user: { select: { name: true, email: true } } } },
        task: { select: { title: true, scheduledEnd: true } },
      },
      orderBy: { task: { scheduledEnd: "desc" } },
    });

    return rows
      .filter((r) => r.task.scheduledEnd !== null)
      .map((r) => ({
        membershipId: r.membershipId,
        staffName: r.membership.user.name ?? r.membership.user.email,
        taskTitle: r.task.title,
        scheduledEnd: r.task.scheduledEnd!,
      }));
  }

  /**
   * Every assignment offered in the window, with the timestamps that say
   * whether and when it was answered.
   *
   * Rows are returned raw rather than aggregated in SQL because the service
   * has to separate three populations that a single AVG would silently merge:
   * answered, still waiting, and never answered by a person at all (auto-accept
   * and rows predating these columns). Averaging across all of them would fill
   * the figure with response times of zero that nobody achieved.
   */
  async getResponseTimings(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<
    {
      createdAt: Date;
      acceptedAt: Date | null;
      rejectedAt: Date | null;
      status: string;
      allocationSource: string | null;
    }[]
  > {
    return prisma.taskAssignment.findMany({
      where: {
        task: {
          organizationId,
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
        createdAt: { gte: since },
      },
      select: {
        createdAt: true,
        acceptedAt: true,
        rejectedAt: true,
        status: true,
        allocationSource: true,
      },
    });
  }

  /**
   * Notice given on withdrawals: when the member asked out, against when the
   * shift was due to start.
   *
   * Only assignments whose task has a start time can answer the question, so
   * the filter is in the query rather than discarding rows afterwards.
   */
  async getWithdrawalNotice(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<{ requestedAt: Date; scheduledStart: Date; reason: string | null }[]> {
    const rows = await prisma.taskAssignment.findMany({
      where: {
        withdrawalRequestedAt: { gte: since },
        task: {
          organizationId,
          scheduledStart: { not: null },
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
      },
      select: {
        withdrawalRequestedAt: true,
        withdrawalReason: true,
        task: { select: { scheduledStart: true } },
      },
    });

    return rows
      .filter((r) => r.withdrawalRequestedAt !== null && r.task.scheduledStart !== null)
      .map((r) => ({
        requestedAt: r.withdrawalRequestedAt!,
        scheduledStart: r.task.scheduledStart!,
        reason: r.withdrawalReason,
      }));
  }

  /**
   * Ratings staff gave shifts they worked, carrying the allocation columns.
   *
   * The join is the point of the whole provenance exercise: it is what lets
   * "the engine's top pick was accepted" be tested against "the engine's top
   * pick was a shift the person was glad to work", which are not the same
   * claim and can disagree.
   */
  async getShiftRatings(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<
    {
      rating: number;
      comment: string | null;
      ratedAt: Date;
      allocationSource: string | null;
      allocationRank: number | null;
      departmentId: string | null;
      departmentName: string | null;
      taskTitle: string;
    }[]
  > {
    const rows = await prisma.taskAssignment.findMany({
      where: {
        satisfactionRating: { not: null },
        ratedAt: { gte: since },
        task: {
          organizationId,
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
      },
      select: {
        satisfactionRating: true,
        satisfactionComment: true,
        ratedAt: true,
        allocationSource: true,
        allocationRank: true,
        task: {
          select: {
            title: true,
            departmentId: true,
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { ratedAt: "desc" },
    });

    return rows
      .filter((r) => r.satisfactionRating !== null && r.ratedAt !== null)
      .map((r) => ({
        rating: r.satisfactionRating!,
        comment: r.satisfactionComment,
        ratedAt: r.ratedAt!,
        allocationSource: r.allocationSource,
        allocationRank: r.allocationRank,
        departmentId: r.task.departmentId,
        departmentName: r.task.department?.name ?? null,
        taskTitle: r.task.title,
      }));
  }

  /**
   * Worked shifts in the window that carry no rating — the denominator.
   *
   * An average of 4.6 means something different from 8 responses than from
   * 400, and without this the panel could only ever show the numerator.
   */
  async countRateableShifts(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null
  ): Promise<number> {
    return prisma.taskAssignment.count({
      where: {
        status: { in: ["clocked_out", "completed"] },
        task: {
          organizationId,
          ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
        },
        // Which shifts fall inside the window. A scheduled shift is placed by
        // when it ended; an unscheduled one has no end date to place it by, so
        // it falls back to when the assignment was made.
        //
        // Without the second branch, every unscheduled shift was excluded from
        // the denominator while its rating still counted in the numerator —
        // so an organisation that does not schedule could report more
        // responses than rateable shifts.
        OR: [
          { task: { scheduledEnd: { gte: since } } },
          { task: { scheduledEnd: null }, createdAt: { gte: since } },
        ],
      },
    });
  }

  /**
   * Completed shifts per membership, optionally within one department.
   *
   * Backs derived seniority. A groupBy rather than a count per member: the
   * candidate list evaluates every active member at once, and a query each
   * would put the eligibility check's cost on the size of the org.
   */
  async countCompletedShiftsByMember(
    organizationId: string,
    membershipIds: string[],
    departmentId?: string | null
  ): Promise<Record<string, number>> {
    if (membershipIds.length === 0) return {};

    const groups = await prisma.taskAssignment.groupBy({
      by: ["membershipId"],
      where: {
        membershipId: { in: membershipIds },
        // Only work actually done counts. Accepted-but-not-yet-worked shifts
        // would let someone become "experienced" by being rostered, which is
        // the thing the level is supposed to be evidence for.
        status: { in: ["clocked_out", "completed"] },
        task: {
          organizationId,
          ...(departmentId ? { departmentId } : {}),
        },
      },
      _count: { _all: true },
    });

    const counts: Record<string, number> = {};
    for (const id of membershipIds) counts[id] = 0;
    for (const g of groups) counts[g.membershipId] = g._count._all;
    return counts;
  }

  /**
   * Free text staff wrote, from all three places they can write it.
   *
   * Everything else on this repository counts, averages or groups. This is the
   * one read whose value is in the words themselves: `GROUP BY rejectionReason`
   * can report that eight declines said `schedule_conflict`, and nothing in SQL
   * can notice that six of the notes beside them mention the same closing shift.
   *
   * Deliberately excludes staff names. Themes are about the work, not about
   * people, and a name in the prompt is an invitation to hand back an
   * accusation about someone who cannot see it or answer it. Department, shift
   * title and the structured value beside the text are enough context to make a
   * theme actionable.
   *
   * Three queries rather than one OR, because each kind is windowed on its own
   * timestamp. Rows written before those columns existed carry NULL and fall
   * back to `updatedAt`, which is imprecise — it moves with every later
   * transition — but only decides which window an old comment lands in, never
   * what it says.
   */
  async getFeedbackText(
    organizationId: string,
    since: Date,
    departmentIds?: string[] | null,
    perKindLimit = 40
  ): Promise<FeedbackSnippet[]> {
    const scope = {
      organizationId,
      ...(departmentIds != null ? { departmentId: { in: departmentIds } } : {}),
    };
    const taskSelect = {
      select: {
        title: true,
        department: { select: { name: true } },
      },
    } as const;

    /** `<field> >= since`, or `updatedAt >= since` for rows predating it. */
    const windowed = (field: "ratedAt" | "rejectedAt" | "withdrawalRequestedAt") => ({
      OR: [
        { [field]: { gte: since } },
        { [field]: null, updatedAt: { gte: since } },
      ],
    });

    const [rated, declined, withdrawn] = await Promise.all([
      prisma.taskAssignment.findMany({
        where: {
          satisfactionComment: { not: null },
          task: scope,
          ...windowed("ratedAt"),
        },
        select: {
          satisfactionComment: true,
          satisfactionRating: true,
          ratedAt: true,
          updatedAt: true,
          task: taskSelect,
        },
        orderBy: { updatedAt: "desc" },
        take: perKindLimit,
      }),
      prisma.taskAssignment.findMany({
        where: {
          rejectionNotes: { not: null },
          task: scope,
          ...windowed("rejectedAt"),
        },
        select: {
          rejectionNotes: true,
          rejectionReason: true,
          rejectedAt: true,
          updatedAt: true,
          task: taskSelect,
        },
        orderBy: { updatedAt: "desc" },
        take: perKindLimit,
      }),
      prisma.taskAssignment.findMany({
        where: {
          withdrawalNotes: { not: null },
          task: scope,
          ...windowed("withdrawalRequestedAt"),
        },
        select: {
          withdrawalNotes: true,
          withdrawalReason: true,
          withdrawalRequestedAt: true,
          updatedAt: true,
          task: taskSelect,
        },
        orderBy: { updatedAt: "desc" },
        take: perKindLimit,
      }),
    ]);

    const snippets: FeedbackSnippet[] = [
      ...rated.map((r) => ({
        kind: "rating" as const,
        text: r.satisfactionComment ?? "",
        label: r.satisfactionRating != null ? `rated ${r.satisfactionRating}/5` : null,
        departmentName: r.task.department?.name ?? null,
        taskTitle: r.task.title,
        at: r.ratedAt ?? r.updatedAt,
      })),
      ...declined.map((r) => ({
        kind: "decline" as const,
        text: r.rejectionNotes ?? "",
        label: r.rejectionReason,
        departmentName: r.task.department?.name ?? null,
        taskTitle: r.task.title,
        at: r.rejectedAt ?? r.updatedAt,
      })),
      ...withdrawn.map((r) => ({
        kind: "withdrawal" as const,
        text: r.withdrawalNotes ?? "",
        label: r.withdrawalReason,
        departmentName: r.task.department?.name ?? null,
        taskTitle: r.task.title,
        at: r.withdrawalRequestedAt ?? r.updatedAt,
      })),
    ];

    // A column that is present but blank is not feedback. `not: null` above
    // cannot express this, and an empty string sent to the model is a numbered
    // line with nothing on it that it may still try to find a theme in.
    return snippets
      .map((s) => ({ ...s, text: s.text.trim() }))
      .filter((s) => s.text.length > 0)
      .sort((a, b) => b.at.getTime() - a.at.getTime());
  }
}
