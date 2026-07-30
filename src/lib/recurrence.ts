/**
 * Recurrence engine (shared by the recurring-task generator and the task UI).
 *
 * A recurring task is the FIRST occurrence of a series and stores its pattern
 * as JSON in `Task.recurringPattern`. Later occurrences are generated as
 * ordinary tasks pointing back at it via `Task.parentTaskId`.
 *
 * Pattern shape (JSON):
 *   { "freq": "daily",   "interval": 1, "until": "2026-09-01" }
 *   { "freq": "weekly",  "interval": 1, "days": [1,3,5], "until": "2026-09-01" }
 *   { "freq": "monthly", "interval": 1, "dayOfMonth": 15 }
 *
 * - interval: repeat every N days/weeks/months (defaults to 1)
 * - days: weekly only — 0=Sunday … 6=Saturday. Defaults to the start's weekday.
 * - dayOfMonth: monthly only — 1..31. Defaults to the start's day of month.
 *   Months without that day (e.g. the 31st in February) are simply skipped.
 * - until: inclusive end date. Omitted means "no end" — generation is still
 *   bounded by the caller's horizon, so this never runs away.
 *
 * Occurrences preserve the start's time-of-day and the original duration.
 */

import {
  dayOfWeekInTimeZone,
  endOfDayInTimeZone,
  localDateInTimeZone,
  startOfDayInTimeZone,
} from "@/lib/timezone";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RECURRENCE_FREQS = ["daily", "weekly", "monthly"] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];

export interface RecurrencePattern {
  freq: RecurrenceFreq;
  interval: number;
  days?: number[];
  dayOfMonth?: number;
  until?: string;
}

export interface Occurrence {
  start: Date;
  end: Date;
}

/** Safety valve so a malformed pattern can never spin forever. */
const MAX_OCCURRENCES = 500;

/**
 * Parses and validates a stored pattern string.
 * Returns null for anything malformed — callers treat that as "not recurring".
 */
