/**
 * My Schedule (Boundary Layer)
 *
 * The member's own shifts, drawn as a week rather than listed.
 *
 * ## Why a second view of data My Tasks already shows
 *
 * A list answers "what am I on next". A grid answers "what does my week look
 * like" — where the gaps are, whether two shifts are back to back, whether
 * Thursday is free — and no amount of sorting a list produces that. The team
 * calendar has always drawn exactly this picture for managers; the people
 * actually working the shifts had no equivalent.
 *
 * ## Why it needs no permission
 *
 * This is the member's own data, and the catalogue deliberately holds no
 * permission for seeing your own: twelve such entries were retired precisely
 * because switching one off produces a broken member rather than a restricted
 * one. The gate is `canBeRostered` in the sidebar — a structural fact about who
 * can hold a shift, not an authority question.
 *
 * ## The endpoint this must NOT use
 *
 * `GET /tasks` requires `TASK_LIST_READERS` because a plain member typing that
 * URL used to receive the whole organisation's task board. This page reads
 * `/my-tasks`, which is scoped to the caller's own assignments by the service
 * and takes no membership id from the request. Widening the org endpoint to
 * populate a personal screen would trade a permission boundary for a
 * convenience, which is the exact swap the scoping audit was undoing.
 *
 * Operating hours come from `/settings/display`, the member-scoped read that
 * exists because the admin-only settings GET returned 403 to everybody else and
 * the calendar silently fell back to a hard-coded 6am–10pm — same organisation,
 * same page, different grid, no error.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";
import {
  gridHoursFor,
  gridRows,
  taskBlockPosition,
  currentTimePosition,
} from "@/lib/calendar-grid";
import { businessDayRangeStartingOn, formatHour } from "@/lib/business-day";
import { occupiesSlot } from "@/lib/assignment-status";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Assignment {
  id: string;
  status: string;
  task: {
    id: string;
    title: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    department: { name: string } | null;
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The Monday of the week `date` falls in, at midnight. */
function mondayOf(date: Date): Date {
  const monday = new Date(date);
  // getDay() is 0 for Sunday, so Sunday belongs to the week that is ENDING.
  const shift = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - shift);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * How a shift is drawn, from its assignment status.
 *
 * Three states, not eight. A member looking at their own week is asking one
 * question — is this settled or does it want something from me — and colouring
 * by every lifecycle status would answer a question nobody asked while making
 * the grid unreadable.
 *
 * `withdrawal_requested` and `decline_requested` are shown as unsettled rather
 * than removed: the member is still rostered until a manager decides, and a
 * shift vanishing from the calendar the moment they ask to drop it would say
 * they are off when they are not.
 */
function blockTone(status: string): { className: string; label: string } {
  if (status === "completed" || status === "clocked_out") {
    return {
      className:
        "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
      label: "worked",
    };
  }
  if (status === "accepted") {
    return {
      className:
        "border-indigo-300 bg-indigo-100 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-200",
      label: "confirmed",
    };
  }
  return {
    className:
      "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-200",
    label: "needs an answer",
  };
}

