/**
 * The shape the dashboard endpoint answers with, as the client sees it.
 *
 * Declared once here rather than three times. The three dashboards it replaces
 * each carried their own copy of `KeyMetrics` and `TomorrowTask`, which is how
 * two of them came to disagree about whether `completed` was part of the
 * assignment pipeline.
 *
 * Dates arrive as strings — they have been through JSON — so they are typed
 * that way rather than as `Date`, which the old files got wrong and papered
 * over with `new Date(...)` at every use.
 */

export interface NeedsAttentionItem {
  type: string;
  severity: "danger" | "warning" | "info";
  message: string;
  actionLabel: string;
  actionUrl: string;
  entityId?: string;
  /** True when the action POSTs to `actionUrl` rather than navigating to it. */
  actionPost?: boolean;
}

export interface StaffAssignment {
  id: string;
  status: string;
  taskId: string;
  taskTitle: string;
  departmentName: string | null;
  departmentColor: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
}

export interface StaffCert {
  id: string;
  name: string;
  status: string;
  expiryDate: string | null;
}

export interface StaffData {
  hoursThisWeek: number;
  weeklyCapacity: number;
  nextShift: {
    taskName: string;
    scheduledStart: string;
    scheduledEnd: string;
  } | null;
  tasksThisWeek: { total: number; pending: number };
  weekAssignments: StaffAssignment[];
  certifications: StaffCert[];
  stats: {
    shiftsThisMonth: number;
    hoursThisMonth: number;
    acceptanceRate: number;
    onTimeRate: number;
  };
}

export interface KeyMetrics {
  assignmentPipeline: {
    total: number;
    accepted: number;
    pending: number;
    rejected: number;
    completed: number;
  };
  completionRate: { current: number; previous: number; trend: "up" | "down" | "flat" };
  hoursLogged: { hours: number; capacity: number; utilization: number };
}

export interface CoverageSummary {
  upcomingTasks: number;
  fullyStaffed: number;
  understaffed: number;
  unassigned: number;
  coveragePercent: number;
}

export interface TaskSummary {
  total: number;
  open: number;
  in_progress: number;
  completed: number;
  cancelled: number;
}

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

export interface CompletionDay {
  date: string;
  /** The short weekday the server computed — "Mon". Not derived here. */
  label: string;
  count: number;
}

export interface StaffUtilizationItem {
  membershipId: string;
  name: string;
  hoursWorked: number;
  capacity: number;
  percentage: number;
}

export interface DepartmentWorkloadItem {
  id: string;
  name: string;
  color: string | null;
  taskCount: number;
  staffCount: number;
  isImbalanced: boolean;
}

export interface TeamMemberItem {
  membershipId: string;
  name: string;
  status: string;
  statusLabel: string;
  pendingCount: number;
}

export interface CertificationSummary {
  total: number;
  /** A STATUS count, which INCLUDES the two subsets below — see the service. */
  verified: number;
  pending: number;
  rejected: number;
  expiringSoon: number;
  expired: number;
  /** The partitioned figure. This is the one the tiles show. */
  inGoodStanding: number;
}

/** Declines grouped by REASON rather than by person — see the card. */
export interface DeclineReasonItem {
  reason: string;
  label: string;
  count: number;
}

/**
 * Every section is nullable, and null means the query FAILED.
 *
 * The route runs them with `Promise.allSettled` and writes null for a rejection,
 * so a null section is an error rather than an absence — which is why no card
 * may render null as a zero or as an "all clear".
 */
export interface DashboardResponse {
  staffData?: StaffData | null;
  needsAttention?: NeedsAttentionItem[] | null;
  keyMetrics?: KeyMetrics | null;
  tomorrowsSchedule?: TomorrowTask[] | null;
  completionChart?: CompletionDay[] | null;
  staffUtilization?: StaffUtilizationItem[] | null;
  declineReasons?: DeclineReasonItem[] | null;
  taskSummary?: TaskSummary | null;
  coverageSummary?: CoverageSummary | null;
  departmentWorkload?: DepartmentWorkloadItem[] | null;
  certificationSummary?: CertificationSummary | null;
  teamRoster?: TeamMemberItem[] | null;
}
