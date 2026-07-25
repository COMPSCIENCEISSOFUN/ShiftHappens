/**
 * Staff Dashboard Component (Boundary Layer)
 *
 * Client component for the Staff personal dashboard.
 * Shows: pending assignment alerts, weekly hours/next shift/task count,
 * personal weekly calendar with availability overlay,
 * certifications list, and quick stats (acceptance rate, on-time rate).
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
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";

// ============================================================
// API response types
// ============================================================

interface StaffAssignment {
  id: string;
  status: string;
  taskId: string;
  taskTitle: string;
  departmentName: string | null;
  departmentColor: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  clockInTime: string | null;
  clockOutTime: string | null;
}

interface StaffAvailability {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

interface StaffCert {
  id: string;
  name: string;
  status: string;
  expiryDate: string | null;
  issuedDate: string;
}

interface StaffData {
  hoursThisWeek: number;
  weeklyCapacity: number;
  nextShift: {
    taskName: string;
    scheduledStart: string;
    scheduledEnd: string;
  } | null;
  tasksThisWeek: {
    total: number;
    pending: number;
  };
  weekAssignments: StaffAssignment[];
  availability: StaffAvailability[];
  certifications: StaffCert[];
  stats: {
    shiftsThisMonth: number;
    hoursThisMonth: number;
    acceptanceRate: number;
    onTimeRate: number;
  };
}

interface StaffDashboardResponse {
  role: string;
  staffData: StaffData | null;
}

// ============================================================
// Helpers
// ============================================================

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  const p = d.getHours() >= 12 ? "pm" : "am";
  return m > 0 ? `${h}:${String(m).padStart(2, "0")}${p}` : `${h}${p}`;
}

function formatDayTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${DAY_LABELS[d.getDay()]} ${formatTime(iso)}`;
}

// ============================================================
// Main component
// ============================================================

interface StaffDashboardProps {
  orgId: string;
  orgName: string;
}

export default function StaffDashboard({ orgId, orgName }: StaffDashboardProps) {
  const [data, setData] = useState<StaffData | null>(null);
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
      const result: StaffDashboardResponse = await res.json();
      setData(result.staffData);
    } catch {
      setError("Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div>
        <h2 className="mb-6 text-2xl font-bold">{orgName}</h2>
        <div className="space-y-4">
          <div className="h-16 rounded-lg bg-muted animate-pulse" />
          <div className="grid gap-4 md:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
          <div className="h-64 rounded-lg bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <h2 className="mb-6 text-2xl font-bold">{orgName}</h2>
        <AlertBanner
          message={
            <>
              {error || "Failed to load dashboard"}
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

  const pendingAssignments = data.weekAssignments.filter(
    (a) => a.status === "pending"
  );
  const hoursPercent =
    data.weeklyCapacity > 0
      ? Math.round((data.hoursThisWeek / data.weeklyCapacity) * 100)
      : 0;

  return (
    <div>
      <h2 className="mb-6 text-2xl font-bold">{orgName}</h2>

      {/* ---- Action Required ---- */}
      {pendingAssignments.length > 0 && (
        <AlertBanner
          className="mb-6"
          variant="warning"
          message={
            <>
              <span>
                You have {pendingAssignments.length} new task assignment
                {pendingAssignments.length !== 1 ? "s" : ""} to review
              </span>
              <Link href={`/org/${orgId}/my-tasks`} className="ml-2">
                <Button variant="outline" size="sm" className="border-yellow-500/50 text-yellow-700 hover:bg-yellow-100 dark:border-yellow-500/40 dark:text-yellow-300 dark:hover:bg-yellow-900">
                  View
                </Button>
              </Link>
            </>
          }
        />
      )}

      {/* ---- Key Metrics ---- */}
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        {/* Hours this week */}
        <div className="rounded-lg bg-secondary p-4">
          <p className="text-xs text-muted-foreground mb-1">My hours this week</p>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-semibold">{data.hoursThisWeek}h</p>
            <span className="text-xs text-muted-foreground">
              of {data.weeklyCapacity}h
            </span>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-400"
              style={{ width: `${Math.min(hoursPercent, 100)}%` }}
            />
          </div>
        </div>

        {/* Next shift */}
        <div className="rounded-lg bg-secondary p-4">
          <p className="text-xs text-muted-foreground mb-1">Next shift</p>
          {data.nextShift ? (
            <>
              <p className="text-sm font-medium truncate">
                {data.nextShift.taskName}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatDayTime(data.nextShift.scheduledStart)}–
                {formatTime(data.nextShift.scheduledEnd)}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No upcoming shifts</p>
          )}
        </div>

        {/* Tasks this week */}
        <div className="rounded-lg bg-secondary p-4">
          <p className="text-xs text-muted-foreground mb-1">Tasks this week</p>
          <p className="text-2xl font-semibold">{data.tasksThisWeek.total}</p>
          {data.tasksThisWeek.pending > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {data.tasksThisWeek.pending} pending
            </p>
          )}
        </div>
      </div>

      {/* ---- My Week (calendar-style) ---- */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">My week</CardTitle>
        </CardHeader>
        <CardContent>
          <WeekView
            assignments={data.weekAssignments}
            availability={data.availability}
          />
        </CardContent>
      </Card>

      {/* ---- Certifications + Quick Stats ---- */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Certifications */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">My certifications</CardTitle>
          </CardHeader>
          <CardContent>
            {data.certifications.length === 0 ? (
              <EmptyState title="No certifications submitted" className="py-4" />
            ) : (
              <div className="space-y-2">
                {data.certifications.map((cert) => {
                  const isExpiring =
                    cert.status === "verified" &&
                    cert.expiryDate &&
                    new Date(cert.expiryDate).getTime() - Date.now() <
                      30 * 24 * 60 * 60 * 1000;
                  return (
                    <div
                      key={cert.id}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="truncate mr-2">{cert.name}</span>
                      <StatusBadge
                        value={isExpiring ? "expiring" : cert.status}
                        palette="certification"
                        label={isExpiring ? "Expires soon" : undefined}
                        className="shrink-0"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Stats */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick stats</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Shifts this month</span>
                <span className="font-medium">{data.stats.shiftsThisMonth}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Hours this month</span>
                <span className="font-medium">{data.stats.hoursThisMonth}h</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Acceptance rate</span>
                <span className="font-medium">{data.stats.acceptanceRate}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">On-time clock-in</span>
                <span className="font-medium">{data.stats.onTimeRate}%</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ============================================================
// Week View sub-component
// ============================================================

/** Compact weekly view showing assignments as colored blocks */
function WeekView({
  assignments,
  availability,
}: {
  assignments: StaffAssignment[];
  availability: StaffAvailability[];
}) {
  // Build availability lookup (dayOfWeek → schedule)
  const availMap = new Map<number, StaffAvailability>();
  for (const a of availability) {
    availMap.set(a.dayOfWeek, a);
  }

  // Group assignments by day of week
  const assignmentsByDay = new Map<number, StaffAssignment[]>();
  for (const a of assignments) {
    if (!a.scheduledStart) continue;
    const day = new Date(a.scheduledStart).getDay();
    if (!assignmentsByDay.has(day)) assignmentsByDay.set(day, []);
    assignmentsByDay.get(day)!.push(a);
  }

  // Monday-first order
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];

  return (
    <div className="grid grid-cols-7 gap-1">
      {/* Day headers */}
      {dayOrder.map((d) => (
        <div key={`h-${d}`} className="text-center text-xs font-medium text-muted-foreground pb-1">
          {DAY_LABELS[d]}
        </div>
      ))}

      {/* Day cells */}
      {dayOrder.map((d) => {
        const avail = availMap.get(d);
        const dayAssignments = assignmentsByDay.get(d) || [];
        const isAvailable = avail?.isAvailable ?? false;

        return (
          <div
            key={`d-${d}`}
            className={`min-h-[60px] rounded-md p-1 text-xs ${
              isAvailable ? "bg-blue-50 dark:bg-blue-950/30" : "bg-muted/30"
            }`}
          >
            {isAvailable && !dayAssignments.length && (
              <span className="text-blue-400 text-[10px]">Available</span>
            )}
            {dayAssignments.map((a) => (
              <div
                key={a.id}
                className={`mb-0.5 rounded px-1 py-0.5 truncate ${
                  a.status === "pending"
                    ? "bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100"
                    : "text-white"
                }`}
                style={
                  a.status !== "pending"
                    ? { backgroundColor: a.departmentColor || "#3B82F6" }
                    : undefined
                }
                title={`${a.taskTitle} (${a.status})`}
              >
                {a.taskTitle}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
