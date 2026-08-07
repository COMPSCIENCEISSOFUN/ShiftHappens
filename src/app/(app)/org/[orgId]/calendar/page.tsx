/**
 * Calendar View Page (Boundary Layer)
 *
 * Weekly + Day calendar with heatmap coverage layer.
 * Week view: overview with heatmap tints and coverage counts.
 * Day view: full-width single day with staff availability panel.
 * Operating hours are configurable via company settings.
 * Inline assign modal for understaffed tasks in day view.
 *
 * Click a day header to drill into day view.
 * "Back to week" returns to the weekly overview.
 *
 * Phase 12 visual overhaul — stat tiles, accent corners, dept
 * colour bars, avatar stacks, responsive breakpoints.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CalendarAssignModal } from "@/components/calendar/calendar-assign-modal";
import { SLOT_OCCUPYING_ASSIGNMENT_STATUSES } from "@/lib/assignment-status";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { StatusBadge } from "@/components/ui/status-badge";
import { intersectsCalendarDay, positionForCalendarDay } from "@/lib/calendar-timeline";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  requiredHeadcount: number;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  description?: string | null;
  location?: string | null;
  instructions?: string | null;
  requiredCertifications?: string[];
  project?: { id: string; title: string; status: string } | null;
  department: { id: string; name: string; color: string | null } | null;
  assignments: {
    id: string;
    status: string;
    membership: { user: { name: string | null } };
  }[];
}

/** Assignments that still count toward the staffing headcount. */
function activeAssignments(task: Task) {
  return task.assignments.filter(
    (a) => (SLOT_OCCUPYING_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status)
  );
}

interface CoverageCell {
  dayOfWeek: number;
  hour: number;
  count: number;
}

