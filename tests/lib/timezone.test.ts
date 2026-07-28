/**
 * Tests for the timezone utilities.
 *
 * The whole point of this module is that it gives the same answer no matter
 * what TZ the process runs under — a developer machine on Asia/Singapore and a
 * Vercel function on UTC must agree. So these tests assert against fixed UTC
 * instants with known Singapore wall-clock equivalents, never against the
 * ambient clock or the ambient zone.
 *
 * Reference: Singapore is UTC+8 year-round (no DST).
 *   2026-07-28T00:30:00Z  ==  2026-07-28 08:30 SGT
 *   2026-07-28T15:00:00Z  ==  2026-07-28 23:00 SGT
 *   2026-07-28T16:00:00Z  ==  2026-07-29 00:00 SGT  ← next Singapore day
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_TIMEZONE,
  startOfDayInTimeZone,
  endOfDayInTimeZone,
  hourInTimeZone,
  dayOfWeekInTimeZone,
  toDateTimeLocalValue,
  localDateInTimeZone,
  utcOffsetLabel,
  timeOfDayInTimeZone,
} from "@/lib/timezone";

describe("timezone utilities", () => {
  it("defaults to Asia/Singapore", () => {
    expect(DEFAULT_TIMEZONE).toBe("Asia/Singapore");
  });

  describe("startOfDayInTimeZone", () => {
    it("returns 16:00 UTC of the previous day for a Singapore morning", () => {
      // 08:30 SGT on 28 Jul → the Singapore day began at 2026-07-27T16:00:00Z
      const instant = new Date("2026-07-28T00:30:00Z");
      expect(startOfDayInTimeZone(instant).toISOString()).toBe(
        "2026-07-27T16:00:00.000Z"
      );
    });

    it("returns the same boundary late in the same Singapore day", () => {
      // 23:00 SGT on 28 Jul — still the 28th in Singapore
      const instant = new Date("2026-07-28T15:00:00Z");
      expect(startOfDayInTimeZone(instant).toISOString()).toBe(
        "2026-07-27T16:00:00.000Z"
      );
    });

    it("rolls over at Singapore midnight, not UTC midnight", () => {
      const justBefore = new Date("2026-07-28T15:59:59Z"); // 23:59:59 SGT 28th
      const justAfter = new Date("2026-07-28T16:00:00Z"); // 00:00:00 SGT 29th

      expect(startOfDayInTimeZone(justBefore).toISOString()).toBe(
        "2026-07-27T16:00:00.000Z"
      );
      expect(startOfDayInTimeZone(justAfter).toISOString()).toBe(
        "2026-07-28T16:00:00.000Z"
      );
    });

    it("does NOT roll over at UTC midnight", () => {
      // This is the regression that broke reporting: on a UTC server a naive
      // setHours(0,0,0,0) would treat these two as different days.
      const beforeUtcMidnight = new Date("2026-07-27T23:59:00Z"); // 07:59 SGT 28th
      const afterUtcMidnight = new Date("2026-07-28T00:01:00Z"); // 08:01 SGT 28th

      expect(startOfDayInTimeZone(beforeUtcMidnight).toISOString()).toBe(
        startOfDayInTimeZone(afterUtcMidnight).toISOString()
      );
    });

    it("honours an explicit non-default timezone", () => {
      const instant = new Date("2026-07-28T00:30:00Z");
      expect(startOfDayInTimeZone(instant, "UTC").toISOString()).toBe(
        "2026-07-28T00:00:00.000Z"
      );
    });
  });

  describe("endOfDayInTimeZone", () => {
    it("is exactly 24 hours after the start of the same day", () => {
      const instant = new Date("2026-07-28T00:30:00Z");
      const start = startOfDayInTimeZone(instant);
      const end = endOfDayInTimeZone(instant);

      expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
      expect(end.toISOString()).toBe("2026-07-28T16:00:00.000Z");
    });
  });

  describe("hourInTimeZone", () => {
    it("returns the Singapore hour, not the UTC hour", () => {
      // 01:00 UTC is 09:00 in Singapore — the exact off-by-eight that made
      // every casual employee read as unavailable in production.
      expect(hourInTimeZone(new Date("2026-07-28T01:00:00Z"))).toBe(9);
      expect(hourInTimeZone(new Date("2026-07-28T09:00:00Z"))).toBe(17);
    });

    it("handles the midnight wrap", () => {
      expect(hourInTimeZone(new Date("2026-07-28T16:00:00Z"))).toBe(0);
    });

    it("honours an explicit timezone", () => {
      expect(hourInTimeZone(new Date("2026-07-28T01:00:00Z"), "UTC")).toBe(1);
    });
  });

  describe("dayOfWeekInTimeZone", () => {
    it("returns the Singapore weekday", () => {
      // 2026-07-28 is a Tuesday (2)
      expect(dayOfWeekInTimeZone(new Date("2026-07-28T01:00:00Z"))).toBe(2);
    });

    it("returns the NEXT day for a late-UTC instant that is already tomorrow in Singapore", () => {
      // 2026-07-28T17:00Z is Wednesday 01:00 SGT
      expect(dayOfWeekInTimeZone(new Date("2026-07-28T17:00:00Z"))).toBe(3);
      // ...whereas UTC still says Tuesday.
      expect(dayOfWeekInTimeZone(new Date("2026-07-28T17:00:00Z"), "UTC")).toBe(2);
    });
  });

  describe("toDateTimeLocalValue", () => {
    // The regression: the edit dialog was filled with toISOString().slice(0,16),
    // which is the UTC wall clock, while the input parses its value as local.
    // Every save therefore shifted the task by the UTC offset, compounding.
    it("round-trips exactly through Date, in whatever timezone the test runs", () => {
      const instants = [
        new Date("2026-07-28T09:00:00Z"),
        new Date("2026-07-28T17:30:00Z"),
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-12-31T23:59:00Z"),
      ];

      for (const instant of instants) {
        const parsedBack = new Date(toDateTimeLocalValue(instant));
        const truncatedToMinute = new Date(instant);
        truncatedToMinute.setSeconds(0, 0);

        expect(parsedBack.getTime()).toBe(truncatedToMinute.getTime());
      }
    });

    it("produces the local wall clock, not the UTC one", () => {
      const instant = new Date("2026-07-28T09:00:00Z");
      const value = toDateTimeLocalValue(instant);

      expect(value).toBe(
        `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, "0")}-` +
          `${String(instant.getDate()).padStart(2, "0")}T` +
          `${String(instant.getHours()).padStart(2, "0")}:` +
          `${String(instant.getMinutes()).padStart(2, "0")}`
      );

      // On any machine not running UTC, the old approach disagrees — which is
      // precisely the bug. On a UTC machine both agree and there is nothing to
      // assert, which is why this never failed in CI or on a UTC server.
      if (instant.getTimezoneOffset() !== 0) {
        expect(value).not.toBe(instant.toISOString().slice(0, 16));
      }
    });

    it("emits the exact format a datetime-local input requires", () => {
      const value = toDateTimeLocalValue(new Date("2026-03-05T04:07:00Z"));
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });

    it("zero-pads single-digit months, days, hours and minutes", () => {
      // Build from local parts so the assertion holds in any timezone.
      const d = new Date(2026, 2, 5, 4, 7); // 5 March 2026, 04:07 local
      expect(toDateTimeLocalValue(d)).toBe("2026-03-05T04:07");
    });
  });

  describe("localDateInTimeZone", () => {
    it("returns the Singapore date, not the UTC date", () => {
      // 23:59 UTC on the 27th is already 07:59 on the 28th in Singapore.
      expect(localDateInTimeZone(new Date("2026-07-27T23:59:00Z"))).toBe("2026-07-28");
    });

    it("does not roll over until Singapore midnight", () => {
      expect(localDateInTimeZone(new Date("2026-07-28T15:59:00Z"))).toBe("2026-07-28");
      expect(localDateInTimeZone(new Date("2026-07-28T16:00:00Z"))).toBe("2026-07-29");
    });

    it("zero-pads month and day", () => {
      expect(localDateInTimeZone(new Date("2026-03-05T04:00:00Z"))).toBe("2026-03-05");
    });

    it("honours an explicit timezone", () => {
      expect(localDateInTimeZone(new Date("2026-07-27T23:59:00Z"), "UTC")).toBe(
        "2026-07-27"
      );
    });
  });

  describe("utcOffsetLabel", () => {
    it("returns +08:00 for Singapore", () => {
      expect(utcOffsetLabel(new Date("2026-07-28T00:00:00Z"))).toBe("+08:00");
    });

    it("returns +00:00 for UTC", () => {
      expect(utcOffsetLabel(new Date("2026-07-28T00:00:00Z"), "UTC")).toBe("+00:00");
    });

    it("signs negative offsets correctly", () => {
      // New York in July is UTC-4.
      expect(utcOffsetLabel(new Date("2026-07-28T00:00:00Z"), "America/New_York")).toBe(
        "-04:00"
      );
    });

    it("handles a half-hour offset", () => {
      expect(utcOffsetLabel(new Date("2026-07-28T00:00:00Z"), "Asia/Kolkata")).toBe(
        "+05:30"
      );
    });
  });

  describe("timeOfDayInTimeZone", () => {
    it("returns the Singapore wall clock, not the UTC one", () => {
      // This is the comparison that broke eligibility: a 09:00 Singapore shift
      // read as "01:00" on a UTC server and fell outside every 09:00-17:00
      // availability window, so every casual employee looked unavailable.
      expect(timeOfDayInTimeZone(new Date("2026-07-29T01:00:00Z"))).toBe("09:00");
      expect(timeOfDayInTimeZone(new Date("2026-07-29T09:00:00Z"))).toBe("17:00");
    });

    it("zero-pads to the HH:MM format availability is stored in", () => {
      expect(timeOfDayInTimeZone(new Date("2026-07-28T20:05:00Z"))).toBe("04:05");
      expect(timeOfDayInTimeZone(new Date("2026-07-28T16:00:00Z"))).toBe("00:00");
    });

    it("sorts correctly as a string, which is how the window check compares", () => {
      const start = timeOfDayInTimeZone(new Date("2026-07-29T01:00:00Z")); // 09:00
      const end = timeOfDayInTimeZone(new Date("2026-07-29T09:00:00Z")); // 17:00

      expect(start < end).toBe(true);
      expect(start >= "09:00").toBe(true);
      expect(end <= "17:00").toBe(true);
    });

    it("honours an explicit timezone", () => {
      expect(timeOfDayInTimeZone(new Date("2026-07-29T01:00:00Z"), "UTC")).toBe("01:00");
    });
  });

  describe("millisecond precision", () => {
    // Regression: the offset was computed from an Intl-formatted wall clock,
    // which only goes down to seconds. The dropped milliseconds made every
    // derived boundary late by that amount, so a day started at 00:00:00.123
    // and an assignment clocked in at exactly midnight fell outside it — which
    // is precisely how a work-rule test began reporting zero hours worked.
    it("startOfDayInTimeZone returns an exact midnight, whatever the input ms", () => {
      for (const iso of [
        "2026-07-28T18:00:10.123Z",
        "2026-07-28T16:00:00.999Z",
        "2026-07-29T03:45:59.001Z",
      ]) {
        const start = startOfDayInTimeZone(new Date(iso));
        expect(start.getUTCMilliseconds()).toBe(0);
        expect(start.getUTCSeconds()).toBe(0);
      }
    });

    it("includes an instant falling exactly on the day boundary", () => {
      const withMs = new Date("2026-07-28T18:00:10.123Z"); // 02:00:10.123 SGT
      const dayStart = startOfDayInTimeZone(withMs);
      const exactlyMidnight = new Date("2026-07-28T16:00:00.000Z"); // 00:00 SGT

      expect(exactlyMidnight.getTime()).toBe(dayStart.getTime());
      expect(exactlyMidnight < dayStart).toBe(false);
    });

    it("keeps the day exactly 24 hours long regardless of input ms", () => {
      const d = new Date("2026-07-28T18:00:10.123Z");
      expect(
        endOfDayInTimeZone(d).getTime() - startOfDayInTimeZone(d).getTime()
      ).toBe(24 * 60 * 60 * 1000);
    });

    it("is unaffected in the other helpers", () => {
      const d = new Date("2026-07-28T18:00:10.123Z"); // 02:00:10.123 SGT
      expect(hourInTimeZone(d)).toBe(2);
      expect(timeOfDayInTimeZone(d)).toBe("02:00");
      expect(localDateInTimeZone(d)).toBe("2026-07-29");
    });
  });
});
