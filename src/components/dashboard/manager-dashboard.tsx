/**
 * Manager Dashboard Component (Boundary Layer)
 *
 * Client component for the Manager dashboard view.
 * Visual overhaul with greeting, status pill, action cards,
 * stat tiles, tomorrow's schedule, and team roster.
 *
 * All data is automatically filtered by the manager's
 * department(s) on the server side.
 */
"use client";

// ============================================================
// Imports
// ============================================================

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { NeedsAttentionItem } from "@/components/dashboard/needs-attention";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";

// ============================================================
// API response types
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

interface TeamMemberItem {
  membershipId: string;
  name: string;
  status: "on_shift" | "has_pending" | "available" | "off_today";
  statusLabel: string;
  pendingCount: number;
}

interface ManagerDashboardData {
  role: string;
  needsAttention: NeedsAttentionItem[] | null;
  keyMetrics: KeyMetrics | null;
  tomorrowsSchedule: TomorrowTask[] | null;
  staffUtilization:
    | { membershipId: string; name: string; percentage: number }[]
    | null;
  teamRoster: TeamMemberItem[] | null;
}

// ============================================================
// Props
// ============================================================

interface ManagerDashboardProps {
  orgId: string;
  orgName: string;
  userName?: string;
}

// ============================================================
// Helpers
// ============================================================

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function getActionIcon(severity: "danger" | "warning" | "info"): string {
  if (severity === "danger") return "!";
  if (severity === "warning") return "?";
  return "i";
}

function getStatusPillInfo(items: NeedsAttentionItem[] | null): {
  label: string;
  bg: string;
  text: string;
  dot: string;
} {
  const count = items?.length ?? 0;
  if (count === 0) {
    return {
      label: "All clear -- nothing needs attention",
      bg: "bg-emerald-50",
      text: "text-emerald-700",
      dot: "bg-emerald-500",
    };
  }
  if (count <= 2) {
    return {
      label: `${count} item${count > 1 ? "s" : ""} need${count === 1 ? "s" : ""} your attention`,
      bg: "bg-amber-50",
      text: "text-amber-700",
      dot: "bg-amber-500",
    };
  }
  return {
    label: `${count} items need your attention`,
    bg: "bg-red-50",
    text: "text-red-700",
    dot: "bg-red-500",
  };
}

// ============================================================
// Component
// ============================================================