interface StaffSchedule {
  membershipId: string;
  name: string;
  schedules: {
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    isAvailable: boolean;
  }[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatFullDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function getWeekDates(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

function getCoverageTint(count: number, isDark: boolean): string {
  if (count >= 4) return isDark ? "rgba(34,197,94,0.12)" : "rgba(34,197,94,0.08)";
  if (count === 3) return isDark ? "rgba(34,197,94,0.07)" : "rgba(34,197,94,0.04)";
  if (count >= 1) return isDark ? "rgba(245,158,11,0.10)" : "rgba(245,158,11,0.06)";
  return isDark ? "rgba(239,68,68,0.10)" : "rgba(239,68,68,0.05)";
}

function calculateOverlapColumns(dayTasks: Task[]): Map<string, { column: number; totalColumns: number }> {
  const result = new Map<string, { column: number; totalColumns: number }>();
  if (dayTasks.length === 0) return result;
  const sorted = [...dayTasks].sort((a, b) => new Date(a.scheduledStart!).getTime() - new Date(b.scheduledStart!).getTime());
  const groups: Task[][] = [];
  let currentGroup: Task[] = [sorted[0]];
  let groupEnd = new Date(sorted[0].scheduledEnd!).getTime();
  for (let i = 1; i < sorted.length; i++) {
    const taskStart = new Date(sorted[i].scheduledStart!).getTime();
    if (taskStart < groupEnd) {
      currentGroup.push(sorted[i]);
      groupEnd = Math.max(groupEnd, new Date(sorted[i].scheduledEnd!).getTime());
    } else {
      groups.push(currentGroup);
      currentGroup = [sorted[i]];
      groupEnd = new Date(sorted[i].scheduledEnd!).getTime();
    }
  }
  groups.push(currentGroup);
  for (const group of groups) {
    group.forEach((task, column) => result.set(task.id, { column, totalColumns: group.length }));
  }
  return result;
}

/** Generate a two-letter avatar from a name. */
function initials(name: string | null): string {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Deterministic colour for avatar by name hash. */
const AVATAR_COLOURS = [
  "bg-indigo-600", "bg-cyan-600", "bg-emerald-600", "bg-amber-600",
  "bg-rose-600", "bg-purple-600", "bg-teal-600", "bg-orange-600",
];
function avatarColour(name: string | null): string {
  if (!name) return "bg-gray-400";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLOURS[Math.abs(h) % AVATAR_COLOURS.length];
}

/* ------------------------------------------------------------------ */
/*  Stat Tile                                                          */
/* ------------------------------------------------------------------ */

function StatTile({
  label, value, detail, accentColour, valueColour,
}: {
  label: string; value: string | number; detail: string;
  accentColour: string; valueColour?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-3.5 sm:p-4">
      <div className="absolute right-0 top-0 h-10 w-10 rounded-bl-[40px]" style={{ background: accentColour }} />
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold tracking-tight sm:text-2xl ${valueColour ?? ""}`}>{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Task Detail Panel (shared)                                         */
/* ------------------------------------------------------------------ */

function TaskDetailPanel({ task, onClose }: { task: Task; onClose: () => void }) {
  const active = activeAssignments(task);
  const color = task.department?.color || "#94A3B8";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label={`Task details for ${task.title}`}>
      <button type="button" aria-label="Close task details" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-xl flex-col overflow-hidden bg-card shadow-2xl sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:rounded-xl sm:border sm:border-border">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5 font-semibold">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-[15px]">{task.title}</span>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground"
        >
          Close
        </button>
      </div>

      {/* Body — responsive grid */}
      <div className="overflow-y-auto">
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Department</p>
          <p className="mt-1 text-[13px] font-medium">{task.department?.name || "None"}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Status</p>
          <div className="mt-1">
            <StatusBadge value={task.status} palette="taskStatus" />
          </div>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Priority</p>
          <div className="mt-1">
            <StatusBadge value={task.priority} palette="priority" />
          </div>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Staffing</p>
          <p className={`mt-1 text-[13px] font-medium ${active.length >= task.requiredHeadcount ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
            {active.length}/{task.requiredHeadcount} {active.length >= task.requiredHeadcount ? "✓" : ""}
          </p>
        </div>
        <div className="col-span-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Schedule</p>
          <p className="mt-1 text-[13px] font-medium">
            {task.scheduledStart && new Date(task.scheduledStart).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            {task.scheduledEnd && ` — ${new Date(task.scheduledEnd).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
          </p>
        </div>
        <div className="col-span-2 sm:col-span-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Assigned Staff</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {task.assignments.length === 0 ? (
              <span className="text-xs text-muted-foreground">No staff assigned</span>
            ) : (
              task.assignments.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs">
                  <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[8px] font-bold text-white ${avatarColour(a.membership.user.name)}`}>
                    {initials(a.membership.user.name)}
                  </span>
                  <span className="font-medium">{a.membership.user.name || "Unnamed"}</span>
                  <span className="text-muted-foreground">({a.status.replace(/_/g, " ")})</span>
                </span>
              ))
            )}
          </div>
        </div>
        {task.project && (
          <div className="col-span-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Project</p>
            <p className="mt-1 text-[13px] font-medium">{task.project.title}</p>
          </div>
        )}
        {task.description && (
          <div className="col-span-2 sm:col-span-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Description</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{task.description}</p>
          </div>
        )}
        {task.location && (
          <div className="col-span-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Location</p>
            <p className="mt-1 text-[13px] font-medium">{task.location}</p>
          </div>
        )}
        {task.requiredCertifications && task.requiredCertifications.length > 0 && (
          <div className="col-span-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Required certifications</p>
            <p className="mt-1 text-[13px] font-medium">{task.requiredCertifications.join(", ")}</p>
          </div>
        )}
        {task.instructions && (
          <div className="col-span-2 sm:col-span-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Instructions</p>
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">{task.instructions}</p>
          </div>
        )}
      </div>
      </div>
    </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function CalendarPage() {
  const params = useParams();
  const orgId = params.orgId as string;

  const [tasks, setTasks] = useState<Task[]>([]);
  const [coverage, setCoverage] = useState<CoverageCell[]>([]);
  const [staffData, setStaffData] = useState<StaffSchedule[]>([]);
  const [showCoverage, setShowCoverage] = useState(true);
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [filterDept, setFilterDept] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());

  const [viewMode, setViewMode] = useState<"week" | "day">("week");
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());

  const [opStart, setOpStart] = useState(6);
  const [opEnd, setOpEnd] = useState(22);

  const [assignTask, setAssignTask] = useState<{
    id: string; title: string; requiredHeadcount: number; currentCount: number;
  } | null>(null);

  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains("dark"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/tasks`);
      if (!res.ok) { setError("Failed to load tasks"); return; }
      setTasks(await res.json());
      setError(null);
    } catch { setError("Failed to load tasks"); } finally { setLoading(false); }
  }, [orgId]);

  const fetchCoverage = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/calendar/coverage`);
      if (res.ok) setCoverage(await res.json());
    } catch { /* non-critical */ }
  }, [orgId]);

  const fetchStaff = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/calendar/staff`);
      if (res.ok) setStaffData(await res.json());
    } catch { /* non-critical */ }
  }, [orgId]);

  const fetchCalendarSettings = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/calendar-settings`);
      if (res.ok) {
        const data = await res.json();
        if (data.operatingHoursStart !== undefined) setOpStart(data.operatingHoursStart);
        if (data.operatingHoursEnd !== undefined) setOpEnd(data.operatingHoursEnd);
      }
    } catch { /* use defaults */ }
  }, [orgId]);

  const HOURS = Array.from({ length: opEnd - opStart }, (_, i) => i + opStart);
  const totalHours = HOURS.length;

  function getCoverageCount(dayOfWeek: number, hour: number): number {
    return coverage.find((c) => c.dayOfWeek === dayOfWeek && c.hour === hour)?.count ?? 0;
  }

  function prevWeek() { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d); }
  function nextWeek() { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d); }
  function goToday() { setWeekStart(getWeekStart(new Date())); setViewMode("week"); }

  function openDayView(date: Date) { setSelectedDate(date); setViewMode("day"); setSelectedTask(null); }
  function prevDay() { const d = new Date(selectedDate); d.setDate(d.getDate() - 1); setSelectedDate(d); }
  function nextDay() { const d = new Date(selectedDate); d.setDate(d.getDate() + 1); setSelectedDate(d); }

  const weekDates = getWeekDates(weekStart);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7);
  const today = new Date();
  const todayStr = today.toDateString();

  const departments = Array.from(
    new Map(tasks.filter((t) => t.department).map((t) => [t.department!.id, t.department!])).values()
  ).sort((a, b) => a.name.localeCompare(b.name));

  const filteredTasks = filterDept ? tasks.filter((t) => t.department?.id === filterDept) : tasks;
  const unscheduledCount = filteredTasks.filter((t) => !t.scheduledStart || !t.scheduledEnd).length;

  function getScheduledTasks(startDate: Date, endDate: Date): Task[] {
    return filteredTasks.filter((t) => {
      if (!t.scheduledStart || !t.scheduledEnd) return false;
      return new Date(t.scheduledStart) < endDate && new Date(t.scheduledEnd) > startDate;
    });
  }

  function getTasksForDay(date: Date): Task[] {
    return filteredTasks.filter((task) => intersectsCalendarDay(task, date));
  }

  useEffect(() => {
    void fetchTasks();
    void fetchCoverage();
    void fetchStaff();
    void fetchCalendarSettings();
  }, [fetchCalendarSettings, fetchCoverage, fetchStaff, fetchTasks]);

  useEffect(() => {
    function onFocus() { void fetchTasks(); }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchTasks]);

  function getCurrentTimePosition(): number | null {
    const hour = currentTime.getHours() + currentTime.getMinutes() / 60;
    if (hour < opStart || hour > opEnd) return null;
    return ((hour - opStart) / totalHours) * 100;
  }

  function getStaffForDay(date: Date) {
    const dow = date.getDay();
    const dayTasks = getTasksForDay(date);

    return staffData.map((staff) => {
      const schedule = staff.schedules.find((s) => s.dayOfWeek === dow);
      const isAvailable = schedule?.isAvailable ?? false;
      const assignments = dayTasks.filter((t) =>
        t.assignments.some((a) => a.membership.user.name === staff.name)
      );
      return {
        ...staff,
        isAvailable,
        availableHours: isAvailable ? `${schedule!.startTime}–${schedule!.endTime}` : null,
        assignedTasks: assignments.map((t) => ({
          title: t.title,
          color: t.department?.color || "#94A3B8",
        })),
      };
    });
  }

  const timePosition = getCurrentTimePosition();

  /* ---- Stat computations ---- */
  const weekTasks = getScheduledTasks(weekStart, weekEnd);
  const understaffedCount = (viewMode === "week" ? weekTasks : getTasksForDay(selectedDate)).filter(
    (t) => activeAssignments(t).length < t.requiredHeadcount
  ).length;

  // Coverage percentage: scheduled hours with ≥ 1 staff / total scheduled hours
  const coveragePercent = (() => {
    if (coverage.length === 0) return null;
    const relevant = coverage.filter((c) => c.hour >= opStart && c.hour < opEnd);
    if (relevant.length === 0) return null;
    const covered = relevant.filter((c) => c.count > 0).length;
    return Math.round((covered / relevant.length) * 100);
  })();

  // On-duty today count
  const todayDow = today.getDay();
  const onDutyToday = staffData.filter((s) => {
    const sched = s.schedules.find((sc) => sc.dayOfWeek === todayDow);
    return sched?.isAvailable ?? false;
  }).length;

  if (loading) return <PageLoading />;

  /* ================================================================ */
  /*  DAY VIEW                                                         */
  /* ================================================================ */
  if (viewMode === "day") {
    const dayTasks = getTasksForDay(selectedDate);
    const overlapMap = calculateOverlapColumns(dayTasks);
    const isToday = selectedDate.toDateString() === todayStr;
    const dayStaff = getStaffForDay(selectedDate);
    const dow = selectedDate.getDay();

    const dayUnderstaffed = dayTasks.filter((t) => activeAssignments(t).length < t.requiredHeadcount);

    return (
      <div className="w-full">
        {/* ── Header ── */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setViewMode("week")}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400"
            >
              ← Week
            </button>
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">{formatFullDate(selectedDate)}</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={prevDay} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground">
              ← Prev
            </button>
            <button
              onClick={() => setSelectedDate(new Date())}
              className="rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950 px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 transition-colors hover:bg-indigo-100 dark:hover:bg-indigo-900"
            >
              Today
            </button>
            <button onClick={nextDay} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground">
              Next →
            </button>
          </div>
        </div>

        {error && <AlertBanner message={error} variant="error" />}

        {/* ── Stat tiles ── */}
        <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <StatTile label="Tasks" value={dayTasks.length} detail={`scheduled for ${DAYS[dow]}`} accentColour="rgba(99,102,241,.08)" />
          <StatTile
            label="Coverage"
            value={coveragePercent !== null ? `${coveragePercent}%` : "—"}
            detail="of hours covered"
            accentColour="rgba(34,197,94,.08)"
            valueColour={coveragePercent !== null && coveragePercent >= 80 ? "text-green-600 dark:text-green-400" : coveragePercent !== null ? "text-amber-600 dark:text-amber-400" : ""}
          />
          <StatTile
            label="Understaffed"
            value={dayUnderstaffed.length}
            detail="tasks need staff"
            accentColour="rgba(245,158,11,.08)"
            valueColour={dayUnderstaffed.length > 0 ? "text-amber-600 dark:text-amber-400" : ""}
          />
          <StatTile label="Available" value={dayStaff.filter((s) => s.isAvailable).length} detail={`of ${dayStaff.length} staff`} accentColour="rgba(59,130,246,.08)" valueColour="text-blue-600 dark:text-blue-400" />
        </div>

        {/* ── Day grid + staff sidebar ── */}
        <div className="flex flex-col gap-0 lg:flex-row">
          {/* Day grid */}
          <div className="flex-1 overflow-hidden rounded-xl border border-border bg-card lg:rounded-r-none lg:border-r-0">
            <div className="grid" style={{ gridTemplateColumns: "50px 1fr", minHeight: `${totalHours * 48}px` }}>
              {/* Hour labels */}
              <div className="border-r border-border">
                {HOURS.map((hour) => (
                  <div key={hour} className="flex items-start border-b border-border px-2 pt-1 text-[11px] text-muted-foreground" style={{ height: `${100 / totalHours}%` }}>
                    {formatHourLabel(hour)}
                  </div>
                ))}
              </div>

              {/* Day column */}
              <div className={`relative ${isToday ? "bg-indigo-50/30 dark:bg-indigo-950/20" : ""}`}>
                {HOURS.map((hour) => {
                  const count = getCoverageCount(dow, hour);
                  return (
                    <div key={hour} className="relative border-b border-border" style={{
                      height: `${100 / totalHours}%`,
                      backgroundColor: showCoverage && coverage.length > 0 ? getCoverageTint(count, isDark) : undefined,
                    }}>
                      {showCoverage && coverage.length > 0 && (
                        <span className="absolute bottom-0.5 right-1 select-none text-[9px] text-muted-foreground/50">{count}</span>
                      )}
                    </div>
                  );
                })}

                {/* Current time indicator */}
                {isToday && timePosition !== null && (
                  <div className="absolute left-0 right-0 z-20 flex items-center pointer-events-none" style={{ top: `${timePosition}%` }}>
                    <div className="h-2.5 w-2.5 rounded-full bg-red-500 -ml-1 shadow-[0_0_0_2px_rgba(239,68,68,0.2)] animate-pulse" />
                    <div className="flex-1 h-[2px] bg-red-500" />
                  </div>
                )}

                {/* Task blocks */}
                {dayTasks.map((task) => {
                  const pos = positionForCalendarDay(task, selectedDate, opStart, opEnd);
                  if (!pos) return null;
                  const color = task.department?.color || "#94A3B8";
                  const overlap = overlapMap.get(task.id) || { column: 0, totalColumns: 1 };
                  const widthPercent = 100 / overlap.totalColumns;
                  const leftPercent = overlap.column * widthPercent;
                  const active = activeAssignments(task);
                  const isUnderstaffed = active.length < task.requiredHeadcount;

                  return (
                    <button
                      type="button"
                      key={task.id}
                      className="absolute cursor-pointer overflow-hidden rounded-lg px-2.5 py-2 transition-all hover:shadow-md hover:-translate-y-px z-10"
                      style={{
                        top: pos.top, height: pos.height,
                        left: `calc(${leftPercent}% + 4px)`, width: `calc(${widthPercent}% - 8px)`,
                        backgroundColor: `${color}15`, borderLeft: `4px solid ${color}`,
                        ...(isUnderstaffed ? { outline: "1.5px dashed #F59E0B", outlineOffset: "-1px" } : {}),
                      }}
                      onClick={() => setSelectedTask(task)}
                      aria-label={`View details for ${task.title}`}
                    >
                      <div className="truncate text-[13px] font-semibold" style={{ color }}>{task.title}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {new Date(task.scheduledStart!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} — {new Date(task.scheduledEnd!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      </div>
                      {/* Staff avatars */}
                      <div className="mt-1.5 flex items-center gap-1">
                        {active.slice(0, 4).map((a, idx) => (
                          <div
                            key={a.id}
                            className={`flex h-[22px] w-[22px] items-center justify-center rounded-full text-[9px] font-bold text-white ring-1.5 ring-white dark:ring-gray-800 ${avatarColour(a.membership.user.name)}`}
                            style={idx > 0 ? { marginLeft: "-4px" } : {}}
                            title={a.membership.user.name || "Unnamed"}
                          >
                            {initials(a.membership.user.name)}
                          </div>
                        ))}
                        {active.length > 4 && (
                          <span className="ml-0.5 text-[10px] font-medium text-muted-foreground">+{active.length - 4}</span>
                        )}
                        <span className={`ml-1 text-[10px] font-semibold ${isUnderstaffed ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400"}`}>
                          {active.length}/{task.requiredHeadcount}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Staff sidebar */}
          <div className="w-full overflow-hidden rounded-xl border border-border bg-card lg:w-[280px] lg:rounded-l-none lg:border-l-0" style={{ maxHeight: `${totalHours * 48 + 2}px` }}>
            {/* Sidebar header */}
            <div className="sticky top-0 z-[2] flex items-center justify-between border-b border-border bg-card px-4 py-3">
              <h3 className="text-[13px] font-semibold">Staff — {DAYS[dow]}</h3>
              <span className="text-[11px] text-muted-foreground">{dayStaff.filter((s) => s.isAvailable).length} available</span>
            </div>

            {/* Staff list */}
            <div className="overflow-y-auto p-2" style={{ maxHeight: `${totalHours * 48 - 80}px` }}>
              {dayStaff.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">No staff data</p>
              ) : (
                dayStaff.map((staff) => (
                  <div key={staff.membershipId} className={`flex gap-2.5 rounded-lg p-2.5 transition-colors hover:bg-muted/60 ${!staff.isAvailable ? "opacity-50" : ""}`}>
                    <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${staff.isAvailable ? avatarColour(staff.name) : "bg-gray-400 dark:bg-gray-600"}`}>
                      {initials(staff.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium">{staff.name}</p>
                      {staff.isAvailable ? (
                        <>
                          <p className="text-[11px] text-muted-foreground">{staff.availableHours}</p>
                          {/* Availability bar */}
                          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.min(100, (staff.assignedTasks.length / Math.max(1, dayTasks.length)) * 100 + 20)}%`,
                                backgroundColor: staff.assignedTasks.length > 0 ? (staff.assignedTasks[0].color || "#6366f1") : "#94a3b8",
                              }}
                            />
                          </div>
                          {/* Assignment badges */}
                          {staff.assignedTasks.length > 0 ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {staff.assignedTasks.map((at, i) => (
                                <span key={i} className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${at.color}15`, color: at.color }}>
                                  {at.title.length > 16 ? at.title.slice(0, 16) + "…" : at.title}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-0.5 text-[10px] text-blue-600 dark:text-blue-400">Available — unassigned</p>
                          )}
                        </>
                      ) : (
                        <p className="text-[11px] text-red-500 dark:text-red-400">Off today</p>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Understaffed alerts */}
            {dayUnderstaffed.length > 0 && (
              <div className="border-t border-border px-3 py-2.5">
                <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">⚠ Needs Staff</h4>
                {dayUnderstaffed.map((t) => {
                  const activeCount = activeAssignments(t).length;
                  return (
                    <div key={t.id} className="flex items-center justify-between border-b border-border py-1.5 last:border-b-0">
                      <div>
                        <p className="text-xs font-medium">{t.title}</p>
                        <p className="text-[11px] text-amber-600 dark:text-amber-400">needs {t.requiredHeadcount - activeCount} more</p>
                      </div>
                      <button
                        onClick={() => setAssignTask({
                          id: t.id, title: t.title,
                          requiredHeadcount: t.requiredHeadcount, currentCount: activeCount,
                        })}
                        className="text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                      >
                        Assign →
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Assign modal */}
        {assignTask && (
          <CalendarAssignModal
            taskId={assignTask.id}
            taskTitle={assignTask.title}
            requiredHeadcount={assignTask.requiredHeadcount}
            currentCount={assignTask.currentCount}
            orgId={orgId}
            onClose={() => setAssignTask(null)}
            onAssigned={() => { fetchTasks(); fetchCoverage(); }}
          />
        )}

        {/* Task detail panel */}
        {selectedTask && <TaskDetailPanel task={selectedTask} onClose={() => setSelectedTask(null)} />}
      </div>
    );
  }

  /* ================================================================ */
  /*  WEEK VIEW                                                        */
  /* ================================================================ */
  return (
    <div className="w-full">
      {/* ── Page header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Calendar</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Weekly schedule and staffing coverage overview</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* View toggle pill */}
          <div className="flex overflow-hidden rounded-[10px] border border-border">
            <button
              onClick={() => setViewMode("week")}
              className={`px-3.5 py-1.5 text-[13px] font-medium transition-colors ${viewMode === "week" ? "bg-indigo-600 text-white" : "bg-card text-muted-foreground hover:text-foreground"}`}
            >
              Week
            </button>
            <button
              onClick={() => { setViewMode("day"); setSelectedDate(new Date()); }}
              className="border-l border-border px-3.5 py-1.5 text-[13px] font-medium transition-colors bg-card text-muted-foreground hover:text-foreground"
            >
              Day
            </button>
          </div>
          <button onClick={prevWeek} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground">← Prev</button>
          <button
            onClick={goToday}
            className="rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950 px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 transition-colors hover:bg-indigo-100 dark:hover:bg-indigo-900"
          >
            Today
          </button>
          <button onClick={nextWeek} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground">Next →</button>
        </div>
      </div>

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile label="This Week" value={weekTasks.length} detail="scheduled tasks" accentColour="rgba(99,102,241,.08)" />
        <StatTile
          label="Coverage"
          value={coveragePercent !== null ? `${coveragePercent}%` : "—"}
          detail="of hours covered"
          accentColour="rgba(34,197,94,.08)"
          valueColour={coveragePercent !== null && coveragePercent >= 80 ? "text-green-600 dark:text-green-400" : coveragePercent !== null ? "text-amber-600 dark:text-amber-400" : ""}
        />
        <StatTile
          label="Understaffed"
          value={understaffedCount}
          detail="tasks need staff"
          accentColour="rgba(245,158,11,.08)"
          valueColour={understaffedCount > 0 ? "text-amber-600 dark:text-amber-400" : ""}
        />
        <StatTile label="On Duty Today" value={onDutyToday} detail={`of ${staffData.length} staff`} accentColour="rgba(59,130,246,.08)" valueColour="text-blue-600 dark:text-blue-400" />
      </div>

      {/* ── Toolbar ── */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm font-semibold">{formatDate(weekDates[0])} — {formatDate(weekDates[6])}, {weekDates[0].getFullYear()}</span>
        <div className="flex flex-wrap items-center gap-2">
          {unscheduledCount > 0 && (
            <span className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {unscheduledCount} unscheduled
            </span>
          )}
          <button
            onClick={() => setShowCoverage(!showCoverage)}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${showCoverage ? "border-green-300 dark:border-green-800 bg-green-50/60 dark:bg-green-950/30 text-green-700 dark:text-green-400" : "border-border bg-card text-muted-foreground"}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
            Coverage
          </button>
          <select
            className="rounded-[20px] border border-border bg-card px-2.5 py-1 pr-7 text-xs text-muted-foreground appearance-none"
            value={filterDept}
            onChange={(e) => setFilterDept(e.target.value)}
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 8px center",
            }}
          >
            <option value="">All departments</option>
            {departments.map((dept) => (<option key={dept.id} value={dept.id}>{dept.name}</option>))}
          </select>
        </div>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {/* ── Week grid ── */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        {/* Day headers — clickable for day view */}
        <div className="grid border-b border-border" style={{ gridTemplateColumns: "50px repeat(7, 1fr)", minWidth: "640px" }}>
          <div className="border-r border-border p-2" />
          {weekDates.map((date, i) => {
            const dayTasksForHeader = getTasksForDay(date);
            const dayDepts = Array.from(new Set(dayTasksForHeader.map((t) => t.department?.color).filter(Boolean)));
            const isDateToday = date.toDateString() === todayStr;

            return (
              <div
                key={i}
                className={`cursor-pointer border-r border-border p-2 text-center transition-colors last:border-r-0 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30 ${isDateToday ? "bg-indigo-50/60 dark:bg-indigo-950/30" : ""}`}
                onClick={() => openDayView(date)}
              >
                <div className={`text-xs font-semibold ${isDateToday ? "text-indigo-600 dark:text-indigo-400" : "text-muted-foreground"}`}>{DAYS[date.getDay()]}</div>
                <div className={`text-lg font-bold ${isDateToday ? "text-indigo-600 dark:text-indigo-400" : ""}`}>{date.getDate()}</div>
                <div className="text-[10px] text-muted-foreground">{dayTasksForHeader.length} {dayTasksForHeader.length === 1 ? "task" : "tasks"}</div>
                {/* Department colour dots */}
                {dayDepts.length > 0 && (
                  <div className="mt-1 flex justify-center gap-[3px]">
                    {dayDepts.slice(0, 4).map((c, j) => (
                      <span key={j} className="h-[6px] w-[6px] rounded-full" style={{ backgroundColor: c as string }} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Grid body */}
        <div className="grid" style={{ gridTemplateColumns: "50px repeat(7, 1fr)", minHeight: `${totalHours * 40}px`, minWidth: "640px" }}>
          {/* Hour labels */}
          <div className="border-r border-border">
            {HOURS.map((hour) => (
              <div key={hour} className="flex items-start border-b border-border px-2 pt-1 text-[11px] text-muted-foreground" style={{ height: `${100 / totalHours}%` }}>
                {formatHourLabel(hour)}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {weekDates.map((date, dayIndex) => {
            const dayTasks = getTasksForDay(date);
            const overlapMap = calculateOverlapColumns(dayTasks);
            const isToday = date.toDateString() === todayStr;
            const dow = date.getDay();

            return (
              <div key={dayIndex} className={`relative border-r border-border last:border-r-0 ${isToday ? "bg-indigo-50/30 dark:bg-indigo-950/20" : ""}`}>
                {HOURS.map((hour) => {
                  const count = getCoverageCount(dow, hour);
                  return (
                    <div key={hour} className="relative border-b border-border" style={{
                      height: `${100 / totalHours}%`,
                      backgroundColor: showCoverage && coverage.length > 0 ? getCoverageTint(count, isDark) : undefined,
                    }}>
                      {showCoverage && coverage.length > 0 && (
                        <span className="absolute bottom-0.5 right-1 select-none text-[9px] text-muted-foreground/50">{count}</span>
                      )}
                    </div>
                  );
                })}

                {/* Current time indicator */}
                {isToday && timePosition !== null && (
                  <div className="absolute left-0 right-0 z-20 flex items-center pointer-events-none" style={{ top: `${timePosition}%` }}>
                    <div className="h-2.5 w-2.5 rounded-full bg-red-500 -ml-1 shadow-[0_0_0_2px_rgba(239,68,68,0.2)] animate-pulse" />
                    <div className="flex-1 h-[2px] bg-red-500" />
                  </div>
                )}

                {/* Task blocks */}
                {dayTasks.map((task) => {
                  const pos = positionForCalendarDay(task, date, opStart, opEnd);
                  if (!pos) return null;
                  const color = task.department?.color || "#94A3B8";
                  const overlap = overlapMap.get(task.id) || { column: 0, totalColumns: 1 };
                  const widthPercent = 100 / overlap.totalColumns;
                  const leftPercent = overlap.column * widthPercent;
                  const activeCount = activeAssignments(task).length;
                  const isUnderstaffed = activeCount < task.requiredHeadcount;

                  return (
                    <button
                      type="button"
                      key={task.id}
                      className="absolute cursor-pointer overflow-hidden rounded-md px-1 py-0.5 text-xs transition-opacity hover:opacity-90 z-10"
                      style={{
                        top: pos.top, height: pos.height,
                        left: `calc(${leftPercent}% + 2px)`, width: `calc(${widthPercent}% - 4px)`,
                        backgroundColor: `${color}20`, borderLeft: `3px solid ${color}`,
                        ...(isUnderstaffed ? { outline: "1.5px dashed #F59E0B", outlineOffset: "-1px" } : {}),
                      }}
                      onClick={() => setSelectedTask(task)}
                      aria-label={`View details for ${task.title}`}
                    >
                      <div className="truncate font-medium" style={{ color }}>{task.title}</div>
                      {parseFloat(pos.height) > 8 && (
                        <div className="truncate text-muted-foreground" style={{ fontSize: "10px" }}>{activeCount}/{task.requiredHeadcount} staff</div>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Legend ── */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] bg-muted/50 px-4 py-2.5">
        {departments.map((dept) => (
          <div key={dept.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: dept.color || "#94A3B8" }} />
            {dept.name}
          </div>
        ))}
        {showCoverage && departments.length > 0 && <span className="mx-1 h-4 border-l border-border" />}
        {showCoverage && (
          <>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="inline-block h-2.5 w-3.5 rounded" style={{ backgroundColor: getCoverageTint(4, isDark), border: "1px solid rgba(34,197,94,.2)" }} /> 4+ staff
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="inline-block h-2.5 w-3.5 rounded" style={{ backgroundColor: getCoverageTint(2, isDark), border: "1px solid rgba(245,158,11,.2)" }} /> 1–3
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="inline-block h-2.5 w-3.5 rounded" style={{ backgroundColor: getCoverageTint(0, isDark), border: "1px solid rgba(239,68,68,.15)" }} /> None
            </div>
            <span className="mx-1 h-4 border-l border-border" />
            <div className="rounded border-[1.5px] border-dashed border-amber-500 px-2 py-0.5 text-[11px] text-muted-foreground">Understaffed</div>
          </>
        )}
      </div>

      {/* Task detail panel */}
      {selectedTask && <TaskDetailPanel task={selectedTask} onClose={() => setSelectedTask(null)} />}
    </div>
  );
}
