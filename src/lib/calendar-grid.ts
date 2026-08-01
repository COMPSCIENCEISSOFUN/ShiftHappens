/**
 * Geometry for the calendar's time grid.
 *
 * This is deliberately separate from the calendar page. The arithmetic here is
 * where the rendering bugs lived, and while it sat inline in JSX it could not
 * be tested at all — the project has no component-render harness, so anything
 * expressed as markup is verified only by looking at it.
 *
 * ## The model
 *
 * A column represents one BUSINESS DAY, which begins at the organisation's
 * `operatingHoursStart` rather than at midnight (see `@/lib/business-day`).
 * Rows are offsets from that boundary, not clock hours.
 *
 * The operating window is a DEFAULT VIEWPORT, not a clip: the grid grows to
 * cover any scheduled work that falls outside it. A calendar that silently
 * omits a shift is worse than one that looks untidy, and the previous
 * behaviour did exactly that — a 22:00–06:00 shift produced a NEGATIVE height
 * (`endHour - startHour` = 6 − 22), was clamped to a 2% sliver, and was pinned
 * to the bottom edge of the grid.
 *
 * A shift crossing the boundary is not split into two records. It appears in
 * each column it touches, clipped to that column, with flags saying which
 * edges it runs through — so it can be drawn as one shift continuing rather
 * than two unrelated ones.
 */
import { businessDayRange } from "@/lib/business-day";

const HOUR_MS = 60 * 60 * 1000;

/** The minimum a caller needs to place a task; matches the page's Task type. */
export interface SchedulableTask {
  scheduledStart: string | Date | null;
  scheduledEnd: string | Date | null;
}

export interface TaskBlock {
  /** Percentage from the top of the column. */
  topPercent: number;
  /** Percentage of the column's height. */
  heightPercent: number;
  /** The task began before this column — draw a squared top edge. */
  continuesBefore: boolean;
  /** The task runs past this column — draw a squared bottom edge. */
  continuesAfter: boolean;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * How many hours the grid must span so that every scheduled shift on the given
 * days is visible.
 *
 * Never fewer than the operating window — an empty week still shows the hours
 * the organisation is open — and never more than 24, because a task longer than
 * a business day continues into the next column rather than stretching this
 * one.
 */
export function gridHoursFor(
  dates: Date[],
  tasks: SchedulableTask[],
  dayStartHour: number,
  windowHours: number
): number {
  let needed = windowHours;

  for (const date of dates) {
    const { start, end } = businessDayRange(date, dayStartHour);

    for (const task of tasks) {
      if (!task.scheduledStart || !task.scheduledEnd) continue;
      const taskStart = toDate(task.scheduledStart);
      const taskEnd = toDate(task.scheduledEnd);
      if (taskStart >= end || taskEnd <= start) continue;

      const endOffset =
        (Math.min(taskEnd.getTime(), end.getTime()) - start.getTime()) / HOUR_MS;
      needed = Math.max(needed, Math.ceil(endOffset));
    }
  }

  return Math.min(24, Math.max(1, needed));
}

/**
 * One row per hour of the grid.
 *
 * `dayOffset` is 1 once the row has crossed midnight into the next calendar
 * day. Anything keyed by weekday — the coverage heat map — must add it, or a
 * 02:00 row in Friday's column reads Friday's coverage when the work is
 * Saturday's.
 */
export function gridRows(
  dayStartHour: number,
  gridHours: number
): { index: number; clockHour: number; dayOffset: number }[] {
  return Array.from({ length: gridHours }, (_, i) => ({
    index: i,
    clockHour: (dayStartHour + i) % 24,
    dayOffset: Math.floor((dayStartHour + i) / 24),
  }));
}

/**
 * Where a task sits within one day's column, clipped to it, or null when the
 * task does not appear in that column at all.
 *
 * Null rather than a zero-height block: the caller renders nothing, instead of
 * an invisible element that still occupies a slot in the overlap layout.
 */
export function taskBlockPosition(
  task: SchedulableTask,
  date: Date,
  dayStartHour: number,
  gridHours: number
): TaskBlock | null {
  if (!task.scheduledStart || !task.scheduledEnd) return null;

  const { start: dayStart } = businessDayRange(date, dayStartHour);
  const gridEndMs = dayStart.getTime() + gridHours * HOUR_MS;

  const taskStartMs = toDate(task.scheduledStart).getTime();
  const taskEndMs = toDate(task.scheduledEnd).getTime();
  if (Number.isNaN(taskStartMs) || Number.isNaN(taskEndMs)) return null;

  const from = Math.max(taskStartMs, dayStart.getTime());
  const to = Math.min(taskEndMs, gridEndMs);
  if (to <= from) return null;

  return {
    topPercent: ((from - dayStart.getTime()) / HOUR_MS / gridHours) * 100,
    heightPercent: ((to - from) / HOUR_MS / gridHours) * 100,
    continuesBefore: taskStartMs < from,
    continuesAfter: taskEndMs > to,
  };
}

/**
 * Position of the now-line as a percentage down the column, or null when the
 * current time falls outside the visible grid.
 */
export function currentTimePosition(
  now: Date,
  dayStartHour: number,
  gridHours: number
): number | null {
  const { start } = businessDayRange(now, dayStartHour);
  const offset = (now.getTime() - start.getTime()) / HOUR_MS;
  if (offset < 0 || offset >= gridHours) return null;
  return (offset / gridHours) * 100;
}