export default function ManagerDashboard({
  orgId,
  orgName,
  userName,
}: ManagerDashboardProps) {
  const [data, setData] = useState<ManagerDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDashboard();
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
      setData(await res.json());
    } catch {
      setError("Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  // ----------------------------------------------------------
  // Loading state
  // ----------------------------------------------------------
  if (loading) {
    return (
      <div className="space-y-6">
        {/* Greeting skeleton */}
        <div className="space-y-3">
          <div className="h-8 w-64 rounded-lg bg-muted animate-pulse" />
          <div className="h-5 w-80 rounded-md bg-muted animate-pulse" />
          <div className="h-8 w-56 rounded-full bg-muted animate-pulse" />
        </div>

        {/* Stat tiles skeleton */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 rounded-xl border bg-muted animate-pulse"
            />
          ))}
        </div>

        {/* Two-column skeleton */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="h-72 rounded-xl border bg-muted animate-pulse" />
          <div className="h-72 rounded-xl border bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------
  // Error state
  // ----------------------------------------------------------
  if (error) {
    return (
      <AlertBanner
        message={error}
        variant="error"
        onDismiss={() => setError(null)}
      />
    );
  }

  // ----------------------------------------------------------
  // Empty data state
  // ----------------------------------------------------------
  if (!data) {
    return <EmptyState title="No dashboard data available" />;
  }

  // ----------------------------------------------------------
  // Derived values
  // ----------------------------------------------------------
  const metrics = data.keyMetrics;
  const pipeline = metrics?.assignmentPipeline;
  const hoursLogged = metrics?.hoursLogged;

  const teamRoster = data.teamRoster ?? [];
  const availableCount = teamRoster.filter(
    (m) => m.status !== "off_today"
  ).length;
  const totalStaff = teamRoster.length;

  const openTasks = pipeline
    ? pipeline.pending + pipeline.accepted
    : 0;
  const totalTasks = pipeline?.total ?? 0;

  const totalHours = hoursLogged?.hours ?? 0;
  const avgHoursPerPerson =
    totalStaff > 0 ? Math.round(totalHours / totalStaff) : 0;

  const statusPill = getStatusPillInfo(data.needsAttention);

  const tomorrowTasks = data.tomorrowsSchedule ?? [];
  const attentionItems = data.needsAttention ?? [];

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------
  return (
    <div className="space-y-8">
      {/* ---- Greeting with status pill ---- */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight">
          {getGreeting()}{userName ? `, ${userName}` : ""}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your team for today &mdash; {availableCount} of {totalStaff} staff
          available.
        </p>

        <div
          className={`mt-3 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium ${statusPill.bg} ${statusPill.text}`}
        >
          <span
            className={`relative dashboard-status-pulse inline-block h-2 w-2 rounded-full ${statusPill.dot}`}
          />
          {statusPill.label}
        </div>
      </div>

      {/* ---- Action items ---- */}
      {attentionItems.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Action items
          </h3>
          <div className="space-y-2">
            {attentionItems.map((item, idx) => {
              const isDanger = item.severity === "danger";
              const isWarning = item.severity === "warning";

              const iconBg = isDanger
                ? "bg-red-50"
                : isWarning
                  ? "bg-amber-50"
                  : "bg-indigo-50";
              const iconText = isDanger
                ? "text-red-600"
                : isWarning
                  ? "text-amber-600"
                  : "text-indigo-600";
              const btnBg = isDanger
                ? "bg-red-50 text-red-700 hover:bg-red-100"
                : isWarning
                  ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                  : "bg-indigo-50 text-indigo-700 hover:bg-indigo-100";

              return (
                <Card
                  key={item.entityId ?? `attention-${idx}`}
                  className="border shadow-none"
                >
                  <CardContent className="flex items-center gap-4 py-3 px-4">
                    {/* Icon */}
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-sm font-bold ${iconBg} ${iconText}`}
                    >
                      {item.isAiInsight ? "AI" : getActionIcon(item.severity)}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug truncate">
                        {item.message}
                      </p>
                    </div>

                    {/* Action button */}
                    <a
                      href={item.actionUrl}
                      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${btnBg}`}
                    >
                      {item.actionLabel}
                    </a>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* ---- Stat tiles (3 columns) ---- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Open tasks */}
        <Card className="rounded-xl border shadow-none">
          <CardContent className="p-[20px_22px]">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Open tasks
            </p>
            <p className="mt-2 text-2xl font-bold tabular-nums">
              {openTasks}
              <span className="text-base font-normal text-muted-foreground">
                {" "}
                / {totalTasks}
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {pipeline?.pending ?? 0} pending, {pipeline?.accepted ?? 0}{" "}
              accepted
            </p>
          </CardContent>
        </Card>

        {/* Staff available */}
        <Card className="rounded-xl border shadow-none">
          <CardContent className="p-[20px_22px]">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Staff available
            </p>
            <p className="mt-2 text-2xl font-bold tabular-nums">
              {availableCount}
              <span className="text-base font-normal text-muted-foreground">
                {" "}
                / {totalStaff}
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {teamRoster.filter((m) => m.status === "on_shift").length} on
              shift right now
            </p>
          </CardContent>
        </Card>

        {/* Team hours */}
        <Card className="rounded-xl border shadow-none">
          <CardContent className="p-[20px_22px]">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Team hours (7d)
            </p>
            <p className="mt-2 text-2xl font-bold tabular-nums">
              {totalHours}
              <span className="text-base font-normal text-muted-foreground">
                h
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              avg {avgHoursPerPerson}h / person
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ---- Two-column grid ---- */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Tomorrow's tasks */}
        <Card className="rounded-xl border shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">
              Tomorrow&apos;s tasks
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {tomorrowTasks.length === 0 ? (
              <EmptyState
                title="No tasks scheduled"
                description="Tomorrow's schedule is clear."
                className="py-6"
              />
            ) : (
              <ul className="divide-y">
                {tomorrowTasks.map((task) => (
                  <li
                    key={task.id}
                    className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    {/* Department color dot */}
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: task.departmentColor ?? "#94a3b8",
                      }}
                      title={task.departmentName ?? ""}
                    />

                    {/* Task info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug truncate">
                        {task.title}
                      </p>
                      {task.timeRange && (
                        <p className="text-xs text-muted-foreground">
                          {task.timeRange}
                        </p>
                      )}
                    </div>

                    {/* Staffing badge */}
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        task.isUnderstaffed
                          ? "bg-red-50 text-red-700"
                          : "bg-emerald-50 text-emerald-700"
                      }`}
                    >
                      {task.assignedCount}/{task.requiredHeadcount}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* My team */}
        <Card className="rounded-xl border shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">My team</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {teamRoster.length === 0 ? (
              <EmptyState
                title="No team members"
                description="Your team roster is empty."
                className="py-6"
              />
            ) : (
              <ul className="divide-y">
                {teamRoster.map((member) => {
                  const initial = member.name.charAt(0).toUpperCase();

                  return (
                    <li
                      key={member.membershipId}
                      className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      {/* Avatar circle */}
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                        style={{ backgroundColor: "#4f46e5" }}
                      >
                        {initial}
                      </span>

                      {/* Name and utilization */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium leading-snug truncate">
                          {member.name}
                        </p>
                        {data.staffUtilization && (
                          <p className="text-xs text-muted-foreground">
                            {data.staffUtilization.find(
                              (u) => u.membershipId === member.membershipId
                            )?.percentage ?? 0}
                            % utilization
                          </p>
                        )}
                      </div>

                      {/* Status badge */}
                      <StatusBadge
                        value={member.status}
                        palette="teamStatus"
                        label={member.statusLabel}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
