/**
 * Staff Dashboard Page (Boundary Layer)
 *
 * Personal dashboard for staff members showing upcoming shifts,
 * weekly schedule, certifications, and performance stats.
 * Fetches data from the organization dashboard API endpoint.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  ChevronRight,
  CalendarDays,
  TrendingUp,
  Award,
  Timer,
  BarChart3,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { certificationDisplayState } from "@/lib/certification-display";
import { OperationsAssistant } from "@/components/operations/operations-assistant";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
    active: number;
  };
  weekAssignments: StaffAssignment[];
  availability: StaffAvailability[];
  certifications: StaffCert[];
  stats: {
    shiftsThisMonth: number;
    hoursThisMonth: number;
    completionRate: number;
    onTimeRate: number;
  };
}

interface StaffDashboardResponse {
  role: string;
  staffData: StaffData | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Format an ISO time string (HH:mm:ss or HH:mm) to 12-hour display. */
function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m).padStart(2, "0")}${suffix}`;
}

/** Format an ISO datetime string to a short day/time label. */
function formatDayTime(iso: string): string {
  const d = new Date(iso);
  const day = DAY_LABELS[((d.getDay() + 6) % 7)]; // Mon=0
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 || 12;
  return `${day} ${hour12}:${String(m).padStart(2, "0")}${suffix}`;
}

/**
 * Return an array of 7 Date objects for the current week (Mon-Sun).
 */
function getCurrentWeekDates(): Date[] {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

/** Check if two dates fall on the same calendar day. */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// ---------------------------------------------------------------------------
// Dot-grid overlay used on the hero card
// ---------------------------------------------------------------------------

function DotGrid() {
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
      style={{ opacity: 0.08 }}
    >
      <defs>
        <pattern
          id="dot-grid"
          x="0"
          y="0"
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="2" cy="2" r="1.2" fill="white" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dot-grid)" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StaffDashboard({
  orgId,
  orgName,
  userName,
}: {
  orgId: string;
  orgName: string;
  userName?: string;
}) {
  const [data, setData] = useState<StaffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchDashboard() {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(`/api/organizations/${orgId}/dashboard`);
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "Dashboard data not found."
              : `Failed to load dashboard (${res.status}).`
          );
        }

        const json: StaffDashboardResponse = await res.json();

        if (!cancelled) {
          setData(json.staffData ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Something went wrong."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDashboard();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // -- Loading state --------------------------------------------------------
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
          <p className="text-sm text-muted-foreground">
            Loading your dashboard...
          </p>
        </div>
      </div>
    );
  }

  // -- Error state ----------------------------------------------------------
  if (error) {
    return (
      <div className="mx-auto max-w-2xl py-12">
        <AlertBanner message={error} variant="error" />
      </div>
    );
  }

  // -- Empty state ----------------------------------------------------------
  if (!data) {
    return (
      <div className="py-12">
        <EmptyState
          title="No dashboard data"
          description="We couldn't find any data for your account yet. Check back after your first assignment."
          icon={CalendarDays}
        />
      </div>
    );
  }

  // -- Derived values -------------------------------------------------------
  const weekDates = getCurrentWeekDates();
  const today = new Date();
  const hoursPercent = data.weeklyCapacity
    ? Math.min(100, Math.round((data.hoursThisWeek / data.weeklyCapacity) * 100))
    : 0;
  const completedTasks = data.weekAssignments.filter((a) =>
    ["clocked_out", "completed"].includes(a.status)
  ).length;
  const activeCount = data.tasksThisWeek.active;

  // Build a lookup: dayIndex (0=Mon) -> assignments for that day
  const assignmentsByDay: Record<number, StaffAssignment[]> = {};
  for (const a of data.weekAssignments) {
    if (!a.scheduledStart) continue;
    const d = new Date(a.scheduledStart);
    const idx = weekDates.findIndex((wd) => isSameDay(wd, d));
    if (idx >= 0) {
      (assignmentsByDay[idx] ??= []).push(a);
    }
  }

  // Build availability lookup: dayOfWeek (0=Mon in our UI) -> StaffAvailability
  // API uses 0=Sunday, so remap
  const availByDay: Record<number, StaffAvailability> = {};
  for (const av of data.availability) {
    const uiDay = av.dayOfWeek === 0 ? 6 : av.dayOfWeek - 1; // Sun→6, Mon→0 ...
    availByDay[uiDay] = av;
  }

  return (
    <div className="space-y-8">
      <OperationsAssistant orgId={orgId} role="staff" />

      {/* ------------------------------------------------------------------ */}
      {/* Greeting                                                           */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Hey{userName ? `, ${userName}` : ""}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {data.nextShift
            ? `You have ${data.tasksThisWeek.total} shift${data.tasksThisWeek.total !== 1 ? "s" : ""} this week`
            : "No upcoming shifts scheduled"}
          {activeCount > 0 &&
            ` · ${activeCount} active assignment${activeCount !== 1 ? "s" : ""}`}
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Hero row: Next Shift + Mini Stats                                  */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Next Shift Hero Card */}
        <Card className="relative overflow-hidden border-0 md:col-span-2">
          <div
            className="absolute inset-0"
            style={{
              background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
            }}
          />
          <DotGrid />
          <CardContent className="relative z-10 flex flex-col justify-between p-6 min-h-[180px]">
            {data.nextShift ? (
              <>
                <span
                  className="text-[11px] font-semibold uppercase tracking-widest"
                  style={{ color: "rgba(255,255,255,0.65)" }}
                >
                  Next shift
                </span>
                <div className="mt-3">
                  <h2 className="text-[22px] font-bold leading-tight text-white">
                    {data.nextShift.taskName}
                  </h2>
                  <p
                    className="mt-1 text-[14px]"
                    style={{ color: "rgba(255,255,255,0.75)" }}
                  >
                    {formatDayTime(data.nextShift.scheduledStart)} &ndash;{" "}
                    {formatDayTime(data.nextShift.scheduledEnd)}
                  </p>
                </div>
                {/* Department pill — pull from first matching assignment */}
                {(() => {
                  const match = data.weekAssignments.find(
                    (a) => a.taskTitle === data.nextShift?.taskName
                  );
                  if (!match?.departmentName) return null;
                  return (
                    <span
                      className="mt-4 inline-flex w-fit items-center rounded-full px-3 py-1 text-xs font-medium text-white"
                      style={{ background: "rgba(255,255,255,0.15)" }}
                    >
                      {match.departmentName}
                    </span>
                  );
                })()}
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <CalendarDays
                  className="mb-2 h-8 w-8"
                  style={{ color: "rgba(255,255,255,0.5)" }}
                />
                <p
                  className="text-sm font-medium"
                  style={{ color: "rgba(255,255,255,0.75)" }}
                >
                  No upcoming shifts
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Mini stat cards */}
        <div className="grid gap-4 grid-rows-2">
          {/* Hours this week */}
          <Card>
            <CardContent className="flex flex-col justify-center p-5 h-full">
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold tabular-nums">
                  {data.hoursThisWeek.toFixed(1)}h
                </span>
                <Clock className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                of {data.weeklyCapacity}h preferred
              </p>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${hoursPercent}%`,
                    background: "linear-gradient(90deg, #4f46e5, #7c3aed)",
                  }}
                />
              </div>
            </CardContent>
          </Card>

          {/* Tasks completed */}
          <Card>
            <CardContent className="flex flex-col justify-center p-5 h-full">
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold tabular-nums">
                  {completedTasks}
                </span>
                <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {completedTasks === 1 ? "task" : "tasks"} completed this week
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Active assignments                                                 */}
      {/* ------------------------------------------------------------------ */}
      {activeCount > 0 && (
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Active assignments
          </h3>
          <Card>
            <CardContent className="flex items-center gap-4 p-5">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-950"
              >
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">
                  {activeCount} active assignment{activeCount !== 1 ? "s" : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  Your tasks are ready. Open My Tasks to clock in or request withdrawal.
                </p>
              </div>
              <Link
                href={`/org/${orgId}/my-tasks`}
                className="inline-flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
                style={{ background: "#4f46e5" }}
              >
                View
                <ChevronRight className="h-4 w-4" />
              </Link>
            </CardContent>
          </Card>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Week strip                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Your week
        </h3>
        <div className="flex gap-2 overflow-x-auto pb-2 md:grid md:grid-cols-7 md:overflow-visible md:pb-0">
          {weekDates.map((date, i) => {
            const isToday = isSameDay(date, today);
            const dayAssignments = assignmentsByDay[i] ?? [];
            const avail = availByDay[i];

            return (
              <Card
                key={i}
                className="relative min-w-[90px] flex-1 overflow-hidden md:min-w-0"
                style={
                  isToday
                    ? { borderColor: "#4f46e5", borderWidth: 2 }
                    : undefined
                }
              >
                <CardContent className="flex flex-col items-center gap-2 p-3">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {DAY_LABELS[i]}
                  </span>
                  <span
                    className={`text-[18px] font-bold tabular-nums ${
                      isToday ? "text-indigo-600" : ""
                    }`}
                  >
                    {date.getDate()}
                  </span>

                  {/* Tags */}
                  <div className="mt-1 flex flex-col items-center gap-1 w-full">
                    {dayAssignments.map((a) => {
                      if (a.status === "assigned") {
                        return (
                          <span
                            key={a.id}
                            className="inline-flex w-full items-center justify-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:bg-amber-950 dark:text-amber-400"
                          >
                            assigned
                          </span>
                        );
                      }
                      const startLabel =
                        a.scheduledStart
                          ? formatDayTime(a.scheduledStart).split(" ")[1]
                          : null;
                      const endLabel =
                        a.scheduledEnd
                          ? formatDayTime(a.scheduledEnd).split(" ")[1]
                          : null;
                      return (
                        <span
                          key={a.id}
                          className="inline-flex w-full items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                          style={{ background: "#4f46e5" }}
                        >
                          {startLabel && endLabel
                            ? `${startLabel}-${endLabel}`
                            : "shift"}
                        </span>
                      );
                    })}

                    {dayAssignments.length === 0 && avail && avail.isAvailable && (
                      <span
                        className="inline-flex w-full items-center justify-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
                      >
                        available
                      </span>
                    )}

                    {dayAssignments.length === 0 &&
                      (!avail || !avail.isAvailable) && (
                        <span className="inline-flex w-full items-center justify-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                          off
                        </span>
                      )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Bottom two-column grid: Certifications + Quick stats               */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Certifications */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              My certifications
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.certifications.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No certifications on file.
              </p>
            ) : (
              <ul className="divide-y">
                {data.certifications.map((cert) => {
                  // The API hands back the STORED status — pending, verified,
                  // rejected or revoked. It never sends "expired" or
                  // "expiring_soon", so the old checks for those never fired
                  // and a lapsed certificate showed a green tick and a
                  // "Verified" badge. Expiry is derived here, from expiryDate.
                  const state = certificationDisplayState(
                    cert.status,
                    cert.expiryDate
                  );
                  const isWarning =
                    state === "expired" ||
                    state === "expiring" ||
                    state === "rejected" ||
                    state === "revoked";
                  return (
                    <li
                      key={cert.id}
                      className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      {isWarning ? (
                        <AlertTriangle
                          className="h-4 w-4 shrink-0"
                          style={{ color: "#d97706" }}
                        />
                      ) : (
                        <CheckCircle2
                          className="h-4 w-4 shrink-0"
                          style={{ color: "#059669" }}
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {cert.name}
                        </p>
                        {cert.expiryDate && (
                          <p className="text-xs text-muted-foreground">
                            Expires{" "}
                            {new Date(cert.expiryDate).toLocaleDateString(
                              undefined,
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              }
                            )}
                          </p>
                        )}
                      </div>
                      <StatusBadge
                        value={state}
                        palette="certification"
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Quick stats */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              Quick stats
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              {/* Completion rate */}
              <div className="rounded-xl bg-indigo-50 p-4 dark:bg-indigo-950">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300">
                    Completion
                  </span>
                </div>
                <p className="mt-2 text-xl font-bold tabular-nums text-indigo-600 dark:text-indigo-400">
                  {data.stats.completionRate}%
                </p>
              </div>

              {/* On-time rate */}
              <div className="rounded-xl bg-emerald-50 p-4 dark:bg-emerald-950">
                <div className="flex items-center gap-2">
                  <Timer className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    On time
                  </span>
                </div>
                <p className="mt-2 text-xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {data.stats.onTimeRate}%
                </p>
              </div>

              {/* Shifts this month */}
              <div className="rounded-xl bg-indigo-50 p-4 dark:bg-indigo-950">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300">
                    Shifts
                  </span>
                </div>
                <p className="mt-2 text-xl font-bold tabular-nums text-indigo-600 dark:text-indigo-400">
                  {data.stats.shiftsThisMonth}
                </p>
                <p className="text-[10px] text-muted-foreground">this month</p>
              </div>

              {/* Hours this month */}
              <div className="rounded-xl bg-indigo-50 p-4 dark:bg-indigo-950">
                <div className="flex items-center gap-2">
                  <Award className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300">
                    Hours
                  </span>
                </div>
                <p className="mt-2 text-xl font-bold tabular-nums text-indigo-600 dark:text-indigo-400">
                  {data.stats.hoursThisMonth.toFixed(1)}
                </p>
                <p className="text-[10px] text-muted-foreground">this month</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
