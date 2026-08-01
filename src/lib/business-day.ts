/**
 * Business days and operating windows.
 *
 * ## The problem this solves
 *
 * A calendar day runs midnight to midnight. An operational day usually does
 * not. A restaurant's Friday ends when the kitchen closes at 2am on Saturday;
 * a cleaning contractor's day might start at 8pm. Judging "hours worked that
 * day" against midnight boundaries splits a single shift across two days and
 * makes a daily cap fire on work nobody thinks of as belonging to that day.
 *
 * `CompanySettings.operatingHoursStart` is therefore treated as the
 * organisation's DAY BOUNDARY as well as the start of its opening window. This
 * is the same design used by hospitality workforce products (Restaurant365
 * calls it "start of day"), and it collapses two settings into one: move the
 * boundary and overnight shifts stop crossing it, rather than needing to be
 * split and reattributed.
 *
 * Two distinct spans follow from the pair of settings, and confusing them is
 * the easy mistake:
 *
 *   - The BUSINESS DAY is always exactly 24 hours, `[start, start + 24h)`.
 *     It is what hours are attributed to.
 *   - The OPERATING WINDOW is the open period inside it, from
 *     `operatingHoursStart` to `operatingHoursEnd`. It may be shorter than the
 *     business day, and it may wrap past midnight. It is what the calendar
 *     draws by default.
 *
 * When the window is 24 hours the two coincide.
 *
 * ## Why the window may wrap
 *
 * `operatingHoursEnd` used to be required to be greater than
 * `operatingHoursStart`, which made a night-time operation inexpressible: a
 * business open 20:00–04:00 could not enter its own hours. Any pair is now
 * legal and `end <= start` means the window runs past midnight.
 */
import {
  DEFAULT_TIMEZONE,
  startOfDayInTimeZone,
} from "@/lib/timezone";

const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Midnight — the boundary an organisation gets when it has expressed no
 * preference, and the value every hour helper defaults to so that existing
 * behaviour is unchanged unless a caller opts in.
 */
export const DEFAULT_DAY_START_HOUR = 0;

/**
 * Length of the operating window in hours, honouring a wrap past midnight.
 *
 * `start === end` means twenty-four hours, not zero: an organisation that
 * opens and closes at the same hour is open around the clock. A zero-length
 * window is not expressible, and should not be — an organisation open for no
 * hours at all cannot schedule anything, so it would only ever be a data-entry
 * mistake that silently emptied the calendar.
 */
export function operatingWindowHours(startHour: number, endHour: number): number {
  const span = (((endHour - startHour) % 24) + 24) % 24;
  return span === 0 ? 24 : span;
}

/** True when the operating window runs past midnight into the next day. */
export function windowWrapsMidnight(startHour: number, endHour: number): boolean {
  return operatingWindowHours(startHour, endHour) > 24 - startHour;
}

/**
 * The instant at which the business day CONTAINING `date` begins.
 *
 * Note the containment: with a boundary of 06:00, an instant at 02:00 on
 * Tuesday belongs to Monday's business day, so this returns Monday 06:00. That
 * is the whole point — 2am work belongs to the night that produced it.
 */
export function businessDayStart(
  date: Date,
  dayStartHour: number = DEFAULT_DAY_START_HOUR,
  timeZone: string = DEFAULT_TIMEZONE
): Date {
  const candidate = new Date(
    startOfDayInTimeZone(date, timeZone).getTime() + dayStartHour * HOUR_MS
  );

  if (date.getTime() >= candidate.getTime()) return candidate;

  // Before today's boundary — so we are still inside yesterday's business day.
  // Recomputed from the previous calendar day rather than by subtracting 24
  // hours, so a timezone whose offset changes overnight still lands on the
  // correct local hour.
  return new Date(
    startOfDayInTimeZone(new Date(date.getTime() - DAY_MS), timeZone).getTime() +
      dayStartHour * HOUR_MS
  );
}

/**
 * The business day containing `date`, as a half-open interval `[start, end)`.
 * Always 24 hours: this is the attribution window, not the opening window.
 */
export function businessDayRange(
  date: Date,
  dayStartHour: number = DEFAULT_DAY_START_HOUR,
  timeZone: string = DEFAULT_TIMEZONE
): { start: Date; end: Date } {
  const start = businessDayStart(date, dayStartHour, timeZone);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * The business week containing `date`, as `[start, end)` — seven business days
 * beginning on Monday.
 *
 * The weekday is resolved from the business day's start rather than from
 * `date` itself. With a 06:00 boundary an instant at 02:00 on Monday belongs
 * to SUNDAY's business day, and therefore to the week that is ending, not the
 * one beginning — reading the weekday off the raw instant would file that
 * shift under the wrong week and let someone exceed a weekly cap by working
 * the small hours of Monday morning.
 */
export function businessWeekRange(
  date: Date,
  dayStartHour: number = DEFAULT_DAY_START_HOUR,
  timeZone: string = DEFAULT_TIMEZONE
): { start: Date; end: Date } {
  const dayStart = businessDayStart(date, dayStartHour, timeZone);

  // Weekday of the business day itself. Nudged an hour past the boundary before
  // reading the calendar date so that a boundary of 00:00 cannot land exactly
  // on midnight and resolve ambiguously.
  const probe = new Date(dayStart.getTime() + HOUR_MS);
  const weekday = new Date(
    startOfDayInTimeZone(probe, timeZone).getTime() + 12 * HOUR_MS
  ).getUTCDay();

  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const start = new Date(dayStart.getTime() - daysSinceMonday * DAY_MS);
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

/**
 * Hours of overlap between two half-open intervals. Zero when they do not
 * meet, so callers can sum without checking first.
 *
 * This is the primitive behind every hour total in the eligibility engine. The
 * bug it exists to prevent — adding an interval's whole duration because its
 * start fell inside the window — produced a rolling 24-hour total of 168
 * hours in production.
 */
export function overlapHours(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): number {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  return end <= start ? 0 : (end - start) / HOUR_MS;
}

/**
 * Whether `[start, end)` lies entirely within the operating window of the
 * business day it belongs to.
 *
 * Used to warn — never to block. A shift outside opening hours is unusual, not
 * illegal, and organisations legitimately schedule setup, deliveries and
 * emergency cover outside them.
 */
export function isWithinOperatingWindow(
  start: Date,
  end: Date,
  startHour: number,
  endHour: number,
  timeZone: string = DEFAULT_TIMEZONE
): boolean {
  const windowLength = operatingWindowHours(startHour, endHour);
  if (windowLength >= 24) return true;

  const dayStart = businessDayStart(start, startHour, timeZone);
  const windowEnd = new Date(dayStart.getTime() + windowLength * HOUR_MS);

  return start.getTime() >= dayStart.getTime() && end.getTime() <= windowEnd.getTime();
}

/**
 * "06:00" for 6, "24:00" for 24. Hours are stored as plain integers, and
 * every place that shows them to a user should show them the same way.
 */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** "06:00 – 22:00", marking a window that runs into the next day. */
export function formatOperatingWindow(startHour: number, endHour: number): string {
  const label = `${formatHour(startHour)} – ${formatHour(endHour)}`;
  if (operatingWindowHours(startHour, endHour) >= 24) return "Open 24 hours";
  return endHour <= startHour ? `${label} (next day)` : label;
}
