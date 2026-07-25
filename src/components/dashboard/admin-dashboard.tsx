/**
 * Admin Dashboard Component (Boundary Layer)
 *
 * Client component for the Company Admin dashboard view.
 * Fetches all data from GET /api/organizations/[orgId]/dashboard
 * and renders six sections:
 * 1. Needs attention (alerts with action buttons)
 * 2. Key metrics (pipeline, completion rate, hours)
 * 2b. Summaries (PRD 3.15): tasks by status, 7-day coverage, certifications
 * 3. Tomorrow's schedule + Completions chart
 * 4. Staff utilization + Department workload + Rejection trends
 * 5. AI recommendations (placeholder — separate endpoint)
 *
 * Each section handles null data gracefully (per-section resilience).
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NeedsAttention } from "@/components/dashboard/needs-attention";
import type { NeedsAttentionItem } from "@/components/dashboard/needs-attention";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";

// ============================================================
// API response types (matches ReportingService output)
// ============================================================

interface KeyMetrics {
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

interface TomorrowTask {
  id: string;
  title: string;
  departmentName: string | null;
  departmentColor: string | null;
  timeRange: string | null;
  isUnderstaffed: boolean;
  assignedCount: number;
  requiredHeadcount: number;
}

interface CompletionDay {
  date: string;
  label: string;
  count: number;
}

interface StaffUtilizationItem {
  membershipId: string;
  name: string;
  hoursWorked: number;
  capacity: number;
  percentage: number;
}

interface DepartmentWorkloadItem {
  id: string;
  name: string;
  color: string;
  taskCount: number;
  staffCount: number;
  isImbalanced: boolean;
}

interface RejectionTrendItem {
  staffName: string;
  membershipId: string;
  rejectionCount: number;
  reasons: { reason: string; count: number }[];
}

/** Tasks by TASK status — distinct from the assignment pipeline above. */
interface TaskSummary {
  total: number;
  open: number;
  in_progress: number;
  completed: number;
  cancelled: number;
}

interface CertificationSummary {
  total: number;
  verified: number;
  pending: number;
  rejected: number;
  expiringSoon: number;
  expired: number;
}

interface CoverageSummary {
  upcomingTasks: number;
  fullyStaffed: number;
  understaffed: number;
  unassigned: number;
  coveragePercent: number;
}

interface DashboardData {
  role: string;
  needsAttention: NeedsAttentionItem[] | null;
  keyMetrics: KeyMetrics | null;
  tomorrowsSchedule: TomorrowTask[] | null;
  completionChart: CompletionDay[] | null;
  staffUtilization: StaffUtilizationItem[] | null;
  departmentWorkload: DepartmentWorkloadItem[] | null;
  rejectionTrends: RejectionTrendItem[] | null;
  taskSummary: TaskSummary | null;
  certificationSummary: CertificationSummary | null;
  coverageSummary: CoverageSummary | null;
}

interface AIRecommendation {
  priority: number;
  title: string;
  reasoning: string;
  actionType: string;
  actionUrl: string;
}

interface AIRecommendationsData {
  recommendations: AIRecommendation[];
  footer: string;
}

// ============================================================
// Skeleton loader
// ============================================================