export function parseRecurrencePattern(
  raw: string | null | undefined
): RecurrencePattern | null {
  if (!raw) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;

  const p = data as Record<string, unknown>;

  const freq = p.freq;
  if (!RECURRENCE_FREQS.includes(freq as RecurrenceFreq)) return null;

  const interval =
    typeof p.interval === "number" && Number.isInteger(p.interval) && p.interval >= 1
      ? p.interval
      : 1;

  const pattern: RecurrencePattern = { freq: freq as RecurrenceFreq, interval };

  if (freq === "weekly" && Array.isArray(p.days)) {
    const days = p.days.filter(
      (d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6
    );
    if (days.length > 0) pattern.days = Array.from(new Set(days)).sort((a, b) => a - b);
  }

  if (freq === "monthly" && typeof p.dayOfMonth === "number") {
    const dom = p.dayOfMonth;
    if (Number.isInteger(dom) && dom >= 1 && dom <= 31) pattern.dayOfMonth = dom;
  }

  if (typeof p.until === "string" && !Number.isNaN(Date.parse(p.until))) {
    pattern.until = p.until;
  }

  return pattern;
}

export function serializeRecurrencePattern(pattern: RecurrencePattern): string {
  return JSON.stringify(pattern);
}

/**
 * Copies the time-of-day from `timeSource` onto the day containing `date`,
 * measured in the organisation's timezone.
 *
 * Expressed as "milliseconds since that day began locally" rather than via
 * setHours(), which applies the SERVER's clock. A 09:00 Singapore series must
 * generate 09:00 Singapore occurrences whether it runs on a laptop here or in
 * a UTC function.
 */
function atTimeOf(date: Date, timeSource: Date): Date {
  const msIntoDay =
    timeSource.getTime() - startOfDayInTimeZone(timeSource).getTime();
  return new Date(startOfDayInTimeZone(date).getTime() + msIntoDay);
}

/**
 * Computes every occurrence of `pattern` that starts within [from, to].
 *
 * `baseStart`/`baseEnd` are the first occurrence's schedule — they define the
 * time-of-day, the duration, and the anchor the series counts from. Occurrences
 * never precede baseStart, and never pass the pattern's `until` date.
 */
export function occurrencesBetween(
  pattern: RecurrencePattern,
  baseStart: Date,
  baseEnd: Date,
  from: Date,
  to: Date
): Occurrence[] {
  const durationMs = Math.max(0, baseEnd.getTime() - baseStart.getTime());
  const interval = Math.max(1, pattern.interval || 1);

  // The window closes at whichever comes first: the caller's horizon or `until`.
  let hardEnd = to;
  if (pattern.until) {
    // The last instant of the `until` day in the organisation's timezone.
    // setHours(23,59,59,999) closes the window at the SERVER's midnight, which
    // on Vercel is 08:00 the next morning in Singapore — quietly admitting an
    // extra occurrence the user never asked for.
    const until = new Date(
      endOfDayInTimeZone(new Date(pattern.until)).getTime() - 1
    );
    if (until < hardEnd) hardEnd = until;
  }

  const results: Occurrence[] = [];
  const add = (start: Date) => {
    if (start < baseStart || start > hardEnd || start < from) return;
    results.push({ start, end: new Date(start.getTime() + durationMs) });
  };

  if (pattern.freq === "daily") {
    // Whole-day steps from the anchor. Equivalent to setDate() in a fixed-offset
    // zone, but stated in terms that do not consult the server clock at all.
    let cursor = new Date(baseStart);
    for (let i = 0; i < MAX_OCCURRENCES && cursor <= hardEnd; i++) {
      add(new Date(cursor));
      cursor = new Date(cursor.getTime() + interval * DAY_MS);
    }
  } else if (pattern.freq === "weekly") {
    // The weekday the user picked is their LOCAL one. Read off the server clock,
    // a 01:00 Singapore shift reports the previous day and the whole series
    // generates a day early.
    const days =
      pattern.days && pattern.days.length > 0
        ? pattern.days
        : [dayOfWeekInTimeZone(baseStart)];

    // Anchor on the Sunday of baseStart's week, in organisation time, then step
    // whole weeks. Adding whole days to a local midnight is exact for a
    // fixed-offset zone such as Asia/Singapore.
    let weekCursor = new Date(
      startOfDayInTimeZone(baseStart).getTime() -
        dayOfWeekInTimeZone(baseStart) * DAY_MS
    );

    let guard = 0;
    while (weekCursor <= hardEnd && guard < MAX_OCCURRENCES) {
      for (const dow of days) {
        const day = new Date(weekCursor.getTime() + dow * DAY_MS);
        add(atTimeOf(day, baseStart));
        guard++;
      }
      weekCursor = new Date(weekCursor.getTime() + 7 * interval * DAY_MS);
    }
  } else {
    // monthly
    // Day-of-month and the starting month come from the organisation's calendar,
    // not the server's — they disagree for any shift between midnight and 08:00
    // Singapore time.
    const [baseYear, baseMonth, baseDay] = localDateInTimeZone(baseStart)
      .split("-")
      .map(Number);
    const dayOfMonth = pattern.dayOfMonth ?? baseDay;
    // Noon UTC anchors a calendar date unambiguously for any offset within 12h.
    const monthCursor = new Date(Date.UTC(baseYear, baseMonth - 1, 1, 12));

    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const year = monthCursor.getUTCFullYear();
      const month = monthCursor.getUTCMonth();

      // Day 0 of the next month == last day of this one.
      const daysInMonth = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
      if (dayOfMonth <= daysInMonth) {
        add(atTimeOf(new Date(Date.UTC(year, month, dayOfMonth, 12)), baseStart));
      }

      monthCursor.setUTCMonth(monthCursor.getUTCMonth() + interval);
      if (new Date(Date.UTC(year, month, 1, 12)) > hardEnd) break;
      if (monthCursor > hardEnd) break;
    }
  }

  return results.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Human-readable summary, e.g. "Every 2 weeks on Mon, Wed until 1 Sep 2026". */
export function describeRecurrence(pattern: RecurrencePattern): string {
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const every =
    pattern.interval > 1 ? `Every ${pattern.interval} ` : "Every ";

  let base: string;
  if (pattern.freq === "daily") {
    base = `${every}${pattern.interval > 1 ? "days" : "day"}`;
  } else if (pattern.freq === "weekly") {
    const days = pattern.days?.length
      ? ` on ${pattern.days.map((d) => DAY_NAMES[d]).join(", ")}`
      : "";
    base = `${every}${pattern.interval > 1 ? "weeks" : "week"}${days}`;
  } else {
    const dom = pattern.dayOfMonth ? ` on day ${pattern.dayOfMonth}` : "";
    base = `${every}${pattern.interval > 1 ? "months" : "month"}${dom}`;
  }

  if (pattern.until) {
    const until = new Date(pattern.until);
    if (!Number.isNaN(until.getTime())) {
      base += ` until ${until.toLocaleDateString()}`;
    }
  }
  return base;
}
