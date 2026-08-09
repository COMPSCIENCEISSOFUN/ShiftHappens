/**
 * Tests for the business-day boundary.
 *
 * Every assertion is written against ABSOLUTE instants (UTC) even though the
 * behaviour is about Singapore local time, because the suite runs under both
 * TZ=Asia/Singapore and TZ=UTC. An assertion phrased with `new Date(y, m, d)`
 * or `.getHours()` would pass in one and fail in the other, and the failure
 * would look like a logic bug rather than a test bug. Singapore is UTC+8, so
 * 06:00 local is 22:00 UTC on the previous calendar day.
 */
import { describe, it, expect } from "vitest";
import {
  DAY_MS,
  businessDayRange,
  businessDayRangeStartingOn,
  businessDayStart,
  businessDayStartingOn,
  businessWeekRange,
  formatHour,
  formatOperatingWindow,
  isWithinOperatingWindow,
  operatingWindowHours,
  overlapHours,
  windowWrapsMidnight,
} from "@/lib/business-day";

/** An instant, written as Singapore wall-clock time. */
function sgt(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

describe("operatingWindowHours", () => {
  it("measures an ordinary daytime window", () => {
    expect(operatingWindowHours(6, 22)).toBe(16);
  });

  it("measures a window that wraps past midnight", () => {
    // The case that was previously inexpressible: open 20:00, close 04:00.
    expect(operatingWindowHours(20, 4)).toBe(8);
  });

  it("treats 0–24 as a full day", () => {
    expect(operatingWindowHours(0, 24)).toBe(24);
  });

  it("treats an identical start and end as open around the clock, not closed", () => {
    // A zero-length window would silently empty the calendar, so it is not
    // expressible — the only sane reading of "opens at 6, closes at 6" is 24h.
    expect(operatingWindowHours(6, 6)).toBe(24);
  });

  it("never returns zero or a negative span for any legal pair", () => {
    for (let start = 0; start <= 23; start++) {
      for (let end = 1; end <= 24; end++) {
        const hours = operatingWindowHours(start, end);
        expect(hours).toBeGreaterThan(0);
        expect(hours).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe("windowWrapsMidnight", () => {
  it("is false for a daytime window", () => {
    expect(windowWrapsMidnight(6, 22)).toBe(false);
  });

  it("is false for a full day starting at midnight", () => {
    expect(windowWrapsMidnight(0, 24)).toBe(false);
  });

  it("is true for a night window", () => {
    expect(windowWrapsMidnight(20, 4)).toBe(true);
  });

  it("is true for a full day that does not start at midnight", () => {
    // 24 hours from 06:00 necessarily runs into the next calendar day.
    expect(windowWrapsMidnight(6, 6)).toBe(true);
  });
});

describe("businessDayStart", () => {
  it("returns local midnight when the boundary is midnight", () => {
    expect(businessDayStart(sgt("2026-03-10T14:00:00"), 0)).toEqual(
      sgt("2026-03-10T00:00:00")
    );
  });

  it("returns today's boundary for an instant after it", () => {
    expect(businessDayStart(sgt("2026-03-10T14:00:00"), 6)).toEqual(
      sgt("2026-03-10T06:00:00")
    );
  });

  it("returns YESTERDAY's boundary for an instant before it", () => {
    // The whole point of the concept: 2am work belongs to the night that
    // produced it, not to the morning it happens to land in.
    expect(businessDayStart(sgt("2026-03-10T02:00:00"), 6)).toEqual(
      sgt("2026-03-09T06:00:00")
    );
  });

  it("includes the boundary instant itself in the day it opens", () => {
    // Half-open interval: 06:00:00.000 is the first moment of the new day, not
    // the last of the old one. An off-by-one here silently misfiles every shift
    // that starts exactly on the hour, which is most of them.
    expect(businessDayStart(sgt("2026-03-10T06:00:00"), 6)).toEqual(
      sgt("2026-03-10T06:00:00")
    );
  });

  it("puts one millisecond before the boundary in the previous day", () => {
    const justBefore = new Date(sgt("2026-03-10T06:00:00").getTime() - 1);
    expect(businessDayStart(justBefore, 6)).toEqual(sgt("2026-03-09T06:00:00"));
  });

  it("handles a late boundary", () => {
    // A 20:00 boundary means almost the entire calendar day belongs to the
    // PREVIOUS business day.
    expect(businessDayStart(sgt("2026-03-10T19:59:00"), 20)).toEqual(
      sgt("2026-03-09T20:00:00")
    );
    expect(businessDayStart(sgt("2026-03-10T20:00:00"), 20)).toEqual(
      sgt("2026-03-10T20:00:00")
    );
  });

  it("crosses a month boundary correctly", () => {
    expect(businessDayStart(sgt("2026-04-01T03:00:00"), 6)).toEqual(
      sgt("2026-03-31T06:00:00")
    );
  });
});

describe("businessDayRange", () => {
  it("is always exactly 24 hours, whatever the operating window is", () => {
    // The business day is the ATTRIBUTION window. It does not shrink just
    // because the business is only open for part of it.
    const { start, end } = businessDayRange(sgt("2026-03-10T14:00:00"), 6);
    expect(end.getTime() - start.getTime()).toBe(DAY_MS);
  });

  it("runs from one boundary to the next", () => {
    const { start, end } = businessDayRange(sgt("2026-03-10T14:00:00"), 6);
    expect(start).toEqual(sgt("2026-03-10T06:00:00"));
    expect(end).toEqual(sgt("2026-03-11T06:00:00"));
  });

  it("consecutive business days meet exactly, with no gap or overlap", () => {
    const first = businessDayRange(sgt("2026-03-10T14:00:00"), 6);
    const second = businessDayRange(sgt("2026-03-11T14:00:00"), 6);
    expect(first.end).toEqual(second.start);
  });
});

describe("businessWeekRange", () => {
  it("starts on Monday at the boundary hour", () => {
    // 2026-03-11 is a Wednesday.
    const { start, end } = businessWeekRange(sgt("2026-03-11T14:00:00"), 6);
    expect(start).toEqual(sgt("2026-03-09T06:00:00")); // Monday
    expect(end).toEqual(sgt("2026-03-16T06:00:00"));
  });

  it("is exactly seven days long", () => {
    const { start, end } = businessWeekRange(sgt("2026-03-11T14:00:00"), 6);
    expect(end.getTime() - start.getTime()).toBe(7 * DAY_MS);
  });

  it("files Sunday into the week that is ending", () => {
    // 2026-03-15 is a Sunday.
    const { start } = businessWeekRange(sgt("2026-03-15T14:00:00"), 6);
    expect(start).toEqual(sgt("2026-03-09T06:00:00"));
  });

  it("files the small hours of Monday into the PREVIOUS week", () => {
    // The trap this guards. 03:00 on Monday belongs to Sunday's business day,
    // and therefore to the week that is ending. Reading the weekday off the raw
    // instant would file it under the new week and let someone work the early
    // hours of Monday without it counting against either week's cap properly.
    const { start, end } = businessWeekRange(sgt("2026-03-16T03:00:00"), 6);
    expect(start).toEqual(sgt("2026-03-09T06:00:00"));
    expect(end).toEqual(sgt("2026-03-16T06:00:00"));
  });

  it("starts the new week once Monday's boundary passes", () => {
    const { start } = businessWeekRange(sgt("2026-03-16T07:00:00"), 6);
    expect(start).toEqual(sgt("2026-03-16T06:00:00"));
  });

  it("still starts on Monday when the boundary is midnight", () => {
    const { start } = businessWeekRange(sgt("2026-03-11T14:00:00"), 0);
    expect(start).toEqual(sgt("2026-03-09T00:00:00"));
  });
});

describe("overlapHours", () => {
  const a = sgt("2026-03-10T08:00:00");
  const b = sgt("2026-03-10T16:00:00");

  it("returns the full length when one interval contains the other", () => {
    expect(overlapHours(a, b, sgt("2026-03-10T00:00:00"), sgt("2026-03-11T00:00:00"))).toBe(8);
  });

  it("returns only the overlapping part", () => {
    expect(overlapHours(a, b, sgt("2026-03-10T12:00:00"), sgt("2026-03-11T00:00:00"))).toBe(4);
  });

  it("returns zero for disjoint intervals", () => {
    expect(overlapHours(a, b, sgt("2026-03-11T00:00:00"), sgt("2026-03-12T00:00:00"))).toBe(0);
  });

  it("returns zero when intervals merely touch", () => {
    // Half-open: an interval ending exactly where another begins shares no
    // time. Counting the touch point would double-count every back-to-back
    // shift by an instant, and worse, make a shift that ends at the day
    // boundary contribute to both days.
    expect(overlapHours(a, b, b, sgt("2026-03-11T00:00:00"))).toBe(0);
  });

  it("returns zero for a zero-length interval", () => {
    expect(overlapHours(a, a, sgt("2026-03-10T00:00:00"), sgt("2026-03-11T00:00:00"))).toBe(0);
  });
});

describe("isWithinOperatingWindow", () => {
  it("accepts a shift inside the window", () => {
    expect(
      isWithinOperatingWindow(
        sgt("2026-03-10T09:00:00"),
        sgt("2026-03-10T17:00:00"),
        6,
        22
      )
    ).toBe(true);
  });

  it("rejects a shift that ends after closing", () => {
    expect(
      isWithinOperatingWindow(
        sgt("2026-03-10T18:00:00"),
        sgt("2026-03-10T23:00:00"),
        6,
        22
      )
    ).toBe(false);
  });

  it("rejects a shift that starts before opening", () => {
    expect(
      isWithinOperatingWindow(
        sgt("2026-03-10T04:00:00"),
        sgt("2026-03-10T09:00:00"),
        6,
        22
      )
    ).toBe(false);
  });

  it("accepts anything when the organisation is open 24 hours", () => {
    expect(
      isWithinOperatingWindow(
        sgt("2026-03-10T02:00:00"),
        sgt("2026-03-10T05:00:00"),
        0,
        24
      )
    ).toBe(true);
  });

  it("accepts a night shift inside a wrapping window", () => {
    // The case the old end > start validation made impossible to express.
    expect(
      isWithinOperatingWindow(
        sgt("2026-03-10T22:00:00"),
        sgt("2026-03-11T03:00:00"),
        20,
        4
      )
    ).toBe(true);
  });

  it("rejects a daytime shift for a night-only business", () => {
    expect(
      isWithinOperatingWindow(
        sgt("2026-03-10T10:00:00"),
        sgt("2026-03-10T14:00:00"),
        20,
        4
      )
    ).toBe(false);
  });

  it("accepts a shift that exactly fills the window", () => {
    expect(
      isWithinOperatingWindow(
        sgt("2026-03-10T06:00:00"),
        sgt("2026-03-10T22:00:00"),
        6,
        22
      )
    ).toBe(true);
  });
});

describe("formatting", () => {
  it("pads hours to two digits", () => {
    expect(formatHour(6)).toBe("06:00");
    expect(formatHour(22)).toBe("22:00");
    expect(formatHour(0)).toBe("00:00");
    expect(formatHour(24)).toBe("24:00");
  });

  it("labels an ordinary window plainly", () => {
    expect(formatOperatingWindow(6, 22)).toBe("06:00 – 22:00");
  });

  it("marks a window that runs into the next day", () => {
    expect(formatOperatingWindow(20, 4)).toBe("20:00 – 04:00 (next day)");
  });

  it("names a 24-hour operation rather than showing a confusing range", () => {
    expect(formatOperatingWindow(0, 24)).toBe("Open 24 hours");
    expect(formatOperatingWindow(6, 6)).toBe("Open 24 hours");
  });
});

/**
 * Two questions that look like one.
 *
 * `businessDayStart` asks which business day CONTAINS an instant — right for
 * attributing hours, where 02:00 work belongs to the night that produced it.
 * `businessDayStartingOn` asks which business day is LABELLED with a date —
 * right for a calendar column, which is a heading rather than a moment.
 *
 * Both calendars asked the first question about a column and drew the wrong day
 * for every one of them. The functions agree everywhere except before the
 * boundary, and they agree completely at a midnight boundary — which is the
 * default, and is why nothing caught it.
 */
describe("the day containing an instant vs the day labelled with a date", () => {
  const boundary = 7;

  it("agree from the boundary onwards", () => {
    const noon = sgt("2026-03-10T12:00");

    expect(businessDayStartingOn(noon, boundary).getTime()).toBe(
      businessDayStart(noon, boundary).getTime()
    );
  });

  // Midnight is the case the pages actually pass, and the only one that
  // distinguishes them.
  it("disagree by a day before the boundary", () => {
    const midnight = sgt("2026-03-11T00:00");

    expect(businessDayStartingOn(midnight, boundary).toISOString()).toBe(
      sgt("2026-03-11T07:00").toISOString()
    );
    expect(businessDayStart(midnight, boundary).toISOString()).toBe(
      sgt("2026-03-10T07:00").toISOString()
    );
  });

  it("are identical when the day begins at midnight", () => {
    for (const iso of ["2026-03-10T00:00", "2026-03-10T12:00", "2026-03-10T23:59"]) {
      const instant = sgt(iso);
      expect(businessDayStartingOn(instant, 0).getTime()).toBe(
        businessDayStart(instant, 0).getTime()
      );
    }
  });

  // Consecutive columns tile the week: each ends exactly where the next begins,
  // so nothing falls between two days or is drawn in both.
  it("tiles consecutive days without a gap or an overlap", () => {
    const monday = businessDayRangeStartingOn(sgt("2026-03-09T00:00"), boundary);
    const tuesday = businessDayRangeStartingOn(sgt("2026-03-10T00:00"), boundary);

    expect(monday.end.getTime()).toBe(tuesday.start.getTime());
  });
});
