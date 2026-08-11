/**
 * A from/to date filter, and every way one can be wrong.
 *
 * Three screens now filter by a date range — the leave register, tasks, and
 * certifications — and each `<input type="date">` hands back a bare
 * "YYYY-MM-DD" string with no timezone in it. That string is the source of four
 * separate mistakes, and writing the rule three times means making some subset
 * of them three times.
 *
 * ## The four
 *
 * **Reversed.** From after To matches nothing. Filtered silently, the screen
 * shows an empty list, which reads as "there is no leave in August" rather than
 * "you have asked an impossible question". It is refused and said out loud.
 *
 * **Unparseable.** A typed or pasted "2026-13-45" is a real `Date` as far as
 * `new Date()` is concerned on some inputs and `Invalid Date` on others, and an
 * `Invalid Date` in a comparison is silently false — every row drops out and
 * nothing says why.
 *
 * **The timezone.** This is the one worth the file on its own. The picker
 * yields a wall-clock date in the READER's zone; the rows carry instants. A
 * shift at 07:00 on 3 August in Singapore is 23:00 on 2 August in UTC, so
 * comparing `Date` objects puts it in the wrong day for anybody whose browser
 * is not on the organisation's clock — and, on a UTC host, for everybody.
 * Comparison is therefore done on the CALENDAR-DAY STRING, produced by
 * `localDateInTimeZone` in the organisation's zone. No date arithmetic, no
 * offsets, no boundary: "2026-08-03" either sits between two other strings or
 * it does not.
 *
 * **Inclusivity.** From and To are both inclusive, so a range of one day finds
 * that day. Half-open reads as an off-by-one to everybody who is not holding
 * the code.
 */
import { localDateInTimeZone } from "@/lib/timezone";

/** `YYYY-MM-DD`, which is what `<input type="date">` produces. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type DateRangeProblem = "invalid" | "reversed";

export interface DateRange {
  /** Inclusive lower bound as a calendar day, or null for unbounded. */
  from: string | null;
  /** Inclusive upper bound as a calendar day, or null for unbounded. */
  to: string | null;
  problem: DateRangeProblem | null;
}

export const NO_RANGE: DateRange = { from: null, to: null, problem: null };

export const DATE_RANGE_MESSAGE: Record<DateRangeProblem, string> = {
  invalid: "That is not a date the calendar has.",
  reversed: "The end date is before the start date.",
};

/**
 * Reads a pair of picker values into a range, or says what is wrong with them.
 *
 * A range carrying a `problem` keeps its parsed bounds so a caller can still
 * show what was typed, and every consumer must refuse to filter on it. Blanking
 * them here instead would turn "you asked for something impossible" into "no
 * filter", which is the silent-empty-list failure wearing a different hat.
 */
export function parseDateRange(
  from?: string | null,
  to?: string | null
): DateRange {
  const start = clean(from);
  const end = clean(to);

  if (start === false || end === false) {
    return {
      from: start === false ? null : start,
      to: end === false ? null : end,
      problem: "invalid",
    };
  }

  /*
   * String comparison, not Date. Both are `YYYY-MM-DD`, a format whose
   * lexical order IS its chronological order — which is the entire reason ISO
   * 8601 puts the year first, and why this needs no parsing to get right.
   */
  if (start && end && start > end) {
    return { from: start, to: end, problem: "reversed" };
  }

  return { from: start, to: end, problem: null };
}

/**
 * `null` for absent, `false` for present-but-not-a-date, the day for valid.
 *
 * The three cases are genuinely different and collapsing the last two is the
 * `invalid` failure above: an empty picker means "no bound", and "2026-13-45"
 * means "your filter is broken".
 */
function clean(value?: string | null): string | null | false {
  const text = value?.trim();
  if (!text) return null;
  if (!ISO_DAY.test(text)) return false;

  /*
   * The shape is not enough. "2026-02-31" passes the pattern and is not a day;
   * `Date.UTC` rolls it forward to 3 March, so the round trip through a
   * formatted string is what actually catches it — the same technique the
   * assistant's date parser uses to reject 31 February.
   */
  const [y, m, d] = text.split("-").map(Number);
  const asDate = new Date(Date.UTC(y, m - 1, d));
  return localDateInTimeZone(asDate, "UTC") === text ? text : false;
}

/** Whether this range would actually narrow anything. */
export function hasDateRange(range: DateRange): boolean {
  return range.problem === null && (range.from !== null || range.to !== null);
}

/**
 * Whether an instant falls inside the range, on the organisation's calendar.
 *
 * A row with no date at all is OUT whenever a range is set. A task nobody has
 * scheduled is not "in August"; including it because it has no date to exclude
 * it by would put the unscheduled work in every range at once.
 */
export function withinDateRange(
  instant: Date | string | null | undefined,
  range: DateRange
): boolean {
  if (!hasDateRange(range)) return true;
  if (!instant) return false;

  const at = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(at.getTime())) return false;

  const day = localDateInTimeZone(at);
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
}
