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

  // Milliseconds must be carried through. Intl only formats down to seconds, so
  // omitting them makes the computed offset short by the instant's millisecond
  // component, and every derived boundary inherits that error: a "start of day"
  // would land on 00:00:00.123 rather than 00:00:00.000, silently excluding
  // anything that begins exactly at midnight. Zone offsets are always a whole
  // number of minutes, so the wall clock shares the instant's milliseconds.
  const wallClockAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    parts.minute,
    parts.second,
    date.getUTCMilliseconds()
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

/**
 * Formats an instant for a `<input type="datetime-local">` value.
 *
 * The input renders and parses its value as the BROWSER'S local time, with no
 * timezone marker. The obvious-looking `date.toISOString().slice(0, 16)` is
 * therefore wrong: it yields the UTC wall clock, which the input then displays
 * as though it were local. In Singapore that shows a 17:00 shift as 09:00, and
 * submitting the form converts that 09:00 back to an instant eight hours
 * earlier — so simply opening a task and saving it walks the time backwards,
 * compounding on every edit.
 *
 * Building the string from the local getters keeps the round trip exact:
 * `new Date(toDateTimeLocalValue(d))` equals `d` truncated to the minute, in
 * every timezone.
 */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * The calendar date at the given instant, in `timeZone`, as "YYYY-MM-DD".
 *
 * `new Date().toISOString().split("T")[0]` looks equivalent and is not: it
 * yields the UTC date, so from 08:00 Singapore time backwards it names the
 * previous day. Anything that tells a user — or a language model — what "today"
 * is must use this instead.
 */
export function localDateInTimeZone(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const offset = zoneOffsetMs(date, timeZone);
  const wallClock = new Date(date.getTime() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    `${wallClock.getUTCFullYear()}-` +
    `${pad(wallClock.getUTCMonth() + 1)}-` +
    `${pad(wallClock.getUTCDate())}`
  );
}

/**
 * The UTC offset at the given instant, in `timeZone`, as "+08:00" / "-05:00".
 * Used to state the offset explicitly in an ISO 8601 string, so a timestamp
 * cannot be misread as UTC by whatever consumes it.
 */
export function utcOffsetLabel(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const totalMinutes = Math.round(zoneOffsetMs(date, timeZone) / 60000);
  const sign = totalMinutes < 0 ? "-" : "+";
  const abs = Math.abs(totalMinutes);
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The wall-clock time at the given instant, in `timeZone`, as "HH:MM".
 *
 * This is the format weekly availability is stored in (`Availability.startTime`
 * / `endTime` are plain strings such as "09:00", meaning 9am where the staff
 * member works). Comparing a task's time against those strings therefore
 * requires the task's LOCAL time — `date.getHours()` gives the server's, which
 * on Vercel is UTC and eight hours out.
 */
export function timeOfDayInTimeZone(
  date: Date,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const offset = zoneOffsetMs(date, timeZone);
  const wallClock = new Date(date.getTime() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${pad(wallClock.getUTCHours())}:${pad(wallClock.getUTCMinutes())}`;
}
