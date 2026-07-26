/**
 * Admin Dashboard Component (Boundary Layer)
 *
 * Client component for the Company Admin dashboard view.
 * Fetches data from GET /api/organizations/[orgId]/dashboard
 * and GET /api/organizations/[orgId]/dashboard/ai-recommendations.
 *
 * Layout (matches approved mockup):
 * 1. Greeting with contextual status pill
 * 2. Action items — urgent alerts + inline AI suggestions with divider
 * 3. Key metric stat tiles with micro-visualizations
 * 4. Three-column chart row (completions, tomorrow's schedule, dept workload)
 * 5. Staff utilization bars
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
// Helpers
// ============================================================

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getStatusPill(items: NeedsAttentionItem[] | null): {
  severity: "good" | "warn" | "bad";
  message: string;
} {
  if (!items || items.length === 0) {
    return { severity: "good", message: "All clear — no items need attention" };
  }
  const dangerCount = items.filter((i) => i.severity === "danger").length;
  if (dangerCount > 0 || items.length >= 3) {
    return {
      severity: "bad",
      message: `${items.length} item${items.length !== 1 ? "s" : ""} need${items.length === 1 ? "s" : ""} action`,
    };
  }
  return {
    severity: "warn",
    message: `${items.length} item${items.length !== 1 ? "s" : ""} need${items.length === 1 ? "s" : ""} action before tomorrow`,
  };
}

const severityIcon: Record<string, string> = {
  danger: "⚠",
  warning: "⏳",
  info: "📋",
};

const AI_ACTION_LABELS: Record<string, string> = {
  quick_assign: "Quick assign",
  edit_availability: "Review",
  review_certs: "Review",
};

// ============================================================
// Skeleton loader
// ============================================================

function DashboardSkeleton({ orgName }: { orgName: string }) {
  return (
    <div>
      <div className="mb-7">
        <div className="h-8 w-64 rounded bg-muted animate-pulse" />
        <div className="mt-2 h-4 w-96 rounded bg-muted animate-pulse" />
        <div className="mt-3 h-8 w-72 rounded-full bg-muted animate-pulse" />
      </div>
      <div className="mb-8 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-xl bg-muted animate-pulse" />
        ))}
      </div>
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-32 rounded-xl bg-muted animate-pulse" />
        ))}
      </div>
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-64 rounded-xl bg-muted animate-pulse" />
        ))}
      </div>
    </div>
  );
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

  const status = getStatusPill(data.needsAttention);
  const hasActionItems =
    (data.needsAttention && data.needsAttention.length > 0) ||
    (aiRecs && aiRecs.recommendations.length > 0);

  return (
    <div>
      {/* ════════════════════════════════════════════════════ */}
      {/* 1. Greeting + Status Pill                           */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="mb-7">
        <h2 className="text-2xl font-bold text-foreground">
          {getGreeting()}, Admin
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Here&apos;s what needs your attention at {orgName} today.
        </p>
        <div
          className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-medium ${
            status.severity === "good"
              ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
              : status.severity === "warn"
                ? "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400"
                : "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400"
          }`}
        >
          <span className="relative inline-block h-2 w-2 rounded-full bg-current dashboard-status-pulse" />
          {status.message}
        </div>
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* 2. Action Items + Inline AI Suggestions             */}
      {/* ════════════════════════════════════════════════════ */}
      {hasActionItems && (
        <div className="mb-8">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
            Needs your action
          </p>

          {/* Urgent / warning / info items */}
          {data.needsAttention?.map((item, i) => (
            <div
              key={`${item.type}-${item.entityId ?? i}`}
              className="mb-2 flex items-center gap-3.5 rounded-xl border border-border bg-card p-3.5 transition-shadow hover:shadow-sm"
            >
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-base"
                style={{
                  backgroundColor:
                    item.severity === "danger"
                      ? "#fef2f2"
                      : item.severity === "warning"
                        ? "#fffbeb"
                        : "#eef2ff",
                  color:
                    item.severity === "danger"
                      ? "#dc2626"
                      : item.severity === "warning"
                        ? "#d97706"
                        : "#4f46e5",
                }}
              >
                {severityIcon[item.severity] || "📋"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  {item.message}
                </p>
              </div>
              <Link href={item.actionUrl}>
                <button
                  className={`shrink-0 rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition-all ${
                    item.severity === "danger"
                      ? "border-indigo-500 bg-indigo-600 text-white hover:opacity-90"
                      : "border-border bg-card text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {item.actionLabel}
                </button>
              </Link>
            </div>
          ))}

          {/* AI suggestions divider + cards */}
          {aiRecs && aiRecs.recommendations.length > 0 && (
            <>
              <div className="my-3 flex items-center gap-2.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  ✦ AI suggestions
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>

              {aiRecs.recommendations.map((rec) => (
                <div
                  key={rec.priority}
                  className="mb-2 flex items-center gap-3.5 rounded-xl border p-3.5 transition-shadow hover:shadow-sm"
                  style={{
                    borderColor: "#e0e7ff",
                    background:
                      "linear-gradient(135deg, rgba(79,70,229,0.02), rgba(124,58,237,0.02))",
                  }}
                >
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-sm text-white"
                    style={{
                      background:
                        "linear-gradient(135deg, #4f46e5, #7c3aed)",
                    }}
                  >
                    ✦
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {rec.title}
                      <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-[5px] bg-indigo-50 px-[7px] py-0.5 text-[10px] font-bold text-indigo-600 align-middle dark:bg-indigo-950 dark:text-indigo-400">
                        AI
                      </span>
                    </p>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      {rec.reasoning}
                    </p>
                  </div>
                  <Link href={rec.actionUrl}>
                    <button
                      className="shrink-0 rounded-lg border border-indigo-500 bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-all hover:opacity-90"
                    >
                      {AI_ACTION_LABELS[rec.actionType] || "View"}
                    </button>
                  </Link>
                </div>
              ))}
            </>
          )}

          {aiLoading && !aiRecs && (
            <div className="mt-3 space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-14 rounded-xl bg-muted/50 animate-pulse" />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* 3. Key Metric Stat Tiles                            */}
      {/* ════════════════════════════════════════════════════ */}
      {data.keyMetrics && (
        <MetricsTiles metrics={data.keyMetrics} completionChart={data.completionChart} />
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* 4. Three-Column Chart Row                           */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {/* Completions this week */}
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-bold">
              Completions this week
            </CardTitle>
            {data.completionChart && (
              <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
                {data.completionChart.reduce((s, d) => s + d.count, 0)} total
              </span>
            )}
          </CardHeader>
          <CardContent>
            <CompletionChart days={data.completionChart} />
          </CardContent>
        </Card>

        {/* Tomorrow's schedule */}
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-bold">
              Tomorrow&apos;s schedule
            </CardTitle>
            {data.tomorrowsSchedule && (
              <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400">
                {data.tomorrowsSchedule.length} task{data.tomorrowsSchedule.length !== 1 ? "s" : ""}
              </span>
            )}
          </CardHeader>
          <CardContent>
            <TomorrowsList tasks={data.tomorrowsSchedule} orgId={orgId} />
          </CardContent>
        </Card>

        {/* Department workload */}
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-bold">
              Department workload
            </CardTitle>
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
              this week
            </span>
          </CardHeader>
          <CardContent>
            <WorkloadBars departments={data.departmentWorkload} />
          </CardContent>
        </Card>
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* 5. Staff Utilization                                */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="mb-8 grid gap-4 md:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-bold">
              Staff utilization
            </CardTitle>
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
              7-day avg
            </span>
          </CardHeader>
          <CardContent>
            <UtilizationBars staff={data.staffUtilization} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

/** Three key metric tiles with micro-visualizations */
function MetricsTiles({
  metrics,
  completionChart,
}: {
  metrics: KeyMetrics;
  completionChart: CompletionDay[] | null;
}) {
  const { assignmentPipeline: pipeline, completionRate, hoursLogged } = metrics;

  // Build sparkline data from completion chart (last 7 days)
  const sparkData = completionChart
    ? completionChart.map((d) => d.count)
    : [0, 0, 0, 0, 0, 0, 0];
  const sparkMax = Math.max(...sparkData, 1);

  // Pipeline proportions
  const pipeTotal = Math.max(pipeline.total, 1);
  const acceptedPct = (pipeline.accepted / pipeTotal) * 100;
  const pendingPct = (pipeline.pending / pipeTotal) * 100;
  const rejectedPct = (pipeline.rejected / pipeTotal) * 100;

  // Capacity utilization
  const capacityPct =
    hoursLogged.capacity > 0
      ? Math.round((hoursLogged.hours / hoursLogged.capacity) * 100)
      : 0;

  return (
    <div className="mb-8 grid gap-4 md:grid-cols-3">
      {/* Completion rate with sparkline */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          Completion rate
        </p>
        <p className="mt-1 text-[32px] font-bold leading-none text-foreground">
          {completionRate.current}%
        </p>
        <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <span
            className={`font-semibold ${
              completionRate.trend === "up"
                ? "text-emerald-600 dark:text-emerald-400"
                : completionRate.trend === "down"
                  ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground"
            }`}
          >
            {completionRate.trend === "up"
              ? "↑"
              : completionRate.trend === "down"
                ? "↓"
                : "→"}{" "}
            {Math.abs(completionRate.current - completionRate.previous)}%
          </span>
          vs last week
        </p>
        {/* Sparkline */}
        <div className="mt-2 flex items-end gap-0.5" style={{ height: 20 }}>
          {sparkData.map((val, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm"
              style={{
                height: `${Math.max((val / sparkMax) * 100, 8)}%`,
                backgroundColor: "#4f46e5",
                opacity: i === sparkData.length - 1 ? 0.6 : 0.2,
                minWidth: 3,
              }}
            />
          ))}
        </div>
      </div>

      {/* Hours this week with progress bar */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          Hours this week
        </p>
        <p className="mt-1 text-[32px] font-bold leading-none text-foreground">
          {hoursLogged.hours}h
        </p>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          of {hoursLogged.capacity}h capacity
        </p>
        <div
          className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(capacityPct, 100)}%`,
              background: "linear-gradient(90deg, #4f46e5, #7c3aed)",
            }}
          />
        </div>
        <p className="mt-1 text-right text-[11px] text-muted-foreground">
          {capacityPct}% utilization
        </p>
      </div>

      {/* Assignment pipeline with stacked bar */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          Assignment pipeline
        </p>
        <p className="mt-1 text-[32px] font-bold leading-none text-foreground">
          {pipeline.total}
        </p>
        {/* Stacked bar */}
        <div className="mt-2.5 flex h-2.5 overflow-hidden rounded-full">
          {acceptedPct > 0 && (
            <div
              style={{
                width: `${acceptedPct}%`,
                backgroundColor: "#1baf7a",
                marginRight: 2,
              }}
              className="rounded-l-full"
            />
          )}
          {pendingPct > 0 && (
            <div
              style={{
                width: `${pendingPct}%`,
                backgroundColor: "#eb6834",
                marginRight: 2,
              }}
            />
          )}
          {rejectedPct > 0 && (
            <div
              style={{
                width: `${rejectedPct}%`,
                backgroundColor: "#e34948",
              }}
              className="rounded-r-full"
            />
          )}
        </div>
        {/* Legend */}
        <div className="mt-2 flex gap-3.5 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#1baf7a" }}
            />
            <span className="font-bold text-foreground">{pipeline.accepted}</span>{" "}
            accepted
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#eb6834" }}
            />
            <span className="font-bold text-foreground">{pipeline.pending}</span>{" "}
            pending
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#e34948" }}
            />
            <span className="font-bold text-foreground">{pipeline.rejected}</span>{" "}
            rejected
          </span>
        </div>
      </div>
    </div>
  );
}

/** Completions bar chart (7 days) */
function CompletionChart({ days }: { days: CompletionDay[] | null }) {
  if (!days) {
    return <EmptyState title="Could not load completions" />;
  }

  if (days.every((d) => d.count === 0)) {
    return <EmptyState title="No completed tasks in the last 7 days" />;
  }

  const maxCount = Math.max(...days.map((d) => d.count), 1);
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  return (
    <div>
      <div className="flex items-end gap-2" style={{ height: 110 }}>
        {days.map((day) => {
          const isToday = day.date === todayStr;
          const isFuture = day.date > todayStr;
          const heightPct = day.count > 0 ? (day.count / maxCount) * 90 : 10;

          return (
            <div
              key={day.date}
              className="flex flex-1 flex-col items-center gap-1"
            >
              <span className="text-[10px] font-semibold text-muted-foreground">
                {day.count > 0 ? day.count : isFuture ? "–" : "0"}
              </span>
              <div
                className="w-full rounded-t"
                style={{
                  maxWidth: 24,
                  height: `${heightPct}%`,
                  minHeight: day.count > 0 ? 4 : 2,
                  backgroundColor: isToday
                    ? "#4f46e5"
                    : isFuture
                      ? "rgba(42,120,214,0.3)"
                      : "#2a78d6",
                  borderRadius: "4px 4px 0 0",
                }}
              />
              <span
                className={`text-[10px] ${
                  isToday
                    ? "font-semibold text-indigo-600 dark:text-indigo-400"
                    : "text-muted-foreground"
                }`}
              >
                {day.label}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-0.5 h-px bg-border" />
    </div>
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
    <div className="space-y-0">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center gap-3 border-b border-muted py-2.5 last:border-b-0"
        >
          <div
            className="h-7 w-1 shrink-0 rounded-sm"
            style={{
              backgroundColor: task.departmentColor || "#94A3B8",
            }}
          />
          <span className="flex-1 truncate text-[13px] font-medium text-foreground">
            {task.title}
          </span>
          {task.timeRange && (
            <span className="text-xs font-medium text-muted-foreground">
              {task.timeRange}
            </span>
          )}
          {task.isUnderstaffed ? (
            <Link href={`/org/${orgId}/tasks`}>
              <span className="rounded-md bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-600 dark:bg-red-950 dark:text-red-400">
                needs {task.requiredHeadcount - task.assignedCount}
              </span>
            </Link>
          ) : (
            <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
              staffed
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Department workload horizontal bars */
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

  const maxTasks = Math.max(...departments.map((d) => d.taskCount), 1);

  return (
    <div className="space-y-0">
      {departments.map((dept) => (
        <div
          key={dept.id}
          className="flex items-center gap-3 border-b border-muted py-2.5 last:border-b-0"
        >
          <div className="flex w-[100px] items-center gap-2 shrink-0">
            <div
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: dept.color }}
            />
            <span className="truncate text-[13px] font-medium text-foreground">
              {dept.name}
            </span>
          </div>
          <div className="flex-1 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(dept.taskCount / maxTasks) * 100}%`,
                backgroundColor: dept.color,
              }}
            />
          </div>
          <span
            className={`text-xs whitespace-nowrap text-right min-w-[90px] ${
              dept.isImbalanced
                ? "font-semibold text-amber-600 dark:text-amber-400"
                : "text-muted-foreground"
            }`}
          >
            {dept.taskCount} tasks · {dept.staffCount} staff
          </span>
        </div>
      ))}
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
    <div className="space-y-1">
      {staff.slice(0, 8).map((s) => (
        <div key={s.membershipId} className="flex items-center gap-2.5 py-1">
          <span className="w-[100px] truncate text-[13px] font-medium text-foreground">
            {s.name}
          </span>
          <div className="flex-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(s.percentage, 100)}%`,
                backgroundColor:
                  s.percentage < 50 ? "#eb6834" : "#2a78d6",
              }}
            />
          </div>
          <span
            className={`w-9 text-right text-xs font-bold ${
              s.percentage < 50
                ? "text-amber-600 dark:text-amber-400"
                : "text-foreground"
            }`}
          >
            {s.percentage}%
          </span>
        </div>
      ))}
    </div>
  );
}
