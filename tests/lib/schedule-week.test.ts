/**
 * Tests for the auto-scheduler's week selection.
 *
 * The recurring hazard here is that `YYYY-MM-DD` has two different meanings in
 * JavaScript depending on how you parse it. `new Date("2026-08-03")` is defined
 * to be UTC midnight, so `toLocaleDateString` on it renders 2 August for any
 * viewer west of UTC — the date input would show the user 3 August while the
 * label beside it said 2 August, on the same screen. `parseDateOnly` builds a
 * LOCAL calendar date instead, which is what a bare date means to the person
 * reading it.
 *
 * Every assertion below is phrased so it holds in any timezone, since the suite
 * runs under both TZ=Asia/Singapore and TZ=UTC and the browser's zone is the
 * user's anyway.
 */
import { describe, it, expect } from "vitest";
import {
  isMonday,
  mondayOf,
  shortDateLabel,
  weekdayName,
  parseDateOnly,
  shiftWeeks,
  thisMondayInOrgTime,
  weekRangeLabel,
} from "@/lib/schedule-week";

describe("parseDateOnly", () => {
  it("keeps the calendar date the string names", () => {
    // The property the whole module exists for. `new Date("2026-08-03")` gives
    // 2 August in any negative UTC offset; this gives 3 August everywhere.
    const date = parseDateOnly("2026-08-03")!;
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(7); // August
    expect(date.getDate()).toBe(3);
  });

  it("is local midnight, not UTC midnight", () => {
    const date = parseDateOnly("2026-08-03")!;
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
  });

  it("rejects a malformed string rather than returning Invalid Date", () => {
    for (const bad of ["", "2026-8-3", "03/08/2026", "not a date", "2026-08"]) {
      expect(parseDateOnly(bad)).toBeNull();
    }
  });

  it("rejects an impossible date instead of silently rolling it over", () => {
    // `new Date(2026, 1, 30)` quietly becomes 2 March. An out-of-range week
    // would otherwise reach the scheduler looking entirely deliberate.
    expect(parseDateOnly("2026-02-30")).toBeNull();
    expect(parseDateOnly("2026-13-01")).toBeNull();
    expect(parseDateOnly("2026-00-10")).toBeNull();
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(parseDateOnly("2028-02-29")).not.toBeNull(); // 2028 is a leap year
    expect(parseDateOnly("2026-02-29")).toBeNull();
  });
});

/**
 * These asserted exact strings — "Aug 3 — Aug 9, 2026" — and that is a claim
 * about ICU, not about this function.
 *
 * The label renders in the READER's locale, so the same correct output is
 * "3 Aug — 9 Aug 2026" on a British machine and "8月3日" on a Chinese one.
 * Pinning the string made the suite pass or fail on whose laptop it ran — the
 * same defect as the fixed sleeps, which failed here and passed there and were
 * making a claim about the hardware.
 *
 * So they now assert what this function actually owns: which SEVEN DAYS the
 * label covers, and which year it ends in. Every one of those is a number, and
 * numbers are the part every locale agrees on.
 */
describe("weekRangeLabel", () => {
  it("spans seven days from the given date", () => {
    const label = weekRangeLabel("2026-08-03");
    expect(label).toContain("3");
    expect(label).toContain("9");
    expect(label).toContain("2026");
  });

  it("crosses a month boundary", () => {
    const label = weekRangeLabel("2026-08-31");
    expect(label).toContain("31");
    expect(label).toContain("6");
    // Two different months named, whatever this machine calls them.
    expect(label.split(" — ")).toHaveLength(2);
  });

  it("crosses a year boundary and shows the END year", () => {
    // The year belongs to the end of the range, so a week straddling New Year
    // reads 2027 rather than claiming 2026 throughout. THIS is the assertion
    // worth having, and it survives any locale.
    const label = weekRangeLabel("2026-12-28");
    expect(label).toContain("2027");
    expect(label).not.toContain("2026");
  });

  it("names the same day the input does", () => {
    // The actual bug: the label must never disagree with the date sitting in
    // the input next to it. Asserted on the DAY NUMBER rather than on the
    // rendered month name, which every locale spells differently and some do
    // not put first.
    for (const date of ["2026-01-01", "2026-06-15", "2026-08-03", "2026-12-31"]) {
      const day = Number(date.slice(8, 10));
      const label = weekRangeLabel(date);
      expect(label.split(" — ")[0], `${date} start`).toContain(String(day));
    }
  });

  it("returns an empty string for a half-typed date rather than 'Invalid Date'", () => {
    expect(weekRangeLabel("2026-08")).toBe("");
    expect(weekRangeLabel("")).toBe("");
  });
});


describe("isMonday", () => {
  it("recognises a Monday", () => {
    expect(isMonday("2026-08-03")).toBe(true); // a Monday
  });

  it("rejects every other day of that week", () => {
    for (const d of ["04", "05", "06", "07", "08", "09"]) {
      expect(isMonday(`2026-08-${d}`)).toBe(false);
    }
  });

  it("is false for an unparseable string", () => {
    expect(isMonday("nonsense")).toBe(false);
  });
});

