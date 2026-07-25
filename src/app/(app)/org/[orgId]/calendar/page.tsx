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
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CalendarAssignModal } from "@/components/calendar/calendar-assign-modal";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  requiredHeadcount: number;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  department: { id: string; name: string; color: string | null } | null;
  assignments: {
    id: string;
    status: string;
    membership: { user: { name: string | null } };
  }[];
}

/** Statuses that no longer occupy a staffing slot. */
const INACTIVE_ASSIGNMENT_STATUSES = ["rejected", "withdrawn"];

/** Assignments that still count toward the staffing headcount. */
function activeAssignments(task: Task) {
  return task.assignments.filter(
    (a) => !INACTIVE_ASSIGNMENT_STATUSES.includes(a.status)
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
    fetchTasks();
    fetchCoverage();
    fetchStaff();
    fetchSettings();
  }, [orgId]);

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function onFocus() { fetchTasks(); }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [orgId]);

  async function fetchTasks() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/tasks`);
      if (!res.ok) { setError("Failed to load tasks"); return; }
      setTasks(await res.json());
      setError(null);
    } catch { setError("Failed to load tasks"); } finally { setLoading(false); }
  }

  async function fetchCoverage() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/calendar/coverage`);
      if (res.ok) setCoverage(await res.json());
    } catch { /* non-critical */ }
  }

  async function fetchStaff() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/calendar/staff`);
      if (res.ok) setStaffData(await res.json());
    } catch { /* non-critical */ }
  }

  async function fetchSettings() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings`);
      if (res.ok) {
        const data = await res.json();
        if (data.operatingHoursStart !== undefined) setOpStart(data.operatingHoursStart);
        if (data.operatingHoursEnd !== undefined) setOpEnd(data.operatingHoursEnd);
      }
    } catch { /* use defaults */ }
  }

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
    return filteredTasks.filter((t) => {
      if (!t.scheduledStart) return false;
      return new Date(t.scheduledStart).toDateString() === date.toDateString();
    });
  }

  function getTaskPosition(task: Task) {
    const start = new Date(task.scheduledStart!);
    const end = new Date(task.scheduledEnd!);
    const startHour = start.getHours() + start.getMinutes() / 60;
    const endHour = end.getHours() + end.getMinutes() / 60;
    const top = ((startHour - opStart) / totalHours) * 100;
    const height = ((endHour - startHour) / totalHours) * 100;
    return { top: `${top}%`, height: `${Math.max(height, 2)}%` };
  }

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
        assignedTasks: assignments.map((t) => t.title),
      };
    });
  }

  const timePosition = getCurrentTimePosition();

  if (loading) return <PageLoading />;

  // ===== DAY VIEW =====
  if (viewMode === "day") {
    const dayTasks = getTasksForDay(selectedDate);
    const overlapMap = calculateOverlapColumns(dayTasks);
    const isToday = selectedDate.toDateString() === todayStr;
    const dayStaff = getStaffForDay(selectedDate);
    const dow = selectedDate.getDay();

    return (
      <div className="max-w-6xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setViewMode("week")}>
              ← Week
            </Button>
            <h2 className="text-2xl font-bold">{formatFullDate(selectedDate)}</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={prevDay}>← Prev</Button>
            <Button variant="outline" size="sm" onClick={() => { setSelectedDate(new Date()); }}>Today</Button>
            <Button variant="outline" size="sm" onClick={nextDay}>Next →</Button>
          </div>
        </div>

        {error && <AlertBanner message={error} variant="error" />}

        <div className="flex gap-0">
          {/* Day grid */}
          <div className="flex-1 rounded-lg border border-r-0 rounded-r-none overflow-hidden">
            <div className="grid" style={{ gridTemplateColumns: "50px 1fr", minHeight: `${totalHours * 48}px` }}>
              {/* Hour labels */}
              <div className="border-r">
                {HOURS.map((hour) => (
                  <div key={hour} className="border-b text-xs text-muted-foreground px-2 flex items-start pt-1" style={{ height: `${100 / totalHours}%` }}>
                    {formatHourLabel(hour)}
                  </div>
                ))}
              </div>

              {/* Day column */}
              <div className={`relative ${isToday ? "bg-blue-50/30 dark:bg-blue-950/20" : ""}`}>
                {HOURS.map((hour) => {
                  const count = getCoverageCount(dow, hour);
                  return (
                    <div key={hour} className="border-b relative" style={{
                      height: `${100 / totalHours}%`,
                      backgroundColor: showCoverage && coverage.length > 0 ? getCoverageTint(count, isDark) : undefined,
                    }}>
                      {showCoverage && coverage.length > 0 && (
                        <span className="absolute bottom-0.5 right-1 text-[9px] text-muted-foreground/50 select-none">{count}</span>
                      )}
                    </div>
                  );
                })}

                {isToday && timePosition !== null && (
                  <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: `${timePosition}%` }}>
                    <div className="flex items-center">
                      <div className="h-2.5 w-2.5 rounded-full bg-red-500 -ml-1" />
                      <div className="flex-1 border-t-2 border-red-500" />
                    </div>
                  </div>
                )}

                {dayTasks.map((task) => {
                  const pos = getTaskPosition(task);
                  const color = task.department?.color || "#94A3B8";
                  const overlap = overlapMap.get(task.id) || { column: 0, totalColumns: 1 };
                  const widthPercent = 100 / overlap.totalColumns;
                  const leftPercent = overlap.column * widthPercent;
                  const active = activeAssignments(task);
                  const isUnderstaffed = active.length < task.requiredHeadcount;

                  return (
                    <div key={task.id} className="absolute rounded px-2 py-1 text-xs cursor-pointer overflow-hidden hover:opacity-90 transition-opacity z-10"
                      style={{
                        top: pos.top, height: pos.height,
                        left: `calc(${leftPercent}% + 4px)`, width: `calc(${widthPercent}% - 8px)`,
                        backgroundColor: `${color}20`, borderLeft: `3px solid ${color}`,
                        ...(isUnderstaffed ? { outline: "1.5px dashed #F59E0B", outlineOffset: "-1px" } : {}),
                      }}
                      onClick={() => setSelectedTask(selectedTask?.id === task.id ? null : task)}
                    >
                      <div className="font-medium truncate" style={{ color }}>{task.title}</div>
                      <div className="text-muted-foreground mt-0.5" style={{ fontSize: "10px" }}>
                        {new Date(task.scheduledStart!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} — {new Date(task.scheduledEnd!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      </div>
                      <div className="text-muted-foreground" style={{ fontSize: "10px" }}>
                        {active.map((a) => a.membership.user.name || "Unnamed").join(", ") || "No staff"} ({active.length}/{task.requiredHeadcount})
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Staff panel */}
          <div className="w-52 border rounded-r-lg rounded-l-none p-3 bg-card space-y-2 overflow-y-auto" style={{ maxHeight: `${totalHours * 48 + 2}px` }}>
            <p className="text-sm font-medium">Staff — {DAYS[dow]}</p>

            {dayStaff.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4">No staff data</p>
            ) : (
              dayStaff.map((staff) => (
                <div key={staff.membershipId} className={`rounded-md p-2 text-xs ${staff.isAvailable ? "bg-green-50 dark:bg-green-950" : "bg-muted/50"}`}>
                  <p className="font-medium text-foreground">{staff.name}</p>
                  {staff.isAvailable ? (
                    <p className="text-green-700 dark:text-green-300">{staff.availableHours}</p>
                  ) : (
                    <p className="text-muted-foreground">Off today</p>
                  )}
                  {staff.assignedTasks.length > 0 ? (
                    <p className="text-muted-foreground mt-0.5">
                      Assigned: {staff.assignedTasks.join(", ")}
                    </p>
                  ) : staff.isAvailable ? (
                    <p className="text-blue-600 dark:text-blue-400 mt-0.5">
                      Available — unassigned
                    </p>
                  ) : null}
                </div>
              ))
            )}

            {dayTasks.some((t) => activeAssignments(t).length < t.requiredHeadcount) && (
              <div className="border-t pt-2 mt-2 space-y-1.5">
                {dayTasks.filter((t) => activeAssignments(t).length < t.requiredHeadcount).map((t) => {
                  const activeCount = activeAssignments(t).length;
                  return (
                  <div key={t.id} className="flex items-start justify-between gap-1">
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {t.title} needs {t.requiredHeadcount - activeCount} more
                    </p>
                    <button
                      onClick={() => setAssignTask({
                        id: t.id,
                        title: t.title,
                        requiredHeadcount: t.requiredHeadcount,
                        currentCount: activeCount,
                      })}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                    >
                      Assign
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

  // ===== WEEK VIEW =====
  const weekTasks = getScheduledTasks(weekStart, weekEnd);

  return (
    <div className="max-w-6xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-2xl font-bold">Calendar</h2>
        <div className="flex items-center gap-2">
          <Button variant={showCoverage ? "default" : "outline"} size="sm" onClick={() => setShowCoverage(!showCoverage)}>
            {showCoverage ? "Coverage" : "Tasks only"}
          </Button>
          <Button variant="outline" size="sm" onClick={prevWeek}>← Prev</Button>
          <Button variant="outline" size="sm" onClick={goToday}>Today</Button>
          <Button variant="outline" size="sm" onClick={nextWeek}>Next →</Button>
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{formatDate(weekDates[0])} — {formatDate(weekDates[6])}</p>
        <div className="flex items-center gap-3">
          {unscheduledCount > 0 && (
            <span className="rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
              {unscheduledCount} unscheduled
            </span>
          )}
          <select className="rounded-md border px-3 py-1.5 text-sm bg-background" value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((dept) => (<option key={dept.id} value={dept.id}>{dept.name}</option>))}
          </select>
        </div>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      <div className="rounded-lg border overflow-hidden">
        {/* Day headers — clickable for day view */}
        <div className="grid border-b bg-muted/30" style={{ gridTemplateColumns: `50px repeat(7, 1fr)` }}>
          <div className="p-2 text-xs text-muted-foreground border-r" />
          {weekDates.map((date, i) => (
            <div key={i} className={`p-2 text-center text-sm border-r last:border-r-0 cursor-pointer hover:bg-accent/50 transition-colors ${date.toDateString() === todayStr ? "bg-blue-50 dark:bg-blue-950 font-semibold text-blue-700 dark:text-blue-300" : ""}`}
              onClick={() => openDayView(date)}>
              <div>{DAYS[date.getDay()]}</div>
              <div className="text-xs text-muted-foreground">{date.getDate()}</div>
            </div>
          ))}
        </div>

        <div className="grid" style={{ gridTemplateColumns: `50px repeat(7, 1fr)`, minHeight: `${totalHours * 40}px` }}>
          <div className="border-r">
            {HOURS.map((hour) => (
              <div key={hour} className="border-b text-xs text-muted-foreground px-2 flex items-start pt-1" style={{ height: `${100 / totalHours}%` }}>
                {formatHourLabel(hour)}
              </div>
            ))}
          </div>

          {weekDates.map((date, dayIndex) => {
            const dayTasks = getTasksForDay(date);
            const overlapMap = calculateOverlapColumns(dayTasks);
            const isToday = date.toDateString() === todayStr;
            const dow = date.getDay();

            return (
              <div key={dayIndex} className={`border-r last:border-r-0 relative ${isToday ? "bg-blue-50/30 dark:bg-blue-950/20" : ""}`}>
                {HOURS.map((hour) => {
                  const count = getCoverageCount(dow, hour);
                  return (
                    <div key={hour} className="border-b relative" style={{
                      height: `${100 / totalHours}%`,
                      backgroundColor: showCoverage && coverage.length > 0 ? getCoverageTint(count, isDark) : undefined,
                    }}>
                      {showCoverage && coverage.length > 0 && (
                        <span className="absolute bottom-0.5 right-1 text-[9px] text-muted-foreground/50 select-none">{count}</span>
                      )}
                    </div>
                  );
                })}

                {isToday && timePosition !== null && (
                  <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: `${timePosition}%` }}>
                    <div className="flex items-center">
                      <div className="h-2.5 w-2.5 rounded-full bg-red-500 -ml-1" />
                      <div className="flex-1 border-t-2 border-red-500" />
                    </div>
                  </div>
                )}

                {dayTasks.map((task) => {
                  const pos = getTaskPosition(task);
                  const color = task.department?.color || "#94A3B8";
                  const overlap = overlapMap.get(task.id) || { column: 0, totalColumns: 1 };
                  const widthPercent = 100 / overlap.totalColumns;
                  const leftPercent = overlap.column * widthPercent;
                  const activeCount = activeAssignments(task).length;
                  const isUnderstaffed = activeCount < task.requiredHeadcount;

                  return (
                    <div key={task.id} className="absolute rounded px-1 py-0.5 text-xs cursor-pointer overflow-hidden hover:opacity-90 transition-opacity z-10"
                      style={{
                        top: pos.top, height: pos.height,
                        left: `calc(${leftPercent}% + 2px)`, width: `calc(${widthPercent}% - 4px)`,
                        backgroundColor: `${color}20`, borderLeft: `3px solid ${color}`,
                        ...(isUnderstaffed ? { outline: "1.5px dashed #F59E0B", outlineOffset: "-1px" } : {}),
                      }}
                      onClick={() => setSelectedTask(selectedTask?.id === task.id ? null : task)}
                    >
                      <div className="font-medium truncate" style={{ color }}>{task.title}</div>
                      {parseFloat(pos.height) > 8 && (
                        <div className="truncate text-muted-foreground" style={{ fontSize: "10px" }}>{activeCount}/{task.requiredHeadcount} staff</div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-4 flex flex-wrap items-center gap-4">
        {departments.map((dept) => (
          <div key={dept.id} className="flex items-center gap-2 text-sm">
            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: dept.color || "#94A3B8" }} />
            <span className="text-muted-foreground">{dept.name}</span>
          </div>
        ))}
        {showCoverage && (
          <>
            <div className="h-4 border-l mx-1" />
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-3 w-3 rounded" style={{ backgroundColor: getCoverageTint(4, isDark) }} /> 4+
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-3 w-3 rounded" style={{ backgroundColor: getCoverageTint(2, isDark) }} /> 1-3
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-3 w-3 rounded" style={{ backgroundColor: getCoverageTint(0, isDark) }} /> None
            </div>
          </>
        )}
      </div>

      {selectedTask && <TaskDetailPanel task={selectedTask} onClose={() => setSelectedTask(null)} />}
    </div>
  );
}

function TaskDetailPanel({ task, onClose }: { task: Task; onClose: () => void }) {
  return (
    <Card className="mt-4">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            {task.department && <div className="h-3 w-3 rounded-full" style={{ backgroundColor: task.department.color || "#94A3B8" }} />}
            {task.title}
          </CardTitle>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-sm"><span className="text-muted-foreground">Department: </span>{task.department?.name || "None"}</div>
        <div className="text-sm"><span className="text-muted-foreground">Status: </span>{task.status}</div>
        <div className="text-sm"><span className="text-muted-foreground">Priority: </span>{task.priority}</div>
        <div className="text-sm">
          <span className="text-muted-foreground">Schedule: </span>
          {task.scheduledStart && new Date(task.scheduledStart).toLocaleString()}
          {task.scheduledEnd && ` — ${new Date(task.scheduledEnd).toLocaleString()}`}
        </div>
        <div className="text-sm">
          <span className="text-muted-foreground">Staff: </span>
          {activeAssignments(task).length}/{task.requiredHeadcount}
          {task.assignments.length > 0 && (
            <span>{" — "}{task.assignments.map((a) => `${a.membership.user.name || "Unnamed"} (${a.status})`).join(", ")}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
