/**
 * Timezone Utilities
 *
 * The app is deployed on Vercel, whose runtime clock is UTC, while the product
 * and its users operate on Singapore time. Anything that asks "what day is it?"
 * or "what hour is it?" must therefore state the timezone explicitly — a bare
 * `new Date().getHours()` silently returns a UTC answer in production and a
 * Singapore answer on a developer machine, which is the worst possible failure
 * mode: correct locally, wrong live, and identical in the source.
 *
 * `DEFAULT_TIMEZONE` is the organisation-wide default. It is deliberately a
 * single constant so that when per-organisation timezones are introduced
 * (CompanySettings already exists as the natural home), callers pass an
 * override and nothing else changes.
 *
 * Note on DST: `zoneOffsetMs` is sampled at the supplied instant, which is
 * correct for fixed-offset zones such as Asia/Singapore. For a zone that
 * observes DST, an instant within an hour of a transition can resolve to the
 * neighbouring offset; if such zones are ever supported, resolve the offset at
 * the computed local midnight rather than at `date`.
 */

export const DEFAULT_TIMEZONE = "Asia/Singapore";

/**
 * Milliseconds to add to a UTC instant to obtain the wall-clock time in `timeZone`.
 * Singapore is UTC+8, so this returns 28_800_000.
 */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }

  // Intl can emit hour 24 for midnight in some environments — normalise to 0.
  const hour = parts.hour === 24 ? 0 : parts.hour;

  const wallClockAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    parts.minute,
    parts.second
  );

  return wallClockAsUtc - date.getTime();
}

/**
 * The instant at which the given date's day begins in `timeZone`.
 * On Vercel (UTC) this returns 16:00 UTC of the previous calendar day for
 * Singapore — which is exactly what a "today" filter needs.
 */
export function startOfDayInTimeZone(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): Date {
  const offset = zoneOffsetMs(date, timeZone);
  const wallClock = new Date(date.getTime() + offset);

  const midnightAsUtc = Date.UTC(
    wallClock.getUTCFullYear(),
    wallClock.getUTCMonth(),
    wallClock.getUTCDate()
  );

  return new Date(midnightAsUtc - offset);
}

/** The instant at which the given date's day ends in `timeZone` (exclusive). */
export function endOfDayInTimeZone(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): Date {
  const start = startOfDayInTimeZone(date, timeZone);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/** Hour of day (0–23) at the given instant, in `timeZone`. */
export function hourInTimeZone(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): number {
  const offset = zoneOffsetMs(date, timeZone);
  return new Date(date.getTime() + offset).getUTCHours();
}

/** Day of week (0 = Sunday … 6 = Saturday) at the given instant, in `timeZone`. */
export function dayOfWeekInTimeZone(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): number {
  const offset = zoneOffsetMs(date, timeZone);
  return new Date(date.getTime() + offset).getUTCDay();
}