function timeRange(start: string, end: string | null): string {
  const from = new Date(start).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (!end) return from;
  const to = new Date(end).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${from} – ${to}`;
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function MySchedulePage() {
  const params = useParams();
  const orgId = params.orgId as string;

  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [dayStartHour, setDayStartHour] = useState(6);
  const [windowHours, setWindowHours] = useState(16);
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /*
   * Stamped once on mount rather than read during render. `new Date()` inside
   * the body makes the now-line move on every unrelated re-render and makes the
   * component untestable without freezing the clock.
   */
  const [now] = useState(() => new Date());

  const load = useCallback(async () => {
    try {
      const [tasksRes, displayRes] = await Promise.all([
        fetch(`/api/organizations/${orgId}/my-tasks`),
        fetch(`/api/organizations/${orgId}/settings/display`),
      ]);

      const tasksBody = await tasksRes.json();
      if (!tasksRes.ok || !Array.isArray(tasksBody)) {
        setError(
          typeof tasksBody?.error === "string"
            ? tasksBody.error
            : "Could not load your shifts"
        );
        setAssignments([]);
        return;
      }
      setAssignments(tasksBody);
      setError(null);

      /*
       * Operating hours are a nicety, so a failure here is not an error the
       * member needs to see — the grid falls back to the defaults and still
       * shows every shift, because `gridHoursFor` grows it to cover whatever is
       * scheduled regardless of the window.
       */
      if (displayRes.ok) {
        const display = await displayRes.json();
        if (typeof display?.operatingHoursStart === "number") {
          setDayStartHour(display.operatingHoursStart);
        }
        if (
          typeof display?.operatingHoursStart === "number" &&
          typeof display?.operatingHoursEnd === "number"
        ) {
          const span =
            (display.operatingHoursEnd - display.operatingHoursStart + 24) % 24;
          setWindowHours(span === 0 ? 24 : span);
        }
      }
    } catch {
      setError("Could not load your shifts");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads the member's own assignments and the organisation's display settings
    load();
  }, [load]);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  /*
   * Only shifts the member still holds.
   *
   * `occupiesSlot` is the shared rule — a slot is given back only by `rejected`
   * and `withdrawn` — so a shift they turned down disappears while one they
   * have merely asked to leave stays. Writing the status list here instead
   * would be the eighth copy of a rule that has already disagreed with itself
   * three times.
   */
  const mine = useMemo(
    () =>
      assignments.filter(
        (a) =>
          occupiesSlot(a.status) &&
          a.task.scheduledStart !== null &&
          a.task.scheduledEnd !== null
      ),
    [assignments]
  );

  const tasks = useMemo(() => mine.map((a) => a.task), [mine]);
  const gridHours = useMemo(
    () => gridHoursFor(days, tasks, dayStartHour, windowHours),
    [days, tasks, dayStartHour, windowHours]
  );
  const rows = useMemo(
    () => gridRows(dayStartHour, gridHours),
    [dayStartHour, gridHours]
  );

  const inThisWeek = useMemo(() => {
    // Columns, so the week runs from the business day Monday is HEADED with to
    // the end of Sunday's — not from the day containing Monday's midnight,
    // which with a 07:00 boundary is the Sunday before.
    const { start } = businessDayRangeStartingOn(days[0], dayStartHour);
    const { end } = businessDayRangeStartingOn(days[6], dayStartHour);
    return mine.filter((a) => {
      const from = new Date(a.task.scheduledStart as string).getTime();
      const to = new Date(a.task.scheduledEnd as string).getTime();
      return to > start.getTime() && from < end.getTime();
    });
  }, [mine, days, dayStartHour]);

  const weekHours = useMemo(
    () =>
      inThisWeek.reduce((sum, a) => {
        const from = new Date(a.task.scheduledStart as string).getTime();
        const to = new Date(a.task.scheduledEnd as string).getTime();
        return sum + Math.max(0, to - from) / 3_600_000;
      }, 0),
    [inThisWeek]
  );

  if (loading) return <PageLoading />;

  const rangeLabel = `${days[0].toLocaleDateString([], {
    day: "numeric",
    month: "short",
  })} – ${days[6].toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
            My Schedule
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {rangeLabel} &middot; {inThisWeek.length} shift
            {inThisWeek.length === 1 ? "" : "s"}
            {inThisWeek.length > 0 && (
              <> &middot; {weekHours.toFixed(weekHours % 1 === 0 ? 0 : 1)}h</>
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            onClick={() => setWeekStart((w) => addDays(w, -7))}
            className={SECONDARY_BUTTON}
            aria-label="Previous week"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={() => setWeekStart(mondayOf(new Date()))}
            className={SECONDARY_BUTTON}
          >
            This week
          </button>
          <button
            onClick={() => setWeekStart((w) => addDays(w, 7))}
            className={SECONDARY_BUTTON}
            aria-label="Next week"
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {/*
        Two different empty states.

        "Nothing this week" is navigational — the member moves to another week.
        "Nothing at all" is a different fact and a different feeling, and
        offering the same message for both would send somebody clicking through
        empty weeks looking for shifts they have never had.
      */}
      {!error && mine.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No shifts yet"
          description="Once you are rostered onto a shift it will appear here, and on My Tasks."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {/* ── Day headings ── */}
          <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))] border-b border-border">
            <div className="border-r border-border" />
            {days.map((day, i) => {
              const isToday = day.toDateString() === now.toDateString();
              return (
                <div
                  key={day.toISOString()}
                  className={`border-r border-border px-1 py-2 text-center last:border-r-0 ${
                    isToday ? "bg-indigo-50 dark:bg-indigo-950/40" : ""
                  }`}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {DAY_LABELS[i]}
                  </p>
                  <p
                    className={`text-[13px] ${
                      isToday ? "font-bold text-indigo-600 dark:text-indigo-300" : ""
                    }`}
                  >
                    {day.getDate()}
                  </p>
                </div>
              );
            })}
          </div>

          {/* ── Grid ── */}
          <div className="grid grid-cols-[3rem_repeat(7,minmax(0,1fr))]">
            {/* Hour gutter */}
            <div className="border-r border-border">
              {rows.map((row) => (
                <div
                  key={row.index}
                  className="h-12 border-b border-border/60 px-1 text-right text-[10px] tabular-nums text-muted-foreground last:border-b-0"
                >
                  {formatHour(row.clockHour)}
                </div>
              ))}
            </div>

            {days.map((day) => {
              const isToday = day.toDateString() === now.toDateString();
              const nowPercent = isToday
                ? currentTimePosition(now, dayStartHour, gridHours)
                : null;

              return (
                <div
                  key={day.toISOString()}
                  className="relative border-r border-border last:border-r-0"
                >
                  {rows.map((row) => (
                    <div
                      key={row.index}
                      className="h-12 border-b border-border/60 last:border-b-0"
                    />
                  ))}

                  {/*
                    The now-line, drawn only on today's column. A line on every
                    column would read as a scheduled event.
                  */}
                  {nowPercent !== null && (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500"
                      style={{ top: `${nowPercent}%` }}
                      aria-hidden="true"
                    />
                  )}

                  {mine.map((assignment) => {
                    const block = taskBlockPosition(
                      assignment.task,
                      day,
                      dayStartHour,
                      gridHours
                    );
                    if (!block) return null;

                    const tone = blockTone(assignment.status);
                    return (
                      <div
                        key={`${assignment.id}-${day.toISOString()}`}
                        /*
                          Squared edges where a shift crosses a column boundary,
                          so an overnight shift reads as one thing split in two
                          rather than two unrelated ones.
                        */
                        className={`absolute inset-x-0.5 z-[5] overflow-hidden border px-1 py-0.5 text-[10px] leading-tight ${tone.className} ${
                          block.continuesBefore ? "rounded-t-none" : "rounded-t"
                        } ${block.continuesAfter ? "rounded-b-none" : "rounded-b"}`}
                        style={{
                          top: `${block.topPercent}%`,
                          height: `${block.heightPercent}%`,
                        }}
                        title={`${assignment.task.title} — ${timeRange(
                          assignment.task.scheduledStart as string,
                          assignment.task.scheduledEnd
                        )} (${tone.label})`}
                      >
                        {block.continuesBefore && <span aria-hidden="true">↑ </span>}
                        <span className="font-semibold">
                          {assignment.task.title}
                        </span>
                        {block.heightPercent > 6 && (
                          <span className="block truncate opacity-80">
                            {timeRange(
                              assignment.task.scheduledStart as string,
                              assignment.task.scheduledEnd
                            )}
                          </span>
                        )}
                        {block.continuesAfter && <span aria-hidden="true"> ↓</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Legend ── */}
      {!error && mine.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          {["accepted", "pending", "completed"].map((status) => {
            const tone = blockTone(status);
            return (
              <span key={status} className="inline-flex items-center gap-1.5">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-sm border ${tone.className}`}
                  aria-hidden="true"
                />
                {tone.label}
              </span>
            );
          })}
          <span>
            Shifts you have turned down are not shown. Accept or decline from My
            Tasks.
          </span>
        </div>
      )}
    </div>
  );
}
