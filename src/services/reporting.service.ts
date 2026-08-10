/**
 * Reporting Service (Control Layer)
 *
 * Orchestrates dashboard data aggregation for three role-specific views:
 * - Company Admin: full org overview with needs-attention alerts, metrics, charts
 * - Manager: department-scoped with team roster
 * - Staff: personal calendar, stats, and certifications
 *
 * All data access flows through ReportingRepository (Entity layer).
 * Business logic (grouping, computation, formatting) lives here.
 * Each public method is independently callable by the API route,
 * which uses Promise.allSettled for per-section resilience.
 *
 * BCE compliant: Service (Control) → Repository (Entity).
 */
import { ReportingRepository } from "@/repositories/reporting.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { EligibilityOverrideRepository } from "@/repositories/eligibility-override.repository";
import { REASON_PHRASE, type DeclineReason } from "@/lib/decline-reasons";
import { occupiesSlot } from "@/lib/assignment-status";
import {
  DEFAULT_TIMEZONE,
  dayOfWeekInTimeZone,
  endOfDayInTimeZone,
  localDateInTimeZone,
  startOfDayInTimeZone,
  shiftWindowLabel,
} from "@/lib/timezone";

/**
 * One day in milliseconds. Adding whole days to a day boundary resolved in a
 * fixed-offset zone (Asia/Singapore) is exact; a DST zone would need each
 * boundary re-resolved rather than offset arithmetic.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Responses needed before a group's average is reported at all.
 *
 * Five is not a statistical threshold — it is a guard against a specific
 * failure. A department with two ratings can top or bottom a ranked list on
 * one bad night, and a manager acts on that list. Suppressing the group is
 * honest; showing "2.0" beside "(2 responses)" and hoping the reader weighs it
 * is not, because ranked lists are read by position.
 */
const MIN_GROUP_RESPONSES = 5;

/** One decline is a Tuesday. Two is worth a manager's attention. */
const MIN_DECLINES_FOR_PATTERN = 2;

/** Comments render in a dashboard panel, not a report. */
const MAX_RECENT_COMMENTS = 5;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Middle value; the average of the two middle values for an even count.
 *
 * Sorts a copy — the callers build these arrays for the median and then use
 * them again for the "within four hours" count, and sorting in place would
 * work today and break silently the first time a caller cared about order.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Keeps "no data" as null all the way to the UI rather than becoming a 0. */
function roundOrNull(value: number | null): number | null {
  return value === null ? null : round1(value);
}

import type {
  StaffAssignmentRecord,
  StaffAvailabilityRecord,
  StaffCertRecord,
} from "@/repositories/reporting.repository";

// ============================================================
// Response type interfaces
// ============================================================

/** Actionable alert for needs-attention section */
export interface NeedsAttentionItem {
  type:
    | "understaffed"
    | "pending_acceptance"
    | "expiring_cert"
    | "pending_verification"
    // Cross-referenced types. Each joins two facts to say something neither
    // carries alone — an expiry beside the shifts it grounds, a decline count
    // beside its commonest reason.
    //
    // These once carried an `isAiInsight` flag and rendered with a sparkle,
    // which was a lie: every one is a SQL join with a threshold. Nothing on
    // this list is model output, and labelling deterministic work as AI is
    // exactly what makes a real model feature impossible to trust.
    | "expiring_cert_impact"
    | "unfillable"
    | "no_show"
    | "decline_pattern";
  severity: "danger" | "warning" | "info";
  message: string;
  actionLabel: string;
  actionUrl: string;
  entityId?: string;
  /**
   * True when the action POSTs to `actionUrl` instead of navigating to it.
   *
   * Only the availability nudge uses it. Kept as a flag on the alert rather
   * than inferred in the UI so the one row that DOES something rather than
   * going somewhere is declared where the row is built.
   */
  actionPost?: boolean;
}

/** Three key metric cards for dashboard header */
/** Task counts by TASK status (not assignment status) — PRD 3.15 */
export interface TaskSummary {
  total: number;
  open: number;
  in_progress: number;
  completed: number;
  cancelled: number;
}

/** Org-wide certification health — PRD 3.15 */
export interface CertificationSummary {
  total: number;
  verified: number;
  pending: number;
  rejected: number;
  /** Verified certs expiring within 30 days. */
  expiringSoon: number;
  /** Verified certs whose expiry has already passed. */
  expired: number;
}

/** Staffing coverage across the next 7 days — PRD 3.15 */
export interface CoverageSummary {
  upcomingTasks: number;
  fullyStaffed: number;
  understaffed: number;
  unassigned: number;
  /** Filled slots / required slots, capped at 100. */
  coveragePercent: number;
}

export interface KeyMetrics {
  assignmentPipeline: {
    total: number;
    accepted: number;
    pending: number;
    rejected: number;
    completed: number;
  };
  completionRate: {
    current: number;
    previous: number;
    trend: "up" | "down" | "flat";
  };
  hoursLogged: {
    hours: number;
    capacity: number;
    utilization: number;
  };
}

/** Task in tomorrow's schedule list */
export interface TomorrowTask {
  id: string;
  title: string;
  departmentName: string | null;
  departmentColor: string | null;
  timeRange: string | null;
  isUnderstaffed: boolean;
  assignedCount: number;
  requiredHeadcount: number;
}

/** Daily completion count for bar chart */
export interface CompletionDay {
  date: string;
  label: string;
  count: number;
}

/** Staff member utilization for horizontal bar chart */
export interface StaffUtilizationItem {
  membershipId: string;
  name: string;
  hoursWorked: number;
  capacity: number;
  percentage: number;
}

/** Department workload with task-to-staff ratio */
export interface DepartmentWorkloadItem {
  id: string;
  name: string;
  color: string;
  taskCount: number;
  staffCount: number;
  isImbalanced: boolean;
}

/** Staff rejection data grouped for trend analysis */
export interface RejectionTrendItem {
  staffName: string;
  membershipId: string;
  rejectionCount: number;
  reasons: { reason: string; count: number }[];
}

/** Team member with shift status badge for manager roster */
export interface TeamMemberItem {
  membershipId: string;
  name: string;
  status: "on_shift" | "has_pending" | "available" | "off_today";
  statusLabel: string;
  pendingCount: number;
}

/** Complete staff dashboard data bundle */
export interface StaffDashboardData {
  hoursThisWeek: number;
  weeklyCapacity: number;
  nextShift: {
    taskName: string;
    scheduledStart: Date;
    scheduledEnd: Date;
  } | null;
  tasksThisWeek: {
    total: number;
    pending: number;
  };
  weekAssignments: StaffAssignmentRecord[];
  availability: StaffAvailabilityRecord[];
  certifications: StaffCertRecord[];
  stats: {
    shiftsThisMonth: number;
    hoursThisMonth: number;
    acceptanceRate: number;
    onTimeRate: number;
  };
}

// Legacy types (backward compatibility with /reports endpoint)
interface LegacyCompletionTrend {
  date: string;
  label: string;
  completed: number;
}
interface LegacyStaffUtilization {
  name: string;
  hoursWorked: number;
  capacity: number;
  percentage: number;
}
interface LegacyDepartmentWorkload {
  name: string;
  color: string;
  taskCount: number;
  completedCount: number;
}
interface LegacyHoursSummary {
  totalLogged: number;
  totalCapacity: number;
  percentage: number;
}
export interface ReportingData {
  completionTrend: LegacyCompletionTrend[];
  staffUtilization: LegacyStaffUtilization[];
  departmentWorkload: LegacyDepartmentWorkload[];
  hoursSummary: LegacyHoursSummary;
}

// ============================================================
// Service
// ============================================================

