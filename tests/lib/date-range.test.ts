/**
 * The date-range rule, and the four ways a from/to pair goes wrong.
 *
 * Three screens filter by one now — leave, tasks and certifications — and the
 * value of having written it once is only realised if the edge cases are pinned
 * here rather than discovered separately on each page.
 *
 * The timezone group is the reason this file is worth reading. Everything else
 * is arithmetic; that one is a wrong answer that looks right on the machine it
 * was written on.
 */
import { describe, it, expect } from "vitest";
import {
  DATE_RANGE_MESSAGE,
  hasDateRange,
  parseDateRange,
  withinDateRange,
} from "@/lib/date-range";

describe("reading a pair of pickers", () => {
  it("treats empty as unbounded rather than as a filter", () => {
    expect(parseDateRange("", "")).toEqual({
      from: null,
      to: null,
      problem: null,
    });
    expect(hasDateRange(parseDateRange(undefined, undefined))).toBe(false);
  });

  it("accepts one bound on its own", () => {
    expect(parseDateRange("2026-08-01", "")).toMatchObject({
      from: "2026-08-01",
      to: null,
      problem: null,
    });
  });

  it("accepts a single day as both bounds", () => {
    expect(parseDateRange("2026-08-01", "2026-08-01").problem).toBeNull();
  });

  /*
   * The case the whole `problem` field exists for. Applied silently, a reversed
   * range returns nothing, and an empty screen reads as "there is no leave in
   * August" rather than "you have asked an impossible question".
   */
  it("refuses a range that ends before it starts", () => {
    expect(parseDateRange("2026-08-20", "2026-08-01").problem).toBe("reversed");
  });

  /*
   * And keeps the bounds it read. Blanking them would make an impossible filter
   * indistinguishable from no filter at all — the same silent failure with the
   * evidence removed.
   */
  it("keeps what was typed so a screen can still show it", () => {
    expect(parseDateRange("2026-08-20", "2026-08-01")).toMatchObject({
      from: "2026-08-20",
      to: "2026-08-01",
    });
  });

  it("rejects text that is not a date at all", () => {
    expect(parseDateRange("last tuesday", "").problem).toBe("invalid");
    expect(parseDateRange("2026-8-1", "").problem).toBe("invalid");
  });

  /*
   * Shape is not enough. "2026-02-31" matches the pattern, and `Date.UTC` rolls
   * it forward to 3 March rather than refusing — so a filter for a day that
   * does not exist would silently become a filter for a different day.
   */
  it("rejects a day the calendar does not have", () => {
    expect(parseDateRange("2026-02-31", "").problem).toBe("invalid");
    expect(parseDateRange("", "2026-13-01").problem).toBe("invalid");
  });

  it("accepts 29 February in a leap year and refuses it otherwise", () => {
    expect(parseDateRange("2028-02-29", "").problem).toBeNull();
    expect(parseDateRange("2026-02-29", "").problem).toBe("invalid");
  });

  it("has a message for every problem it can report", () => {
    // A problem with no sentence would reach a screen as a blank banner.
    for (const problem of ["invalid", "reversed"] as const) {
      expect(DATE_RANGE_MESSAGE[problem]).toBeTruthy();
    }
  });
});

describe("what falls inside", () => {
  const august = parseDateRange("2026-08-01", "2026-08-31");

  it("includes both ends", () => {
    expect(withinDateRange("2026-08-01T04:00:00Z", august)).toBe(true);
    expect(withinDateRange("2026-08-31T04:00:00Z", august)).toBe(true);
  });

  it("excludes the days either side", () => {
    expect(withinDateRange("2026-07-31T04:00:00Z", august)).toBe(false);
    expect(withinDateRange("2026-09-01T04:00:00Z", august)).toBe(false);
  });

  /*
   * A task nobody has scheduled is not "in August". Letting it through because
   * it has no date to exclude it by would put every unscheduled task, and every
   * certificate that never expires, into every range at once.
   */
  it("drops a row with no date once a range is set", () => {
    expect(withinDateRange(null, august)).toBe(false);
    expect(withinDateRange(undefined, august)).toBe(false);
  });

  it("keeps a row with no date when there is no range", () => {
    expect(withinDateRange(null, parseDateRange("", ""))).toBe(true);
  });

  /*
   * A problem must NARROW NOTHING. The screens show the message and leave the
   * list alone; filtering on a broken range would empty it, and the reader
   * would blame the data rather than their own typing.
   */
  it("narrows nothing while the range is broken", () => {
    const bad = parseDateRange("2026-08-20", "2026-08-01");
    expect(withinDateRange("1999-01-01T00:00:00Z", bad)).toBe(true);
    expect(withinDateRange(null, bad)).toBe(true);
  });

  it("ignores an unparseable instant rather than throwing", () => {
    expect(withinDateRange("not a date", august)).toBe(false);
  });
});

describe("the organisation's calendar, not the host's", () => {
  /*
   * The failure this is guarding.
   *
   * A shift at 07:00 on 3 August in Singapore is 23:00 on 2 AUGUST in UTC.
   * Compared as instants against a picker value, it lands in the previous day —
   * so on a UTC host, every early-morning shift filters into the wrong date, and
   * a range of exactly one day loses its first eight hours.
   *
   * These pass on a Singapore laptop AND on a UTC server, which is the point:
   * `npm run test:utc` exists because passing in one zone proves nothing.
   */
  const thirdOfAugust = parseDateRange("2026-08-03", "2026-08-03");

  it("puts an early Singapore morning on the Singapore day", () => {
    // 2026-08-02T23:00Z is 07:00 on the 3rd in Singapore.
    expect(withinDateRange("2026-08-02T23:00:00Z", thirdOfAugust)).toBe(true);
  });

  it("puts a late Singapore evening on the Singapore day too", () => {
    // 2026-08-03T14:00Z is 22:00 on the 3rd in Singapore.
    expect(withinDateRange("2026-08-03T14:00:00Z", thirdOfAugust)).toBe(true);
  });

  it("excludes the instant that is the 3rd only in UTC", () => {
    // 2026-08-03T16:30Z is already 00:30 on the 4th in Singapore.
    expect(withinDateRange("2026-08-03T16:30:00Z", thirdOfAugust)).toBe(false);
  });

  it("excludes the instant that is the 3rd only in the Americas", () => {
    // 2026-08-03T00:30Z is 08:30 on the 3rd in Singapore — inside.
    // 2026-08-04T03:00Z is 11:00 on the 4th in Singapore — outside, though it
    // is still the 3rd in New York.
    expect(withinDateRange("2026-08-04T03:00:00Z", thirdOfAugust)).toBe(false);
  });
});
