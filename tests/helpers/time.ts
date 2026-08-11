/**
 * Time helpers for building test fixtures at ORGANISATION-local wall-clock
 * times, independent of the timezone the test process happens to run in.
 *
 * Why this exists: fixtures used to be built with `new Date(2026, 5, 15, 9)`
 * and `setHours()`, which are LOCAL to the process. That silently assumed the
 * machine running the tests was on Singapore time. It always was — so the
 * suite passed — while the production server on UTC interpreted the same data
 * eight hours away. `npm run test:utc` exists to catch exactly that, and it
 * can only do so if the fixtures state a timezone instead of inheriting one.
 *
 * The +08:00 offset is written out deliberately rather than imported from
 * src/lib/timezone. A test that derives its expectations from the code under
 * test cannot detect a fault in that code; fixtures should assert concrete,
 * independently-known values.
 */

/** Asia/Singapore is UTC+08:00 year round — no daylight saving. */
const SGT_OFFSET = "+08:00";
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An instant at a Singapore wall-clock time.
 *
 *   sgt("2026-06-15T09:00")  ->  2026-06-15T01:00:00.000Z
 */
export function sgt(wallClock: string): Date {
  const withSeconds = wallClock.length === 16 ? `${wallClock}:00` : wallClock;
  return new Date(`${withSeconds}${SGT_OFFSET}`);
}

/** Midnight today, Singapore time. */
export function startOfTodaySgt(now: Date = new Date()): Date {
  const shifted = now.getTime() + SGT_OFFSET_MS;
  const midnightShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
  return new Date(midnightShifted - SGT_OFFSET_MS);
}

/**
 * Today at a given Singapore hour, optionally offset by whole days.
 *
 *   todaySgtAt(9)      -> 09:00 today, Singapore
 *   todaySgtAt(9, 1)   -> 09:00 tomorrow, Singapore
 */
export function todaySgtAt(hour: number, dayOffset = 0, now: Date = new Date()): Date {
  return new Date(
    startOfTodaySgt(now).getTime() + dayOffset * DAY_MS + hour * 60 * 60 * 1000
  );
}

/**
 * The next occurrence of a weekday, at midnight Singapore time.
 *
 * Strictly in the future — asking on a Friday for a Friday gives the following
 * week, never today. Fixtures that need a specific weekday usually also need
 * the day to be one nothing has happened on yet.
 *
 * Exists because a fixture pinned to a literal date is a bomb with a fuse: a
 * suite built on "Friday 14 August 2026" passes until the 14th and then fails
 * every run afterwards, for a reason no assertion message mentions.
 *
 * @param weekday 0 = Sunday, matching `Date.getUTCDay` and the `dayOfWeek`
 *                column, so a caller cannot line the two up wrongly.
 */
export function nextWeekdaySgt(weekday: number, now: Date = new Date()): Date {
  const today = startOfTodaySgt(now);
  const current = new Date(today.getTime() + SGT_OFFSET_MS).getUTCDay();
  // 1..7 rather than 0..6: a difference of zero would return today.
  const diff = ((weekday - current + 7) % 7) || 7;
  return new Date(today.getTime() + diff * DAY_MS);
}

/** The next Monday at midnight, Singapore time. */
export function nextMondaySgt(now: Date = new Date()): Date {
  return nextWeekdaySgt(1, now);
}

/** The next Sunday at midnight, Singapore time. */
export function nextSundaySgt(now: Date = new Date()): Date {
  const today = startOfTodaySgt(now);
  const weekday = new Date(today.getTime() + SGT_OFFSET_MS).getUTCDay();
  const diff = weekday === 0 ? 0 : 7 - weekday;
  return new Date(today.getTime() + diff * DAY_MS);
}

/** A Singapore-local hour on a given Singapore-midnight date. */
export function atHourSgt(midnightSgt: Date, hour: number): Date {
  return new Date(midnightSgt.getTime() + hour * 60 * 60 * 1000);
}
