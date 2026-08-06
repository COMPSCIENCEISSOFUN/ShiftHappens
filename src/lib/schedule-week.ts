/**
 * Week selection for the auto-scheduler.
 *
 * The auto-schedule page works in whole weeks identified by a plain
 * `YYYY-MM-DD` Monday, because that is what an `<input type="date">` gives and
 * takes. Turning that string back into a date is where this kind of code
 * usually goes wrong, so both directions live here and are tested.
 */
import { dayOfWeekInTimeZone, localDateInTimeZone } from "@/lib/timezone";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Adds whole days to a local calendar date.
 *
 * `setDate` rather than adding milliseconds: a day is not always 24 hours. In a
 * zone that observes daylight saving, adding 7 × 24h to a local midnight lands
 * on 23:00 the previous day or 01:00 the next, and reading `getDate()` off that
 * is wrong by one for the two weeks a year that straddle a transition.
 * Singapore has no DST, but the browser's zone is the user's, not the
 * organisation's, and this is displayed to them.
 */
function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** A local calendar date as `YYYY-MM-DD`. */
function formatDateOnly(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The current week's Monday as `YYYY-MM-DD` in organisation time.
 *
 * An earlier version used `getDay()` + `setHours(0,0,0,0)` and then
 * `toISOString().split("T")[0]`. Those two disagree: `setHours` works in the
 * runtime's local zone while `toISOString` renders UTC, so local midnight east
 * of UTC serialises as the PREVIOUS day. Running in Asia/Singapore it returned
 * the Sunday, shifting the whole scheduling window by a day — silently dropping
 * the final Monday's tasks and pulling in the previous Sunday's.
 */
export function thisMondayInOrgTime(now: Date = new Date()): string {
  const weekday = dayOfWeekInTimeZone(now);
  const diff = weekday === 0 ? -6 : 1 - weekday;
  return localDateInTimeZone(new Date(now.getTime() + diff * DAY_MS));
}

/**
 * Parses `YYYY-MM-DD` as a LOCAL calendar date.
 *
 * `new Date("2026-08-03")` is not this: the ISO date-only form is defined to
 * parse as UTC midnight, so rendering it with `toLocaleDateString` in any zone
 * behind UTC shows the previous day. The date the user picked in the date input
 * would then be displayed back to them as a different date, on the same screen.
 *
 * Passing the parts to the `Date` constructor separately parses as local time,
 * which is what a bare calendar date means to the person reading it.
 */
export function parseDateOnly(dateStr: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));

  // Rejects impossible dates that the constructor silently rolls over, such as
  // "2026-02-30" becoming 2 March. An out-of-range week would otherwise be sent
  // to the scheduler as though it were deliberate.
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null;
  }

  return date;
}

/**
 * "Aug 3 — Aug 9, 2026" for the seven days beginning at `dateStr`.
 *
 * Returns an empty string for anything unparseable, so a half-typed date in the
 * input renders as nothing rather than as "Invalid Date".
 */
export function weekRangeLabel(dateStr: string): string {
  const start = parseDateOnly(dateStr);
  if (!start) return "";

  const end = addDays(start, 6);

  return (
    `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} — ` +
    `${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
  );
}

/** True when `dateStr` names a Monday. */
export function isMonday(dateStr: string): boolean {
  const date = parseDateOnly(dateStr);
  return date ? date.getDay() === 1 : false;
}

/** The Monday of the week containing `dateStr`, or the input if unparseable. */
export function mondayOf(dateStr: string): string {
  const date = parseDateOnly(dateStr);
  if (!date) return dateStr;

  const weekday = date.getDay();
  const diff = weekday === 0 ? -6 : 1 - weekday;
  return formatDateOnly(addDays(date, diff));
}

/**
 * The weekday a `YYYY-MM-DD` falls on — "Wednesday" — or null if unparseable.
 *
 * Here rather than in the page because it needs `parseDateOnly`: the bare ISO
 * form parses as UTC midnight, so naming the day with `new Date(dateStr)` gets
 * it wrong by one for every zone behind UTC. That is the trap this whole module
 * exists to keep in one place.
 */
export function weekdayName(dateStr: string): string | null {
  const date = parseDateOnly(dateStr);
  return date ? date.toLocaleDateString("en-US", { weekday: "long" }) : null;
}

/** A `YYYY-MM-DD` as "Mon 3 Aug", or null if unparseable. */
export function shortDateLabel(dateStr: string): string | null {
  const date = parseDateOnly(dateStr);
  if (!date) return null;
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Shifts a `YYYY-MM-DD` by whole weeks, preserving the local calendar date. */
export function shiftWeeks(dateStr: string, weeks: number): string {
  const date = parseDateOnly(dateStr);
  if (!date) return dateStr;

  return formatDateOnly(addDays(date, weeks * 7));
}