/** Shape behind the AI allocation panel. See getAllocationEngineStats. */
export interface AllocationEngineStats {
  windowDays: number;
  totalAssignments: number;
  /** Assignments with no recorded provenance — pre-dating the feature. */
  unrecorded: number;
  sourceCounts: Record<string, number>;
  providerCounts: Record<string, number>;
  engineAssignments: number;
  averageScore: number | null;
  topPick: { total: number; retained: number; percentage: number | null };
  otherPicks: { total: number; retained: number; percentage: number | null };
}

/** Shape behind the eligibility engine panel. */
export interface EligibilityEngineStats {
  windowDays: number;
  totalOverrides: number;
  totalAssignments: number;
  ruleCounts: Record<string, number>;
  overrideRate: number | null;
}

/**
 * Shape behind the staff response panel.
 *
 * The three populations are kept apart deliberately, because a single average
 * over all of them is the wrong number in a specific and flattering direction:
 *
 *   - `answered` — a person accepted or declined, and the clock was running.
 *   - `awaiting` — still pending. Their eventual response time is unknown and
 *     is at least as long as they have already waited, so including them at
 *     their current age would understate and excluding them silently would
 *     hide a backlog.
 *   - `unanswered` — nobody ever responded: the organisation runs auto-accept,
 *     or the row predates the timestamps. Folded into the average these become
 *     response times of zero that no human achieved.
 */
export interface ResponseStats {
  windowDays: number;
  totalOffered: number;
  answered: number;
  awaiting: number;
  unanswered: number;
  accepted: number;
  declined: number;
  /** Of those answered. Null when nobody answered. */
  acceptanceRate: number | null;
  /** Hours, to one decimal. Median resists a single week-long outlier. */
  medianResponseHours: number | null;
  /** Answered within four hours — the "same shift" bar. */
  withinFourHours: number;
  /** Withdrawal notice, in hours before the shift was due to start. */
  withdrawals: { count: number; medianNoticeHours: number | null; underOneDay: number };
}

/** Shape behind the satisfaction panel. */
export interface SatisfactionStats {
  windowDays: number;
  responses: number;
  /** Worked shifts that could have been rated, rated or not. */
  rateable: number;
  average: number | null;
  /** Rating (1–5) → count. Every key present, so a gap is visibly a gap. */
  distribution: Record<number, number>;
  /** Departments with at least MIN_GROUP_RESPONSES, worst average first. */
  byDepartment: { departmentId: string | null; name: string; average: number; responses: number }[];
  /**
   * The question the provenance columns were recorded for. Null on either side
   * until enough of that kind of assignment has been rated to mean anything.
   */
  engineComparison: {
    topPickAverage: number | null;
    topPickResponses: number;
    otherAverage: number | null;
    otherResponses: number;
  };
  recentComments: { rating: number; comment: string; taskTitle: string; ratedAt: Date }[];
}

export class ReportingService {
  private reportingRepo = new ReportingRepository();
  private overrideRepo = new EligibilityOverrideRepository();
  private settingsRepo = new SettingsRepository();

  // ===== Member Scoping =====

  /**
   * Gets department IDs for a membership.
   * Used by the dashboard API route to scope manager views
   * without directly accessing the Entity layer.
   */
  async getMemberDepartmentIds(membershipId: string): Promise<string[]> {
    return this.reportingRepo.getMemberDepartmentIds(membershipId);
  }

  // ===== Legacy (backward compatibility) =====

  /**
   * Returns chart data in the original format for the /reports endpoint.
   * Refactored to use ReportingRepository instead of direct prisma calls.
   * Will be deprecated once the new dashboard endpoints are active.
   *
   * `departmentIds` null/undefined = unrestricted (company admin); an array
   * limits every section to those departments. The /reports route used to call
   * this with no scope at all, so a manager assigned to one department read the
   * whole organisation's utilisation and hours off the reports page.
   */
  async getDashboardReports(
    organizationId: string,
    departmentIds?: string[] | null
  ): Promise<ReportingData> {
    // A scoped manager with NO departments must see nothing, not everything.
    // Short-circuited here rather than passed down because the shared
    // repository helpers below test `departmentIds?.length`, which reads an
    // empty array as "unrestricted" — the opposite answer.
    if (departmentIds != null && departmentIds.length === 0) {
      return {
        completionTrend: [],
        staffUtilization: [],
        departmentWorkload: [],
        hoursSummary: { totalLogged: 0, totalCapacity: 0, percentage: 0 },
      };
    }

    // Day boundaries in the organisation's timezone. A bare setHours(0,0,0,0)
    // starts the day at 08:00 Singapore time on a UTC server, so every morning's
    // activity lands in the previous day's bucket.
    const now = new Date();
    const todayStart = startOfDayInTimeZone(now);
    const sevenDaysAgo = new Date(todayStart.getTime() - 7 * DAY_MS);
    const tomorrow = new Date(todayStart.getTime() + DAY_MS);

    const [completionChart, staffUtilization, deptMetrics, settings, clockData, staffCount] =
      await Promise.all([
        this.getCompletionChart(organizationId, departmentIds ?? undefined),
        this.getStaffUtilization(organizationId, departmentIds ?? undefined),
        this.reportingRepo.getDepartmentMetrics(organizationId, departmentIds),
        this.settingsRepo.getOrCreate(organizationId),
        this.reportingRepo.getClockData(
          organizationId,
          sevenDaysAgo,
          departmentIds ?? undefined
        ),
        this.reportingRepo.getActiveStaffCount(
          organizationId,
          departmentIds ?? undefined
        ),
      ]);

    // Compute total hours logged
    let totalLogged = 0;
    for (const r of clockData) {
      totalLogged +=
        (r.clockOutTime.getTime() - r.clockInTime.getTime()) / (1000 * 60 * 60);
    }
    totalLogged = Math.round(totalLogged * 10) / 10;

    const totalCapacity = staffCount * settings.workingDayHours * 7;

    return {
      completionTrend: completionChart.map((d) => ({
        date: d.date,
        label: d.label,
        completed: d.count,
      })),
      staffUtilization: staffUtilization.map((s) => ({
        name: s.name,
        hoursWorked: s.hoursWorked,
        capacity: s.capacity,
        percentage: s.percentage,
      })),
      departmentWorkload: deptMetrics.map((d) => ({
        name: d.name,
        color: d.color,
        taskCount: d.activeTaskCount,
        completedCount: 0, // no longer tracked separately; legacy field
      })),
      hoursSummary: {
        totalLogged,
        totalCapacity,
        percentage:
          totalCapacity > 0
            ? Math.round((totalLogged / totalCapacity) * 100)
            : 0,
      },
    };
  }

  // ===== Needs Attention (Admin & Manager) =====

  /**
   * Builds a prioritized list of actionable alerts.
   * Severity order: danger → warning → info.
   * Each item includes a message and action button target.
   */
  /**
   * Upcoming shifts with fewer people on them than they need.
   *
   * Exposed as records rather than as sentences. `getNeedsAttention` renders
   * these into dashboard alerts and is the only thing that had them, so the
   * assistant reached for `getUnfillableShifts` instead — which answers a
   * different question. "Nobody is ELIGIBLE" is a much narrower claim than
   * "nobody is ASSIGNED", and a manager asking which shifts are unfilled gets
   * a near-empty answer while half the rota stands empty.
   */
  async getUnderstaffedShifts(
    organizationId: string,
    departmentIds?: string[] | null
  ) {
    return this.reportingRepo.getUnderstaffedTasks(
      organizationId,
      departmentIds ?? undefined
    );
  }

