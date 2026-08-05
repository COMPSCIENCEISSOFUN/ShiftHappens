import { describe, expect, it } from "vitest";
import { intersectsCalendarDay, positionForCalendarDay } from "@/lib/calendar-timeline";

const multiDayTask = {
  scheduledStart: new Date(2026, 7, 10, 9),
  scheduledEnd: new Date(2026, 7, 12, 17),
};

describe("calendar timeline", () => {
  it("shows a multi-day task on every day it occupies", () => {
    expect(intersectsCalendarDay(multiDayTask, new Date(2026, 7, 10))).toBe(true);
    expect(intersectsCalendarDay(multiDayTask, new Date(2026, 7, 11))).toBe(true);
    expect(intersectsCalendarDay(multiDayTask, new Date(2026, 7, 12))).toBe(true);
    expect(intersectsCalendarDay(multiDayTask, new Date(2026, 7, 13))).toBe(false);
  });

  it("clamps a continuing task to the visible operating day", () => {
    expect(positionForCalendarDay(multiDayTask, new Date(2026, 7, 11), 6, 22)).toEqual({ top: "0%", height: "100%" });
  });

  it("does not render work outside operating hours as a stray block", () => {
    expect(positionForCalendarDay({ scheduledStart: new Date(2026, 7, 10, 1), scheduledEnd: new Date(2026, 7, 10, 3) }, new Date(2026, 7, 10), 6, 22)).toBeNull();
  });
});
