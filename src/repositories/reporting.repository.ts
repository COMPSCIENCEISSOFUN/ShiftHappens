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
import {
  COMMITTED_ASSIGNMENT_STATUSES,
  SLOT_OCCUPYING_ASSIGNMENT_STATUSES,
} from "@/lib/assignment-status";

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

/** Task scheduled within a date range with assignment breakdown */
export interface ScheduledTaskRecord {
  id: string;
  title: string;
  status: string;
  requiredHeadcount: number;
  assignedCount: number;
  activeAssignmentCount: number;
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
  assignedCount: number;
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
          ...(departmentIds?.length
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
          ...(departmentIds?.length
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
          ...(departmentIds?.length
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
            user: { select: { name: true, email: true } },
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
        ...(departmentIds?.length
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
        ...(departmentIds?.length
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
            status: { in: SLOT_OCCUPYING_ASSIGNMENT_STATUSES },
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
      assignedCount: m.taskAssignments.filter((a) => a.status === "assigned")
        .length,
    }));
  }

  // ===== Task Metrics =====

  /**
   * Gets tasks where active assignment count < requiredHeadcount.
   * Only considers open/in-progress tasks with active slot-occupying assignments.
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
        ...(departmentIds?.length
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
          where: { status: { in: SLOT_OCCUPYING_ASSIGNMENT_STATUSES } },
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
        ...(departmentIds?.length
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
          where: { status: { in: SLOT_OCCUPYING_ASSIGNMENT_STATUSES } },
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
      activeAssignmentCount: t.assignments.filter((a) =>
        (SLOT_OCCUPYING_ASSIGNMENT_STATUSES as string[]).includes(a.status)
      )
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
   */
  async getDepartmentMetrics(
    organizationId: string
  ): Promise<DepartmentMetricRecord[]> {
    const departments = await prisma.department.findMany({
      where: { organizationId, archivedAt: null },
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
          ...(departmentIds?.length
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

  // ===== Certification Metrics =====

  /**
   * Gets verified certifications expiring within N days from now.
   * Only includes certifications that haven't expired yet.
   * Used for expiring certification alerts.
   */
  async getExpiringCertifications(
    organizationId: string,
    withinDays: number
  ): Promise<ExpiringCertRecord[]> {
    const now = new Date();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + withinDays);

    const records = await prisma.certification.findMany({
      where: {
        membership: { organizationId },
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
    organizationId: string
  ): Promise<PendingCertVerificationRecord[]> {
    const records = await prisma.certification.findMany({
      where: {
        membership: { organizationId },
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
   * Includes committed active and completed assignments.
   */
  async getStaffAssignments(
    membershipId: string,
    startDate: Date,
    endDate: Date
  ): Promise<StaffAssignmentRecord[]> {
    const records = await prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: COMMITTED_ASSIGNMENT_STATUSES },
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
   * Service layer calculates completion and on-time rates.
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
  async getAllStaffAvailability(organizationId: string) {
    return prisma.availability.findMany({
      where: {
        membership: {
          organizationId,
          status: "active",
          role: { in: ["staff", "manager"] },
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
        ...(departmentIds?.length
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
   * Only slot-occupying assignments count.
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
        ...(departmentIds?.length
          ? { departmentId: { in: departmentIds } }
          : {}),
      },
      select: {
        requiredHeadcount: true,
        _count: {
          select: {
            assignments: {
              where: {
                status: { in: SLOT_OCCUPYING_ASSIGNMENT_STATUSES },
              },
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
}
