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
});