describe("mondayOf", () => {
  it("returns the same date when given a Monday", () => {
    expect(mondayOf("2026-08-03")).toBe("2026-08-03");
  });

  it("walks back from midweek", () => {
    expect(mondayOf("2026-08-06")).toBe("2026-08-03"); // Thursday
  });

  it("treats Sunday as the END of its week, not the start", () => {
    // The off-by-one that shifts the whole scheduling window: JavaScript numbers
    // Sunday as 0, so the naive `1 - weekday` sends it forward a day instead of
    // back six.
    expect(mondayOf("2026-08-09")).toBe("2026-08-03");
  });

  it("crosses a month boundary backwards", () => {
    expect(mondayOf("2026-09-02")).toBe("2026-08-31"); // Wednesday
  });

  it("returns the input unchanged when it cannot parse it", () => {
    expect(mondayOf("nonsense")).toBe("nonsense");
  });
});

describe("shiftWeeks", () => {
  it("moves forward a week", () => {
    expect(shiftWeeks("2026-08-03", 1)).toBe("2026-08-10");
  });

  it("moves back a week", () => {
    expect(shiftWeeks("2026-08-03", -1)).toBe("2026-07-27");
  });

  it("crosses a year boundary", () => {
    expect(shiftWeeks("2026-12-28", 1)).toBe("2027-01-04");
    expect(shiftWeeks("2027-01-04", -1)).toBe("2026-12-28");
  });

  it("always lands on the same weekday", () => {
    // The property that matters for a week picker. Adding 7 × 24h in milliseconds
    // does NOT guarantee this in a timezone that observes daylight saving — it
    // can land on 23:00 the previous day, and reading the date off that is wrong
    // by one.
    let cursor = "2026-01-05"; // a Monday
    for (let i = 0; i < 60; i++) {
      expect(isMonday(cursor)).toBe(true);
      cursor = shiftWeeks(cursor, 1);
    }
  });

  it("is reversible", () => {
    for (const date of ["2026-03-09", "2026-10-26", "2026-12-28"]) {
      expect(shiftWeeks(shiftWeeks(date, 4), -4)).toBe(date);
    }
  });

  it("returns the input unchanged when it cannot parse it", () => {
    expect(shiftWeeks("nonsense", 1)).toBe("nonsense");
  });
});

describe("thisMondayInOrgTime", () => {
  /** An instant, written as Singapore wall-clock time. */
  const sgt = (iso: string) => new Date(`${iso}+08:00`);

  it("returns the same day when it is already Monday", () => {
    expect(thisMondayInOrgTime(sgt("2026-08-03T14:00:00"))).toBe("2026-08-03");
  });

  it("walks back from midweek", () => {
    expect(thisMondayInOrgTime(sgt("2026-08-06T09:00:00"))).toBe("2026-08-03");
  });

  it("treats Sunday as the end of the week that is closing", () => {
    expect(thisMondayInOrgTime(sgt("2026-08-09T23:00:00"))).toBe("2026-08-03");
  });

  it("uses SINGAPORE's weekday, not the server's", () => {
    // 01:00 Monday in Singapore is 17:00 the previous SUNDAY in UTC. A server on
    // UTC reading its own weekday would return the previous Monday and shift the
    // entire scheduling window back seven days.
    expect(thisMondayInOrgTime(sgt("2026-08-03T01:00:00"))).toBe("2026-08-03");
  });

  it("uses Singapore's date at the other end of the day too", () => {
    // 23:00 Sunday in Singapore is still Sunday in UTC, but only just — this
    // pins the boundary from the other side.
    expect(thisMondayInOrgTime(sgt("2026-08-02T23:30:00"))).toBe("2026-07-27");
  });

  it("always returns a Monday", () => {
    for (let day = 1; day <= 28; day++) {
      const iso = `2026-06-${String(day).padStart(2, "0")}T12:00:00`;
      expect(isMonday(thisMondayInOrgTime(sgt(iso)))).toBe(true);
    }
  });
});

/*
 * Both of these exist so the auto-schedule page can name a non-Monday week
 * without doing its own date parsing. `new Date("2026-08-05")` parses as UTC
 * midnight, so a page west of UTC naming that day gets Tuesday — which is the
 * whole reason this module owns the parsing.
 */
describe("weekdayName", () => {
  it("names the day the string actually falls on", () => {
    expect(weekdayName("2026-08-03")).toBe("Monday");
    expect(weekdayName("2026-08-05")).toBe("Wednesday");
    expect(weekdayName("2026-08-09")).toBe("Sunday");
  });

  it("returns null rather than guessing at an unparseable value", () => {
    for (const value of ["", "2026-08", "not-a-date"]) {
      expect(weekdayName(value)).toBeNull();
    }
  });
});

describe("shortDateLabel", () => {
  /*
   * This asserted "Mon 3 Aug" — the en-GB spelling, which the label no longer
   * forces. What the function owns is WHICH day it names; how that day is
   * written belongs to the reader.
   */
  it("names the weekday and the day of the month", () => {
    const label = shortDateLabel("2026-08-03");

    // Not null, which is its answer for an unparseable date — asserted rather
    // than assumed away, because every claim below is vacuous without it.
    expect(label).not.toBeNull();
    expect(label!).toContain("3");
    // A weekday is present as well as a date — the label is not bare numbers.
    expect(label!.length).toBeGreaterThan(4);
    // And it distinguishes days, which a constant would not.
    expect(shortDateLabel("2026-08-04")).not.toBe(label);
  });

  it("returns null for an unparseable value", () => {
    expect(shortDateLabel("nonsense")).toBeNull();
  });
});