function DashboardSkeleton({ orgName }: { orgName: string }) {
  return (
    <div>
      <h2 className="mb-6 text-2xl font-bold">{orgName}</h2>
      {/* Needs attention skeleton */}
      <div className="mb-6 space-y-1.5">
        {[1, 2].map((i) => (
          <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
      {/* Metrics skeleton */}
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
      {/* Charts skeleton */}
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-48 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Formatting helpers
// ============================================================

const REJECTION_LABELS: Record<string, string> = {
  schedule_conflict: "Schedule conflicts",
  feeling_unwell: "Feeling unwell",
  exceeds_preferred_hours: "Exceeds preferred hours",
  transport_issues: "Transport issues",
  insufficient_notice: "Insufficient notice",
  rest_period_needed: "Rest period needed",
  personal_reasons: "Personal reasons",
  other: "Other",
  unspecified: "Unspecified",
};

function trendArrow(trend: "up" | "down" | "flat"): string {
  if (trend === "up") return "↑";
  if (trend === "down") return "↓";
  return "→";
}

function trendColor(trend: "up" | "down" | "flat"): string {
  if (trend === "up") return "text-green-600 dark:text-green-400";
  if (trend === "down") return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

// ============================================================
// Main component
// ============================================================

interface AdminDashboardProps {
  orgId: string;
  orgName: string;
}

export default function AdminDashboard({ orgId, orgName }: AdminDashboardProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aiRecs, setAiRecs] = useState<AIRecommendationsData | null>(null);
  const [aiLoading, setAiLoading] = useState(true);

  useEffect(() => {
    fetchDashboard();
    fetchAIRecommendations();
  }, [orgId]);

  async function fetchDashboard() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/organizations/${orgId}/dashboard`);
      if (!res.ok) {
        setError("Failed to load dashboard");
        return;
      }
      const result = await res.json();
      setData(result);
    } catch {
      setError("Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  async function fetchAIRecommendations() {
    try {
      setAiLoading(true);
      const res = await fetch(
        `/api/organizations/${orgId}/dashboard/ai-recommendations`
      );
      if (res.ok) {
        setAiRecs(await res.json());
      }
    } catch {
      // AI recommendations are non-critical — fail silently
    } finally {
      setAiLoading(false);
    }
  }

  if (loading) return <DashboardSkeleton orgName={orgName} />;

  if (error) {
    return (
      <div>
        <h2 className="mb-6 text-2xl font-bold">{orgName}</h2>
        <AlertBanner
          message={
            <>
              {error}
              <button onClick={fetchDashboard} className="ml-2 underline">
                Retry
              </button>
            </>
          }
          variant="error"
        />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold">{orgName}</h2>
        <a href={`/api/organizations/${orgId}/reports/export`}>
          <Button variant="outline" size="sm">
            Export PDF
          </Button>
        </a>
      </div>

      {/* ---- Section 1: Needs Attention ---- */}
      {data.needsAttention && data.needsAttention.length > 0 && (
        <NeedsAttention items={data.needsAttention} />
      )}

      {/* ---- Section 2: Key Metrics ---- */}
      {data.keyMetrics && <MetricsCards metrics={data.keyMetrics} />}

      {/* ---- Section 2b: Summaries (tasks, coverage, certifications) ---- */}
      {(data.taskSummary || data.coverageSummary || data.certificationSummary) && (
        <div className="mb-6 grid gap-4 md:grid-cols-3">
          {data.taskSummary && <TaskSummaryCard summary={data.taskSummary} />}
          {data.coverageSummary && (
            <CoverageSummaryCard summary={data.coverageSummary} />
          )}
          {data.certificationSummary && (
            <CertificationSummaryCard
              summary={data.certificationSummary}
              orgId={orgId}
            />
          )}
        </div>
      )}

      {/* ---- Section 3: Tomorrow + Completions ---- */}
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tomorrow&apos;s schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <TomorrowsList
              tasks={data.tomorrowsSchedule}
              orgId={orgId}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Completions this week</CardTitle>
          </CardHeader>
          <CardContent>
            <CompletionChart days={data.completionChart} />
          </CardContent>
        </Card>
      </div>

      {/* ---- Section 4: Utilization + Workload/Rejections ---- */}
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Staff utilization (7d)</CardTitle>
          </CardHeader>
          <CardContent>
            <UtilizationBars staff={data.staffUtilization} />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Department workload</CardTitle>
            </CardHeader>
            <CardContent>
              <WorkloadBars departments={data.departmentWorkload} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Rejection trends</CardTitle>
            </CardHeader>
            <CardContent>
              <RejectionTrends trends={data.rejectionTrends} orgId={orgId} />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ---- Section 5: AI Recommendations ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300">
              ✦ AI Insights
            </span>
            Recommendations
          </CardTitle>
        </CardHeader>
        <CardContent>
          {aiLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 rounded bg-muted animate-pulse" />
              ))}
            </div>
          ) : !aiRecs || aiRecs.recommendations.length === 0 ? (
            <EmptyState title="No recommendations at this time" className="py-4" />
          ) : (
            <div>
              <div className="space-y-3">
                {aiRecs.recommendations.map((rec) => (
                  <div
                    key={rec.priority}
                    className="flex items-start justify-between gap-3 text-sm"
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                        {rec.priority}
                      </span>
                      <div>
                        <p className="font-medium">{rec.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {rec.reasoning}
                        </p>
                      </div>
                    </div>
                    <Link href={rec.actionUrl}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                      >
                        {rec.actionType === "quick_assign"
                          ? "Assign"
                          : rec.actionType === "edit_availability"
                          ? "Edit"
                          : rec.actionType === "review_certs"
                          ? "Review"
                          : "View"}
                      </Button>
                    </Link>
                  </div>
                ))}
              </div>
              {aiRecs.footer && (
                <p className="mt-4 text-xs text-muted-foreground text-center">
                  {aiRecs.footer}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

/** Three key metric cards */
function MetricsCards({ metrics }: { metrics: KeyMetrics }) {
  const { assignmentPipeline: pipeline, completionRate, hoursLogged } = metrics;

  return (
    <div className="mb-6 grid gap-4 md:grid-cols-3">
      {/* Assignment pipeline */}
      <div className="rounded-lg bg-secondary p-4">
        <p className="text-xs text-muted-foreground mb-1">Assignment pipeline</p>
        <p className="text-2xl font-semibold">{pipeline.total}</p>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
            {pipeline.accepted} accepted
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
            {pipeline.pending} pending
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
            {pipeline.rejected} rejected
          </span>
        </div>
      </div>

      {/* Completion rate */}
      <div className="rounded-lg bg-secondary p-4">
        <p className="text-xs text-muted-foreground mb-1">Completed (7d)</p>
        <div className="flex items-baseline gap-2">
          <p className="text-2xl font-semibold">{completionRate.current}</p>
          <span className={`text-sm font-medium ${trendColor(completionRate.trend)}`}>
            {trendArrow(completionRate.trend)} vs {completionRate.previous} last week
          </span>
        </div>
      </div>

      {/* Hours logged */}
      <div className="rounded-lg bg-secondary p-4">
        <p className="text-xs text-muted-foreground mb-1">Hours logged (7d)</p>
        <div className="flex items-baseline gap-2">
          <p className="text-2xl font-semibold">{hoursLogged.hours}h</p>
          <span className="text-xs text-muted-foreground">
            of {hoursLogged.capacity}h · {hoursLogged.utilization}%
          </span>
        </div>
      </div>
    </div>
  );
}

/** One label/value row inside a summary card. */
function SummaryRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger" | "warning" | "good" | "muted";
}) {
  const toneClass =
    tone === "danger"
      ? "text-red-600 dark:text-red-400"
      : tone === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "good"
          ? "text-green-600 dark:text-green-400"
          : tone === "muted"
            ? "text-muted-foreground"
            : "";

  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}

/** Task summary — counts by task status (PRD 3.15) */
function TaskSummaryCard({ summary }: { summary: TaskSummary }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Task summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xl font-semibold">{summary.total}</p>
        <p className="mb-3 text-xs text-muted-foreground">tasks in total</p>
        <SummaryRow label="Open" value={summary.open} />
        <SummaryRow label="In progress" value={summary.in_progress} />
        <SummaryRow label="Completed" value={summary.completed} tone="good" />
        <SummaryRow label="Cancelled" value={summary.cancelled} tone="muted" />
      </CardContent>
    </Card>
  );
}

/** Task coverage across the next 7 days (PRD 3.15) */
function CoverageSummaryCard({ summary }: { summary: CoverageSummary }) {
  const pct = summary.coveragePercent;
  const barColor =
    pct >= 90 ? "bg-green-500" : pct >= 70 ? "bg-amber-500" : "bg-red-500";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Task coverage (next 7d)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xl font-semibold">{pct}%</p>
        <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <SummaryRow label="Fully staffed" value={summary.fullyStaffed} tone="good" />
        <SummaryRow label="Understaffed" value={summary.understaffed} tone="warning" />
        <SummaryRow label="Unassigned" value={summary.unassigned} tone="danger" />
        <SummaryRow
          label="Upcoming tasks"
          value={summary.upcomingTasks}
          tone="muted"
        />
      </CardContent>
    </Card>
  );
}

/** Certification summary — verification backlog and expiry health (PRD 3.15) */
function CertificationSummaryCard({
  summary,
  orgId,
}: {
  summary: CertificationSummary;
  orgId: string;
}) {
  const needsAction = summary.pending + summary.expiringSoon + summary.expired;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Certifications</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xl font-semibold">{summary.verified}</p>
        <p className="mb-3 text-xs text-muted-foreground">
          verified of {summary.total}
        </p>
        <SummaryRow
          label="Awaiting verification"
          value={summary.pending}
          tone={summary.pending > 0 ? "warning" : undefined}
        />
        <SummaryRow
          label="Expiring in 30d"
          value={summary.expiringSoon}
          tone={summary.expiringSoon > 0 ? "warning" : undefined}
        />
        <SummaryRow
          label="Expired"
          value={summary.expired}
          tone={summary.expired > 0 ? "danger" : undefined}
        />
        <SummaryRow label="Rejected" value={summary.rejected} tone="muted" />

        {needsAction > 0 && (
          <Link
            href={`/org/${orgId}/certifications`}
            className="mt-2 inline-block text-xs text-primary hover:underline"
          >
            Review certifications →
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/** Tomorrow's schedule task list */
function TomorrowsList({
  tasks,
  orgId,
}: {
  tasks: TomorrowTask[] | null;
  orgId: string;
}) {
  if (!tasks) {
    return <EmptyState title="Could not load schedule" />;
  }

  if (tasks.length === 0) {
    return <EmptyState title="No tasks scheduled for tomorrow" />;
  }

  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center justify-between text-sm"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: task.departmentColor || "#94A3B8" }}
            />
            <span className="truncate">{task.title}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            {task.timeRange && (
              <span className="text-xs text-muted-foreground">
                {task.timeRange}
              </span>
            )}
            {task.isUnderstaffed ? (
              <Link href={`/org/${orgId}/tasks`}>
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 cursor-pointer hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-300 dark:hover:bg-amber-800">
                  understaffed
                </span>
              </Link>
            ) : (
              <span className="text-xs text-muted-foreground">
                {task.assignedCount}/{task.requiredHeadcount}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Completion bar chart (Mon–Sun) */
function CompletionChart({ days }: { days: CompletionDay[] | null }) {
  if (!days) {
    return <EmptyState title="Could not load completions" />;
  }

  if (days.every((d) => d.count === 0)) {
    return <EmptyState title="No completed tasks in the last 7 days" />;
  }

  const maxCount = Math.max(...days.map((d) => d.count), 1);
  const total = days.reduce((sum, d) => sum + d.count, 0);

  return (
    <div>
      <div className="flex items-end gap-2" style={{ height: "120px" }}>
        {days.map((day) => (
          <div
            key={day.date}
            className="flex flex-1 flex-col items-center gap-1"
          >
            <span className="text-xs text-muted-foreground">
              {day.count > 0 ? day.count : ""}
            </span>
            <div
              className="w-full rounded-t bg-green-400"
              style={{
                height: `${(day.count / maxCount) * 90}px`,
                minHeight: day.count > 0 ? "4px" : "0px",
              }}
            />
            <span className="text-xs text-muted-foreground">{day.label}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground text-center">
        {total} completed this week
      </p>
    </div>
  );
}

/** Staff utilization horizontal bars */
function UtilizationBars({
  staff,
}: {
  staff: StaffUtilizationItem[] | null;
}) {
  if (!staff) {
    return <EmptyState title="Could not load utilization" />;
  }

  if (staff.length === 0) {
    return <EmptyState title="No staff members found" />;
  }

  return (
    <div className="space-y-3">
      {staff.slice(0, 8).map((s) => (
        <div key={s.membershipId}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-muted-foreground truncate mr-2">
              {s.name}
            </span>
            <span
              className={`font-medium ${
                s.percentage < 50
                  ? "text-amber-600"
                  : "text-foreground"
              }`}
            >
              {s.percentage}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full ${
                s.percentage < 50 ? "bg-amber-400" : "bg-blue-400"
              }`}
              style={{ width: `${Math.min(s.percentage, 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Department workload bars with task:staff ratios */
function WorkloadBars({
  departments,
}: {
  departments: DepartmentWorkloadItem[] | null;
}) {
  if (!departments) {
    return <EmptyState title="Could not load workload" className="py-4" />;
  }

  if (departments.length === 0) {
    return <EmptyState title="No departments found" className="py-4" />;
  }

  return (
    <div className="space-y-2.5">
      {departments.map((dept) => (
        <div key={dept.id}>
          <div className="flex justify-between text-xs mb-1">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: dept.color }}
              />
              {dept.name}
            </span>
            <span
              className={`font-medium ${
                dept.isImbalanced ? "text-amber-600" : "text-foreground"
              }`}
            >
              {dept.taskCount} tasks · {dept.staffCount} staff
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Rejection trends narrative */
function RejectionTrends({
  trends,
  orgId,
}: {
  trends: RejectionTrendItem[] | null;
  orgId: string;
}) {
  if (!trends) {
    return <EmptyState title="Could not load rejection data" className="py-4" />;
  }

  if (trends.length === 0) {
    return <EmptyState title="No rejections in the last 7 days" className="py-4" />;
  }

  return (
    <div className="space-y-3">
      {trends.map((item) => {
        const topReason = item.reasons[0];
        const reasonLabel =
          REJECTION_LABELS[topReason?.reason] || topReason?.reason || "Unknown";

        return (
          <div key={item.membershipId} className="text-sm">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="font-medium">{item.staffName}</span>
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900 dark:text-red-300">
                {item.rejectionCount}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Mostly {reasonLabel.toLowerCase()}
              {topReason?.reason === "schedule_conflict" && (
                <>
                  {" — "}
                  <Link
                    href={`/org/${orgId}/members`}
                    className="underline hover:text-foreground"
                  >
                    View members
                  </Link>
                </>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}