  async getNeedsAttention(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<NeedsAttentionItem[]> {
    const [
      understaffed,
      pendingAssignments,
      expiringCerts,
      pendingVerifications,
      certImpact,
      noShows,
      unfillable,
      declinePatterns,
    ] = await Promise.all([
      this.reportingRepo.getUnderstaffedTasks(organizationId, departmentIds),
      this.reportingRepo.getPendingAssignments(organizationId, departmentIds),
      this.reportingRepo.getExpiringCertifications(organizationId, 30, departmentIds),
      this.reportingRepo.getPendingCertVerifications(organizationId, departmentIds),
      this.reportingRepo.getExpiringCertificationImpact(
        organizationId,
        30,
        departmentIds
      ),
      this.getNoShowSummary(organizationId, departmentIds),
      this.getUnfillableShifts(organizationId, departmentIds),
      this.getDeclinePatterns(organizationId, departmentIds),
    ]);

    const items: NeedsAttentionItem[] = [];

    /*
     * Insight items come first, because they are the ones that say something
     * a threshold check could not.
     *
     * `getExpiringCertifications` below still reports every upcoming expiry.
     * The ids covered here are removed from it, so a certificate with real
     * consequences is described once — with the consequences — rather than
     * twice at two different strengths.
     */
    const explainedCertIds = new Set<string>();

    for (const impact of certImpact) {
      explainedCertIds.add(impact.certificationId);
      const count = impact.affectedTasks.length;
      const days = Math.ceil(
        (impact.expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      items.push({
        type: "expiring_cert_impact",
        severity: "danger",
        message: `${impact.staffName}'s ${impact.certName} expires in ${days} day${days !== 1 ? "s" : ""} — they are booked on ${count} later shift${count !== 1 ? "s" : ""} that require${count === 1 ? "s" : ""} it`,
        actionLabel: "Review",
        // Deep-linked to the matching pill. Every one of these alerts names a
        // subset and used to land the reader on "All", leaving them to find
        // again what the alert had just told them.
        actionUrl: `/org/${organizationId}/certifications?status=expiring`,
        entityId: impact.certificationId,
      });
    }

    for (const shift of unfillable) {
      items.push({
        type: "unfillable",
        severity: "danger",
        message: `${shift.title} has nobody eligible${shift.reasonSummary ? ` — ${shift.reasonSummary}` : ""}`,
        actionLabel: "View",
        actionUrl: `/org/${organizationId}/tasks`,
        entityId: shift.taskId,
      });
    }

    if (noShows.length > 0) {
      const worst = noShows[0];
      const others = noShows.length - 1;
      items.push({
        type: "no_show",
        severity: "warning",
        message:
          `${worst.staffName} accepted ${worst.count} shift${worst.count !== 1 ? "s" : ""} in the last 30 days without clocking in` +
          (others > 0 ? `, and ${others} other${others !== 1 ? "s" : ""} did the same` : ""),
        actionLabel: "View",
        actionUrl: `/org/${organizationId}/tasks`,
      });
    }

    /*
     * Decline patterns.
     *
     * This lived in the AI recommendation list, which is where it acquired two
     * problems: it asserted that the member's availability was out of date —
     * an inference the data does not support, since they may simply be busy —
     * and its action pointed at a page where a manager can only edit their own
     * schedule.
     *
     * It is a deterministic fact about the last seven days, so it belongs
     * here, and its action is a real one: ask the person who owns the
     * constraint to confirm it still holds.
     */
    for (const pattern of declinePatterns) {
      items.push({
        type: "decline_pattern",
        severity: "info",
        message:
          `${pattern.staffName} declined ${pattern.count} shifts recently` +
          (pattern.topReason ? ` — mostly ${pattern.topReason}` : ""),
        actionLabel: "Ask to review",
        actionUrl: `/api/organizations/${organizationId}/members/${pattern.userId}/request-availability`,
        actionPost: true,
        entityId: pattern.userId,
      });
    }

    // Red: understaffed tasks
    for (const task of understaffed) {
      const needed = task.requiredHeadcount - task.assignedCount;
      /*
       * WHEN, and WHERE, both of which this record already carried.
       *
       * The message named the shift and the shortfall and dropped the rest,
       * so an alert about "Bar Setup & Inventory" gave a manager no way to
       * tell Tuesday's from Thursday's — and in an organisation running the
       * same shift daily, that is most of them. The query has selected the
       * department and the schedule since it was written; only the sentence
       * was throwing them away.
       */
      const when = shiftWindowLabel(task.scheduledStart, task.scheduledEnd);
      const where = task.departmentName ? `${task.departmentName}, ` : "";
      items.push({
        type: "understaffed",
        severity: "danger",
        message: `${task.title}${when ? ` (${where}${when})` : ""} needs ${needed} more staff (${task.assignedCount}/${task.requiredHeadcount} assigned)`,
        actionLabel: "Assign",
        actionUrl: `/org/${organizationId}/tasks`,
        entityId: task.id,
      });
    }

    // Amber: pending acceptances (grouped into one alert)
    if (pendingAssignments.length > 0) {
      const uniqueNames = [
        ...new Set(pendingAssignments.map((a) => a.staffName)),
      ];
      const nameList =
        uniqueNames.length <= 3
          ? uniqueNames.join(", ")
          : `${uniqueNames.slice(0, 2).join(", ")} +${uniqueNames.length - 2} more`;
      items.push({
        type: "pending_acceptance",
        severity: "warning",
        message: `${pendingAssignments.length} assignment${pendingAssignments.length !== 1 ? "s" : ""} pending acceptance from ${nameList}`,
        actionLabel: "View",
        actionUrl: `/org/${organizationId}/tasks`,
      });
    }

    // Amber: expiring certifications. Anything already reported above with its
    // consequences is skipped — the stronger message supersedes this one.
    for (const cert of expiringCerts.filter(
      (c) => !explainedCertIds.has(c.id)
    )) {
      const daysUntil = Math.ceil(
        (cert.expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      items.push({
        type: "expiring_cert",
        severity: "warning",
        message: `${cert.staffName}'s ${cert.certName} expires in ${daysUntil} day${daysUntil !== 1 ? "s" : ""}`,
        actionLabel: "View",
        actionUrl: `/org/${organizationId}/certifications?status=expiring`,
        entityId: cert.id,
      });
    }

    // Blue: pending verifications (grouped into one alert)
    if (pendingVerifications.length > 0) {
      items.push({
        type: "pending_verification",
        severity: "info",
        message: `${pendingVerifications.length} certification${pendingVerifications.length !== 1 ? "s" : ""} awaiting verification`,
        actionLabel: "Review",
        actionUrl: `/org/${organizationId}/certifications?status=pending`,
      });
    }

    return items;
  }

  // ===== Key Metrics (Admin & Manager) =====

  /**
   * Computes three key metric cards:
   * 1. Assignment pipeline (status breakdown)
   * 2. Completion rate (this week vs last week)
   * 3. Hours logged with utilization percentage
   */
  async getKeyMetrics(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<KeyMetrics> {
    const now = new Date();

    // Week boundaries (Monday-based)
    const weekStart = this.getWeekStart(now);
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
    const lastWeekStart = new Date(weekStart.getTime() - 7 * DAY_MS);
    const sevenDaysAgo = new Date(
      startOfDayInTimeZone(now).getTime() - 7 * DAY_MS
    );

    const [statusCounts, thisWeekCount, lastWeekCount, clockData, staffCount, settings] =
      await Promise.all([
        this.reportingRepo.countAssignmentsByStatus(
          organizationId,
          weekStart,
          departmentIds
        ),
        this.reportingRepo.countCompletions(
          organizationId,
          weekStart,
          weekEnd,
          departmentIds
        ),
        this.reportingRepo.countCompletions(
          organizationId,
          lastWeekStart,
          weekStart,
          departmentIds
        ),
        this.reportingRepo.getClockData(
          organizationId,
          sevenDaysAgo,
          departmentIds
        ),
        this.reportingRepo.getActiveStaffCount(organizationId, departmentIds),
        this.settingsRepo.getOrCreate(organizationId),
      ]);

    // Assignment pipeline
    const pipeline = { total: 0, accepted: 0, pending: 0, rejected: 0, completed: 0 };
    for (const s of statusCounts) {
      pipeline.total += s.count;
      if (s.status in pipeline) {
        pipeline[s.status as keyof typeof pipeline] = s.count;
      }
    }

    // Completion trend
    let trend: "up" | "down" | "flat" = "flat";
    if (thisWeekCount > lastWeekCount) trend = "up";
    else if (thisWeekCount < lastWeekCount) trend = "down";

    // Hours logged
    const totalHours = this.sumClockHours(clockData);
    const weeklyCapacity = staffCount * settings.workingDayHours * 7;

    return {
      assignmentPipeline: pipeline,
      completionRate: {
        current: thisWeekCount,
        previous: lastWeekCount,
        trend,
      },
      hoursLogged: {
        hours: totalHours,
        capacity: weeklyCapacity,
        utilization:
          weeklyCapacity > 0
            ? Math.round((totalHours / weeklyCapacity) * 100)
            : 0,
      },
    };
  }

  // ===== Tomorrow's Schedule (Admin & Manager) =====

  /**
   * Gets tasks scheduled for tomorrow with staffing status.
   * Understaffed tasks are flagged for action buttons.
   */
  async getTomorrowsSchedule(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<TomorrowTask[]> {
    // "Tomorrow" is the organisation's next calendar day.
    const dayStart = endOfDayInTimeZone(new Date());
    const dayEnd = new Date(dayStart.getTime() + DAY_MS - 1);

    const tasks = await this.reportingRepo.getTasksForDateRange(
      organizationId,
      dayStart,
      dayEnd,
      departmentIds
    );

    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      departmentName: t.departmentName,
      departmentColor: t.departmentColor,
      timeRange: this.formatTimeRange(t.scheduledStart, t.scheduledEnd),
      isUnderstaffed: t.assignedCount < t.requiredHeadcount,
      assignedCount: t.assignedCount,
      requiredHeadcount: t.requiredHeadcount,
    }));
  }

  // ===== Completion Chart (Admin & Manager) =====

  /**
   * Builds 7-day completion bar chart data.
   * Returns one entry per day with zero-fill for days with no completions.
   * Single repository query replaces the old 7-loop pattern.
   */
  async getCompletionChart(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<CompletionDay[]> {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const now = new Date();
    const todayStart = startOfDayInTimeZone(now);
    const endDate = new Date(todayStart.getTime() + DAY_MS);
    const startDate = new Date(todayStart.getTime() - 6 * DAY_MS);

    const timestamps = await this.reportingRepo.getCompletionTimestamps(
      organizationId,
      startDate,
      endDate,
      departmentIds
    );

    // Group by date string (local timezone)
    const countMap = new Map<string, number>();
    for (const t of timestamps) {
      const dateKey = this.formatLocalDate(t.completedAt);
      countMap.set(dateKey, (countMap.get(dateKey) || 0) + 1);
    }

    // Build 7-day array with zero-fill
    const days: CompletionDay[] = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(todayStart.getTime() - i * DAY_MS);
      const dateKey = this.formatLocalDate(date);

      days.push({
        date: dateKey,
        label: dayNames[dayOfWeekInTimeZone(date)],
        count: countMap.get(dateKey) || 0,
      });
    }

    return days;
  }

  // ===== Staff Utilization (Admin & Manager) =====

  /**
   * Computes hours worked per staff member over the last 7 days.
   * Includes all active staff — those with 0 hours appear as low utilization.
   * Sorted by utilization percentage descending.
   */
  async getStaffUtilization(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<StaffUtilizationItem[]> {
    const sevenDaysAgo = new Date(
      startOfDayInTimeZone(new Date()).getTime() - 7 * DAY_MS
    );

    const [clockData, allStaff, settings] = await Promise.all([
      this.reportingRepo.getClockData(organizationId, sevenDaysAgo, departmentIds),
      this.reportingRepo.getActiveStaffList(organizationId, departmentIds),
      this.settingsRepo.getOrCreate(organizationId),
    ]);

    const weeklyCapacity = settings.workingDayHours * 7;

    // Group hours by membership
    const hoursMap = new Map<string, number>();
    for (const r of clockData) {
      const hours =
        (r.clockOutTime.getTime() - r.clockInTime.getTime()) / (1000 * 60 * 60);
      hoursMap.set(r.membershipId, (hoursMap.get(r.membershipId) || 0) + hours);
    }

    // Build utilization for all staff (including 0-hour)
    const items: StaffUtilizationItem[] = allStaff.map((staff) => {
      const hoursWorked = Math.round((hoursMap.get(staff.membershipId) || 0) * 10) / 10;
      return {
        membershipId: staff.membershipId,
        name: staff.name,
        hoursWorked,
        capacity: weeklyCapacity,
        percentage:
          weeklyCapacity > 0
            ? Math.round((hoursWorked / weeklyCapacity) * 100)
            : 0,
      };
    });

    // Sort by utilization descending
    return items.sort((a, b) => b.percentage - a.percentage);
  }

  // ===== Department Workload (Admin) =====

  /**
   * Gets department task-to-staff ratios with imbalance detection.
   * A department is imbalanced when it has tasks but no staff,
   * or when the task-to-staff ratio exceeds 5:1.
   */
  async getDepartmentWorkload(
    organizationId: string,
    /**
     * Added 2026-08-02. The repository has always accepted a scope; this method
     * silently dropped it, so a department-scoped manager saw the task and
     * staff counts of every department in the organisation. The dashboard
     * route happened to be safe because it never called this one — the PDF
     * export did.
     */
    departmentIds?: string[]
  ): Promise<DepartmentWorkloadItem[]> {
    const metrics = await this.reportingRepo.getDepartmentMetrics(
      organizationId,
      departmentIds
    );

    return metrics.map((d) => ({
      id: d.id,
      name: d.name,
      color: d.color,
      taskCount: d.activeTaskCount,
      staffCount: d.staffCount,
      isImbalanced:
        (d.activeTaskCount > 0 && d.staffCount === 0) ||
        (d.staffCount > 0 && d.activeTaskCount / d.staffCount > 5),
    }));
  }

  // ===== Rejection Trends (Admin & Manager) =====

  /**
   * Groups rejection data by staff member with reason breakdown.
   * Sorted by rejection count descending (most rejections first).
   * The AI recommendations service can use this for pattern analysis.
   */
  async getRejectionTrends(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<RejectionTrendItem[]> {
    const sevenDaysAgo = new Date(
      startOfDayInTimeZone(new Date()).getTime() - 7 * DAY_MS
    );

    const rejections = await this.reportingRepo.getRejectionData(
      organizationId,
      sevenDaysAgo,
      departmentIds
    );

    // Group by staff
    const staffMap = new Map<
      string,
      { name: string; reasons: Map<string, number> }
    >();

    for (const r of rejections) {
      if (!staffMap.has(r.membershipId)) {
        staffMap.set(r.membershipId, {
          name: r.staffName,
          reasons: new Map(),
        });
      }
      const entry = staffMap.get(r.membershipId)!;
      const reason = r.rejectionReason || "unspecified";
      entry.reasons.set(reason, (entry.reasons.get(reason) || 0) + 1);
    }

    // Build sorted result
    const items: RejectionTrendItem[] = [];
    for (const [membershipId, data] of staffMap) {
      const reasons = Array.from(data.reasons.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);

      items.push({
        staffName: data.name,
        membershipId,
        rejectionCount: reasons.reduce((sum, r) => sum + r.count, 0),
        reasons,
      });
    }

    return items.sort((a, b) => b.rejectionCount - a.rejectionCount);
  }

  // ===== Team Roster (Manager) =====

  /**
   * Gets team members with current shift status for the manager dashboard.
   * Status badges: "on_shift" (green), "has_pending" (amber),
   * "available" (gray), "off_today" (gray).
   */
  async getTeamRoster(
    organizationId: string,
    departmentIds: string[]
  ): Promise<TeamMemberItem[]> {
    const now = new Date();
    const todayStart = startOfDayInTimeZone(now);
    const todayEnd = new Date(endOfDayInTimeZone(now).getTime() - 1);
    const dayOfWeek = dayOfWeekInTimeZone(now);

    const members = await this.reportingRepo.getTeamMembers(
      organizationId,
      departmentIds,
      todayStart,
      todayEnd,
      dayOfWeek
    );

    return members.map((m) => {
      let status: TeamMemberItem["status"];
      let statusLabel: string;

      /*
       * A member awaiting a decision on a decline or a withdrawal is still
       * rostered. The repository fetches them for exactly that reason — its
       * comment says they are expected to turn up until it is resolved — and
       * narrowing to `accepted` here threw that away, so someone whose decline
       * was pending appeared as "Available" or "Off today" to the manager
       * looking for cover for that very shift.
       */
      const hasAccepted = m.todayAssignments.some((a) =>
        occupiesSlot(a.status)
      );
      const hasPending = m.pendingCount > 0;
      const isAvailable = m.availability?.isAvailable ?? false;

      if (hasAccepted) {
        status = "on_shift";
        statusLabel = "On shift";
      } else if (hasPending) {
        status = "has_pending";
        statusLabel = `${m.pendingCount} pending`;
      } else if (isAvailable) {
        status = "available";
        statusLabel = "Available";
      } else {
        status = "off_today";
        statusLabel = "Off today";
      }

      return {
        membershipId: m.membershipId,
        name: m.staffName,
        status,
        statusLabel,
        pendingCount: m.pendingCount,
      };
    });
  }

  // ===== Staff Dashboard =====

  /**
   * Builds the complete staff personal dashboard data bundle.
   * Includes hours, next shift, weekly calendar, certifications, and stats.
   */
  async getStaffDashboardData(
    membershipId: string,
    organizationId: string
  ): Promise<StaffDashboardData> {
    const now = new Date();
    const weekStart = this.getWeekStart(now);
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);

    // First of the month, organisation time. The local Date constructor would
    // use the server's month, which flips a day early at the boundary.
    const [monthYear, monthNumber] = localDateInTimeZone(now)
      .split("-")
      .map(Number);
    const monthStart = startOfDayInTimeZone(
      new Date(Date.UTC(monthYear, monthNumber - 1, 1, 12))
    );

    const [
      weekAssignments,
      availability,
      certifications,
      assignmentHistory,
      settings,
      clockDataWeek,
      clockDataMonth,
    ] = await Promise.all([
      this.reportingRepo.getStaffAssignments(membershipId, weekStart, weekEnd),
      this.reportingRepo.getStaffAvailability(membershipId),
      this.reportingRepo.getStaffCertifications(membershipId),
      this.reportingRepo.getStaffAssignmentHistory(membershipId, monthStart),
      this.settingsRepo.getOrCreate(organizationId),
      this.reportingRepo.getClockData(organizationId, weekStart),
      this.reportingRepo.getClockData(organizationId, monthStart),
    ]);

    // Hours this week (for this specific staff member)
    const myClockWeek = clockDataWeek.filter(
      (r) => r.membershipId === membershipId
    );
    const hoursThisWeek = this.sumClockHours(myClockWeek);

    const myClockMonth = clockDataMonth.filter(
      (r) => r.membershipId === membershipId
    );
    const hoursThisMonth = this.sumClockHours(myClockMonth);

    // Next upcoming shift
    // `getStaffAssignments` has already dropped everything released, so a
    // second status list here could only ever remove shifts the member is
    // still on. It removed the two awaiting a manager's decision — telling
    // someone their next shift was the one AFTER the one they are rostered
    // for, while the week calendar below still drew both.
    const upcoming = weekAssignments.find(
      (a) => a.scheduledStart && a.scheduledStart > now
    );
    const nextShift = upcoming?.scheduledStart && upcoming?.scheduledEnd
      ? {
          taskName: upcoming.taskTitle,
          scheduledStart: upcoming.scheduledStart,
          scheduledEnd: upcoming.scheduledEnd,
        }
      : null;

    // Tasks this week summary — a shift is "done" once clocked out or completed
    const activeWeekAssignments = weekAssignments.filter(
      (a) => !["clocked_out", "completed"].includes(a.status)
    );
    const pendingWeekCount = weekAssignments.filter(
      (a) => a.status === "pending"
    ).length;

    // Personal stats from assignment history
    const totalAssignments = assignmentHistory.length;
    /*
     * Shifts they were asked to work despite saying they were unavailable are
     * excluded from the acceptance rate entirely — the decline AND the accept.
     *
     * A manager may waive an availability block with a reason, and the
     * assignment is then written as an offer rather than a booking. That
     * only means something if saying no is free. If a decline dented the
     * member's own acceptance rate, the "offer" would carry a penalty for
     * refusing it, and a figure on their dashboard would be quietly punishing
     * them for a boundary they had already stated. That is the difference
     * between asking somebody and pressuring them.
     *
     * The accept is dropped as well, not just the decline. Keeping it would
     * let a manager improve someone's rate by asking them to work days off,
     * which is the same lever pointing the other way.
     */
    const excused = await this.overrideRepo.consentOverriddenTaskIds(
      membershipId,
      monthStart
    );
    const counted = assignmentHistory.filter((a) => !excused.has(a.taskId));

    const acceptedOrCompleted = counted.filter(
      (a) => ["accepted", "clocked_out", "completed"].includes(a.status)
    ).length;
    const rejectedCount = counted.filter(
      (a) => a.status === "rejected"
    ).length;
    const decidedCount = acceptedOrCompleted + rejectedCount;

    const onTimeCount = assignmentHistory.filter(
      (a) =>
        a.clockInTime &&
        a.scheduledStart &&
        a.clockInTime <= new Date(a.scheduledStart.getTime() + 5 * 60 * 1000) // 5-min grace
    ).length;
    const clockedInCount = assignmentHistory.filter(
      (a) => a.clockInTime !== null
    ).length;

    return {
      hoursThisWeek,
      weeklyCapacity: settings.workingDayHours * 7,
      nextShift,
      tasksThisWeek: {
        total: activeWeekAssignments.length,
        pending: pendingWeekCount,
      },
      weekAssignments,
      availability,
      certifications,
      stats: {
        shiftsThisMonth: assignmentHistory.filter(
          (a) => ["clocked_out", "completed"].includes(a.status)
        ).length,
        hoursThisMonth: Math.round(hoursThisMonth * 10) / 10,
        acceptanceRate:
          decidedCount > 0
            ? Math.round((acceptedOrCompleted / decidedCount) * 100)
            : 100,
        onTimeRate:
          clockedInCount > 0
            ? Math.round((onTimeCount / clockedInCount) * 100)
            : 100,
      },
    };
  }

  // ===== Calendar Coverage (Heatmap) =====

  /**
   * Computes staff availability coverage for each hour of each day.
   * Returns a matrix with coverage counts per hour slot.
   * Used for calendar heatmap background tints.
   * Respects operating hours from settings.
   *
   * `departmentIds` null/undefined = unrestricted (company admin); an array
   * counts only staff in those departments. The parameter was declared here
   * long before it was honoured — the body ignored it and the route never
   * passed one — so a manager scoped to one department saw the whole
   * organisation's coverage.
   */
  async getCalendarCoverage(
    organizationId: string,
    departmentIds?: string[] | null
  ): Promise<{ dayOfWeek: number; hour: number; count: number }[]> {
    const schedules = await this.reportingRepo.getAllStaffAvailability(
      organizationId,
      departmentIds
    );

    // Build coverage matrix
    const coverage: { dayOfWeek: number; hour: number; count: number }[] = [];

    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const hourStr = `${String(hour).padStart(2, "0")}:00`;
        const nextHourStr = `${String(hour + 1).padStart(2, "0")}:00`;

        let count = 0;
        const seen = new Set<string>();

        for (const s of schedules) {
          if (s.dayOfWeek !== day || !s.isAvailable) continue;
          if (seen.has(s.membershipId)) continue;

          if (s.startTime <= hourStr && s.endTime >= nextHourStr) {
            count++;
            seen.add(s.membershipId);
          }
        }

        coverage.push({ dayOfWeek: day, hour, count });
      }
    }

    return coverage;
  }

  /**
   * Gets all active staff members with their weekly availability schedules.
   * Used for the calendar day-view staff panel.
   * Groups flat availability records by staff member.
   *
   * `departmentIds` null/undefined = unrestricted (company admin); an array
   * returns only staff in those departments. Without it the calendar's staff
   * panel listed every member of the organisation — names and working hours —
   * to a manager who has no business seeing other departments' rosters.
   */
  async getAllStaffSchedules(
    organizationId: string,
    departmentIds?: string[] | null
  ): Promise<
    {
      membershipId: string;
      name: string;
      schedules: { dayOfWeek: number; startTime: string; endTime: string; isAvailable: boolean }[];
    }[]
  > {
    const data = await this.reportingRepo.getAllStaffAvailability(
      organizationId,
      departmentIds
    );

    const staffMap = new Map<
      string,
      {
        membershipId: string;
        name: string;
        schedules: { dayOfWeek: number; startTime: string; endTime: string; isAvailable: boolean }[];
      }
    >();

    for (const s of data) {
      if (!staffMap.has(s.membershipId)) {
        staffMap.set(s.membershipId, {
          membershipId: s.membershipId,
          name: s.membership.user.name || s.membership.user.email,
          schedules: [],
        });
      }
      staffMap.get(s.membershipId)!.schedules.push({
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        isAvailable: s.isAvailable,
      });
    }

    return Array.from(staffMap.values());
  }

  // ===== Private Helpers =====

  /**
   * Gets Monday 00:00 of the week containing the given date, in the
   * organisation's timezone. Both the weekday and the boundary have to be
   * resolved there — on a UTC server the weekday flips eight hours early, so
   * Monday morning in Singapore reports the previous week.
   */
  private getWeekStart(date: Date): Date {
    const day = dayOfWeekInTimeZone(date);
    const diff = day === 0 ? -6 : 1 - day; // Monday = 1, Sunday wraps back
    return startOfDayInTimeZone(new Date(date.getTime() + diff * DAY_MS));
  }

  /** Formats a time range string from two dates, e.g. "7:00am–10:00am" */
  private formatTimeRange(
    start: Date | null,
    end: Date | null
  ): string | null {
    if (!start || !end) return null;

    // Rendered in the organisation's timezone: a shift shown as "7:00am" must
    // be 7am to the staff member, not 7am wherever the function happens to run.
    const fmt = (d: Date) => {
      const parts = d.toLocaleTimeString("en-US", {
        timeZone: DEFAULT_TIMEZONE,
        hour: "numeric",
        minute: "2-digit",
        hour12: false,
      });
      const [hours, minutes] = parts.split(":").map(Number);
      const period = hours >= 12 ? "pm" : "am";
      const h = hours % 12 || 12;
      return minutes > 0
        ? `${h}:${String(minutes).padStart(2, "0")}${period}`
        : `${h}${period}`;
    };

    return `${fmt(start)}–${fmt(end)}`;
  }

  /** Sums clock-in/out durations to total hours (rounded to 1 decimal) */
  private sumClockHours(
    records: { clockInTime: Date; clockOutTime: Date }[]
  ): number {
    let total = 0;
    for (const r of records) {
      total +=
        (r.clockOutTime.getTime() - r.clockInTime.getTime()) / (1000 * 60 * 60);
    }
    return Math.round(total * 10) / 10;
  }

  /**
   * Formats a Date as YYYY-MM-DD in the ORGANISATION's timezone.
   *
   * The original avoided toISOString() for the right reason — it shifts the date
   * in zones ahead of UTC — but reached for the local getters, which are the
   * server's zone. Correct on a Singapore laptop, eight hours out on Vercel.
   */
  private formatLocalDate(d: Date): string {
    return localDateInTimeZone(d);
  }

  // ─── Company-admin dashboard summaries (PRD 3.15) ─────────────────────────

  /**
   * Task summary — counts by TASK status (distinct from the assignment
   * pipeline in key metrics, which counts assignments).
   */
  async getTaskSummary(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<TaskSummary> {
    const rows = await this.reportingRepo.countTasksByStatus(
      organizationId,
      departmentIds
    );

    const summary: TaskSummary = {
      total: 0,
      open: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    };

    for (const row of rows) {
      summary.total += row.count;
      if (row.status in summary) {
        summary[row.status as keyof Omit<TaskSummary, "total">] = row.count;
      }
    }

    return summary;
  }

  /** Certification summary — verification backlog and expiry health. */
  async getCertificationSummary(
    organizationId: string
  ): Promise<CertificationSummary> {
    const counts = await this.reportingRepo.getCertificationCounts(
      organizationId,
      30
    );
    return {
      ...counts,
      total: counts.verified + counts.pending + counts.rejected,
    };
  }

  /**
   * Coverage summary for the next 7 days: how many upcoming tasks are fully
   * staffed vs short vs completely unassigned, plus an overall coverage %
   * (filled slots / required slots).
   */
  async getCoverageSummary(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<CoverageSummary> {
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 7);

    const tasks = await this.reportingRepo.getUpcomingCoverage(
      organizationId,
      from,
      to,
      departmentIds
    );

    let fullyStaffed = 0;
    let understaffed = 0;
    let unassigned = 0;
    let requiredSlots = 0;
    let filledSlots = 0;

    for (const t of tasks) {
      const required = Math.max(1, t.requiredHeadcount);
      requiredSlots += required;
      // A task can't be "more than filled" — cap so over-assignment can't
      // push coverage above 100%.
      filledSlots += Math.min(t.assignedCount, required);

      if (t.assignedCount === 0) unassigned++;
      else if (t.assignedCount < required) understaffed++;
      else fullyStaffed++;
    }

    return {
      upcomingTasks: tasks.length,
      fullyStaffed,
      understaffed,
      unassigned,
      coveragePercent:
        requiredSlots === 0
          ? 100
          : Math.round((filledSlots / requiredSlots) * 100),
    };
  }

  // ============================================================
  // Smart-engine panels
  // ============================================================

  /**
   * Evidence that the allocation engine is doing work, and what kind.
   *
   * The honest framing matters here. `unrecorded` counts assignments made
   * before provenance existed, or by a path nobody has instrumented — it is
   * neither a success nor a failure of the engine, and it is reported rather
   * than hidden so the percentages below cannot quietly be computed against a
   * flattering denominator.
   *
   * `topPickRetained` is the closest thing to an accuracy measure the system
   * can honestly produce: of the assignments where the engine ranked someone
   * first, how many were still standing rather than rejected or withdrawn.
   * It is not "the AI was right" — a shift can fall through for reasons no
   * ranking could anticipate — but it is a real signal and it moves when the
   * engine gets better or worse.
   */
  async getAllocationEngineStats(
    organizationId: string,
    windowDays = 30,
    departmentIds?: string[] | null
  ): Promise<AllocationEngineStats> {
    const since = new Date(
      startOfDayInTimeZone(new Date()).getTime() - windowDays * DAY_MS
    );

    const [bySource, byProvider, engineRows, totalAssignments] = await Promise.all([
      this.reportingRepo.countAssignmentsBySource(organizationId, since, departmentIds),
      this.reportingRepo.countAssignmentsByProvider(organizationId, since, departmentIds),
      this.reportingRepo.getEngineAssignments(organizationId, since, departmentIds),
      this.reportingRepo.countAssignmentsSince(organizationId, since, departmentIds),
    ]);

    const sourceCounts: Record<string, number> = {};
    let unrecorded = 0;
    for (const row of bySource) {
      if (row.source === null) unrecorded += row.count;
      else sourceCounts[row.source] = (sourceCounts[row.source] ?? 0) + row.count;
    }

    const providerCounts: Record<string, number> = {};
    for (const row of byProvider) {
      // A provider of null on an engine-made row means the strategy was not
      // captured — possible on auto-schedule rows whose client did not echo
      // it back. Kept separate from "algorithmic", which is a real strategy.
      const key = row.provider ?? "unrecorded";
      providerCounts[key] = (providerCounts[key] ?? 0) + row.count;
    }

    const FELL_THROUGH = ["rejected", "withdrawn"];
    const topPicks = engineRows.filter((r) => r.rank === 1);
    const topPicksRetained = topPicks.filter(
      (r) => !FELL_THROUGH.includes(r.status)
    ).length;
    const otherPicks = engineRows.filter((r) => r.rank !== null && r.rank > 1);
    const otherRetained = otherPicks.filter(
      (r) => !FELL_THROUGH.includes(r.status)
    ).length;

    const scored = engineRows.filter(
      (r): r is typeof r & { score: number } => typeof r.score === "number"
    );
    const averageScore =
      scored.length > 0
        ? Math.round(
            (scored.reduce((sum, r) => sum + r.score, 0) / scored.length) * 10
          ) / 10
        : null;

    return {
      windowDays,
      totalAssignments,
      unrecorded,
      sourceCounts,
      providerCounts,
      engineAssignments: engineRows.length,
      averageScore,
      topPick: {
        total: topPicks.length,
        retained: topPicksRetained,
        percentage:
          topPicks.length > 0
            ? Math.round((topPicksRetained / topPicks.length) * 100)
            : null,
      },
      otherPicks: {
        total: otherPicks.length,
        retained: otherRetained,
        percentage:
          otherPicks.length > 0
            ? Math.round((otherRetained / otherPicks.length) * 100)
            : null,
      },
    };
  }

  /**
   * Evidence that the constraint engine is real and being used.
   *
   * An override is a manager telling the system it was wrong — so a high
   * override rate is not necessarily a bug, but a rate of zero across a busy
   * month usually means nobody is hitting the rules at all, which is worth
   * knowing before claiming the engine constrains anything.
   */
  async getEligibilityEngineStats(
    organizationId: string,
    windowDays = 30,
    departmentIds?: string[] | null
  ): Promise<EligibilityEngineStats> {
    const since = new Date(
      startOfDayInTimeZone(new Date()).getTime() - windowDays * DAY_MS
    );

    const [byRule, totalOverrides, totalAssignments] = await Promise.all([
      this.reportingRepo.countOverridesByRule(organizationId, since, departmentIds),
      this.reportingRepo.countOverrides(organizationId, since, departmentIds),
      this.reportingRepo.countAssignmentsSince(organizationId, since, departmentIds),
    ]);

    const ruleCounts: Record<string, number> = {};
    for (const row of byRule) {
      ruleCounts[row.rule] = (ruleCounts[row.rule] ?? 0) + row.count;
    }

    return {
      windowDays,
      totalOverrides,
      totalAssignments,
      ruleCounts,
      overrideRate:
        totalAssignments > 0
          ? Math.round((totalOverrides / totalAssignments) * 100)
          : null,
    };
  }

  /**
   * How quickly staff answer, and how much notice they give when dropping out.
   *
   * ## Why this could not be asked before
   *
   * Every status change overwrote `updatedAt`, so by the time a shift was
   * worked there was no record of when it had been accepted. Nothing in the
   * product could answer "are responses getting faster or slower?" — not
   * because the query was hard, but because the fact had been overwritten.
   *
   * ## Why the median rather than the mean
   *
   * One person who accepted after a fortnight's leave moves a mean of twenty
   * responses by most of a day. The median is what a manager actually wants:
   * the experience of a typical assignment.
   */
  async getResponseStats(
    organizationId: string,
    windowDays = 30,
    departmentIds?: string[] | null
  ): Promise<ResponseStats> {
    const since = new Date(
      startOfDayInTimeZone(new Date()).getTime() - windowDays * DAY_MS
    );

    const [rows, withdrawals] = await Promise.all([
      this.reportingRepo.getResponseTimings(organizationId, since, departmentIds),
      this.reportingRepo.getWithdrawalNotice(organizationId, since, departmentIds),
    ]);

    const durations: number[] = [];
    let accepted = 0;
    let declined = 0;
    let awaiting = 0;
    let unanswered = 0;

    for (const row of rows) {
      const answeredAt = row.acceptedAt ?? row.rejectedAt;

      if (!answeredAt) {
        // Pending means the clock is still running; anything else with no
        // timestamp was never answered by a person at all.
        if (row.status === "pending") awaiting += 1;
        else unanswered += 1;
        continue;
      }

      if (row.acceptedAt) accepted += 1;
      else declined += 1;

      // Clamp at zero. A clock skew between the app server and the database
      // can put an acceptance a few milliseconds before its own assignment,
      // and a negative response time would drag the median below what anyone
      // could achieve.
      durations.push(Math.max(0, answeredAt.getTime() - row.createdAt.getTime()));
    }

    const answered = accepted + declined;
    const noticeHours = withdrawals.map((w) =>
      Math.max(0, (w.scheduledStart.getTime() - w.requestedAt.getTime()) / HOUR_MS)
    );

    return {
      windowDays,
      totalOffered: rows.length,
      answered,
      awaiting,
      unanswered,
      accepted,
      declined,
      acceptanceRate: answered > 0 ? Math.round((accepted / answered) * 100) : null,
      medianResponseHours: roundOrNull(median(durations.map((ms) => ms / HOUR_MS))),
      withinFourHours: durations.filter((ms) => ms <= 4 * HOUR_MS).length,
      withdrawals: {
        count: withdrawals.length,
        medianNoticeHours: roundOrNull(median(noticeHours)),
        underOneDay: noticeHours.filter((h) => h < 24).length,
      },
    };
  }

  /**
   * What staff thought of the shifts they worked.
   *
   * ## Why the response count is as prominent as the average
   *
   * A 4.8 from three people is not a finding. Every figure here is reported
   * beside the number behind it, and a department is only broken out once it
   * clears `MIN_GROUP_RESPONSES` — otherwise a single bad night puts a whole
   * department bottom of a list a manager will act on.
   *
   * ## The engine comparison
   *
   * This is the join the allocation provenance work was for. "The engine's top
   * pick was accepted" and "the engine's top pick was a shift the person was
   * glad to work" are different claims, and the second is the one worth
   * making. Both sides stay null until each has enough responses, because the
   * failure mode of this comparison is a confident conclusion from four data
   * points.
   */
  async getSatisfactionStats(
    organizationId: string,
    windowDays = 30,
    departmentIds?: string[] | null
  ): Promise<SatisfactionStats> {
    const since = new Date(
      startOfDayInTimeZone(new Date()).getTime() - windowDays * DAY_MS
    );

    const [ratings, rateable] = await Promise.all([
      this.reportingRepo.getShiftRatings(organizationId, since, departmentIds),
      this.reportingRepo.countRateableShifts(organizationId, since, departmentIds),
    ]);

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of ratings) {
      distribution[r.rating] = (distribution[r.rating] ?? 0) + 1;
    }

    const byDeptMap = new Map<string, { name: string; departmentId: string | null; values: number[] }>();
    for (const r of ratings) {
      const key = r.departmentId ?? "__none__";
      const entry = byDeptMap.get(key) ?? {
        name: r.departmentName ?? "No department",
        departmentId: r.departmentId,
        values: [],
      };
      entry.values.push(r.rating);
      byDeptMap.set(key, entry);
    }

    const byDepartment = [...byDeptMap.values()]
      .filter((e) => e.values.length >= MIN_GROUP_RESPONSES)
      .map((e) => ({
        departmentId: e.departmentId,
        name: e.name,
        average: round1(mean(e.values)!),
        responses: e.values.length,
      }))
      .sort((a, b) => a.average - b.average);

    const topPickValues = ratings.filter((r) => r.allocationRank === 1).map((r) => r.rating);
    const otherValues = ratings
      .filter((r) => r.allocationRank !== null && r.allocationRank > 1)
      .map((r) => r.rating);

    return {
      windowDays,
      responses: ratings.length,
      rateable,
      average: roundOrNull(mean(ratings.map((r) => r.rating))),
      distribution,
      byDepartment,
      engineComparison: {
        topPickAverage:
          topPickValues.length >= MIN_GROUP_RESPONSES ? round1(mean(topPickValues)!) : null,
        topPickResponses: topPickValues.length,
        otherAverage:
          otherValues.length >= MIN_GROUP_RESPONSES ? round1(mean(otherValues)!) : null,
        otherResponses: otherValues.length,
      },
      // Comments carry staff names implicitly through the task they worked, so
      // this stays inside the department scope the caller was given like every
      // other query here. Bounded because it renders in a panel, not a report.
      recentComments: ratings
        .filter((r): r is typeof r & { comment: string } => Boolean(r.comment?.trim()))
        .slice(0, MAX_RECENT_COMMENTS)
        .map((r) => ({
          rating: r.rating,
          comment: r.comment,
          taskTitle: r.taskTitle,
          ratedAt: r.ratedAt,
        })),
    };
  }

  /**
   * People who have declined several shifts in the last week.
   *
   * Two or more, because one decline is a Tuesday, not a pattern — the same
   * threshold the old recommendation used.
   *
   * The message states what happened and stops there. It deliberately does NOT
   * conclude that the member's availability is wrong: repeated declines for
   * schedule conflicts are equally consistent with someone being busy, and a
   * confident wrong alert costs trust in every other row on the page.
   */
  async getDeclinePatterns(
    organizationId: string,
    departmentIds?: string[]
  ): Promise<{ userId: string; staffName: string; count: number; topReason: string | null }[]> {
    const since = new Date(startOfDayInTimeZone(new Date()).getTime() - 7 * DAY_MS);
    const rejections = await this.reportingRepo.getRejectionData(
      organizationId,
      since,
      departmentIds
    );

    const byUser = new Map<
      string,
      { staffName: string; count: number; reasons: Map<string, number> }
    >();

    for (const r of rejections) {
      const entry = byUser.get(r.userId) ?? {
        staffName: r.staffName,
        count: 0,
        reasons: new Map<string, number>(),
      };
      entry.count += 1;
      if (r.rejectionReason) {
        entry.reasons.set(r.rejectionReason, (entry.reasons.get(r.rejectionReason) ?? 0) + 1);
      }
      byUser.set(r.userId, entry);
    }

    return [...byUser.entries()]
      .filter(([, e]) => e.count >= MIN_DECLINES_FOR_PATTERN)
      .map(([userId, e]) => {
        const top = [...e.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
        return {
          userId,
          staffName: e.staffName,
          count: e.count,
          // Humanised. The raw column holds enum keys, and "exceeds_preferred_hours"
          // printed at a manager is a database value leaking through the UI.
          topReason: top ? REASON_PHRASE[top[0] as DeclineReason] ?? null : null,
        };
      })
      .sort((a, b) => b.count - a.count);
  }

  // ===== Insights =====

  /**
   * Upcoming shifts that literally nobody can work.
   *
   * This is the engine looking FORWARD rather than reporting the present. An
   * understaffed alert says a shift is short; this says filling it is currently
   * impossible, and why — which is a different problem with a different fix
   * (change the time, lift a limit, get someone certified).
   *
   * Bounded twice on purpose. `HORIZON_DAYS` keeps the window to work that can
   * still be changed, and `MAX_EVALUATIONS` caps how many per-task eligibility
   * passes a single dashboard load can trigger — each one evaluates every
   * member of the organisation, so an unbounded version would be the slowest
   * query in the product. Shifts are examined soonest-first, so the cap drops
   * the least urgent.
   */
  async getUnfillableShifts(
    organizationId: string,
    departmentIds?: string[] | null
  ): Promise<{ taskId: string; title: string; reasonSummary: string }[]> {
    const HORIZON_DAYS = 14;
    const MAX_EVALUATIONS = 10;

    const now = new Date();
    const candidates = await this.reportingRepo.getUpcomingUnfilledTasks(
      organizationId,
      now,
      new Date(now.getTime() + HORIZON_DAYS * DAY_MS),
      departmentIds
    );
    if (candidates.length === 0) return [];

    // Imported lazily: EligibilityService reaches back into reporting-adjacent
    // repositories, and a field here would make the construction order matter.
    const { EligibilityService } = await import("@/services/eligibility.service");
    const eligibilityService = new EligibilityService();

    const unfillable: { taskId: string; title: string; reasonSummary: string }[] = [];

    for (const task of candidates.slice(0, MAX_EVALUATIONS)) {
      let staff;
      try {
        staff = await eligibilityService.checkEligibilityForTask(
          task.id,
          organizationId
        );
      } catch {
        // One unreadable task must not cost the whole dashboard its alerts.
        continue;
      }

      // Nobody to consider is not the same as nobody eligible. An empty
      // candidate list means the department has no staff at all, which the
      // understaffed alert already covers — reporting it here as "nobody
      // eligible" would double up and imply a constraint problem that is
      // really a headcount problem.
      if (staff.length === 0) continue;
      if (staff.some((s) => s.eligible)) continue;

      unfillable.push({
        taskId: task.id,
        title: task.title,
        reasonSummary: this.summariseBlockers(staff),
      });
    }

    return unfillable;
  }

  /**
   * "3 over hours, 2 unavailable" — why nobody can take the shift.
   *
   * Counts the FIRST failing check per person rather than every failure. A
   * member who is both over hours and unavailable is one person with one
   * headline problem; counting them twice would make the numbers exceed the
   * team size and read as nonsense.
   */
  private summariseBlockers(
    staff: { checks: Record<string, { eligible: boolean }> }[]
  ): string {
    const LABELS: Record<string, string> = {
      hoursLimit: "over hours",
      availability: "unavailable",
      scheduling: "already booked",
      workRules: "blocked by a work rule",
      certifications: "missing a certification",
    };
    const ORDER = ["hoursLimit", "availability", "scheduling", "workRules", "certifications"];

    const counts: Record<string, number> = {};
    for (const member of staff) {
      const first = ORDER.find((key) => member.checks[key]?.eligible === false);
      if (first) counts[first] = (counts[first] ?? 0) + 1;
    }

    return ORDER.filter((key) => counts[key] > 0)
      .map((key) => `${counts[key]} ${LABELS[key]}`)
      .join(", ");
  }

  /**
   * People who accepted a shift, let it finish, and never clocked in.
   *
   * Needed no new column. The absence of a clock-in on a finished shift was
   * always the signal — nobody had asked the question. Grouped by person and
   * ordered worst-first, because one missed shift is a story and four is a
   * pattern.
   */
  async getNoShowSummary(
    organizationId: string,
    departmentIds?: string[] | null,
    windowDays = 30
  ): Promise<{ membershipId: string; staffName: string; count: number }[]> {
    const rows = await this.reportingRepo.getNoShows(
      organizationId,
      new Date(Date.now() - windowDays * DAY_MS),
      departmentIds
    );

    const byMember = new Map<string, { staffName: string; count: number }>();
    for (const row of rows) {
      const existing = byMember.get(row.membershipId);
      if (existing) existing.count += 1;
      else byMember.set(row.membershipId, { staffName: row.staffName, count: 1 });
    }

    return [...byMember.entries()]
      .map(([membershipId, v]) => ({ membershipId, ...v }))
      .sort((a, b) => b.count - a.count);
  }
}
