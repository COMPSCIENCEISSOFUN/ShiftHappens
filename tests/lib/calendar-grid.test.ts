/**
 * Tests for the calendar's time-grid geometry.
 *
 * This arithmetic used to live inline in the calendar page's JSX, where the
 * project has no way to test it — there is no component-render harness, so
 * anything expressed as markup is verified only by looking at it. Extracting it
 * is what makes the following possible to assert at all, and the bugs it fixes
 * are exactly the kind that survive a visual check:
 *
 *   - A 22:00–06:00 shift computed `endHour - startHour` = 6 − 22 = −16, a
 *     NEGATIVE height, which was clamped to a 2% sliver and pinned to the
 *     bottom edge of the grid. It looked like a rendering smudge, not a shift.
 *   - Only tasks whose START date matched the column were drawn, so the part of
 *     an overnight shift that fell on the following day was simply absent.
 *
 * Fixtures are stated in Singapore wall-clock time so the suite gives the same
 * answers under TZ=Asia/Singapore and TZ=UTC.
 */
import { describe, it, expect } from "vitest";
import {
  currentTimePosition,
  gridHoursFor,
  gridRows,
  taskBlockPosition,
} from "@/lib/calendar-grid";

function sgt(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

function task(startIso: string, endIso: string) {
  return { scheduledStart: sgt(startIso), scheduledEnd: sgt(endIso) };
}

const MON = "2026-03-09";
const TUE = "2026-03-10";

describe("gridRows", () => {
  it("numbers rows from the day boundary, not from midnight", () => {
    const rows = gridRows(6, 4);
    expect(rows.map((r) => r.clockHour)).toEqual([6, 7, 8, 9]);
  });

  it("wraps past midnight and flags the day change", () => {
    // The flag the coverage heat map needs: a 02:00 row in Friday's column is
    // Saturday's coverage, and reading Friday's would be silently wrong.
    const rows = gridRows(22, 5);
    expect(rows.map((r) => r.clockHour)).toEqual([22, 23, 0, 1, 2]);
    expect(rows.map((r) => r.dayOffset)).toEqual([0, 0, 1, 1, 1]);
  });

  it("produces one row per hour requested", () => {
    expect(gridRows(0, 24)).toHaveLength(24);
  });

  it("keeps clock hours inside 0–23 for every boundary", () => {
    for (let startHour = 0; startHour <= 23; startHour++) {
      for (const row of gridRows(startHour, 24)) {
        expect(row.clockHour).toBeGreaterThanOrEqual(0);
        expect(row.clockHour).toBeLessThanOrEqual(23);
      }
    }
  });
});

describe("gridHoursFor", () => {
  const dates = [sgt(`${MON}T12:00`)];

  it("uses the operating window when nothing falls outside it", () => {
    expect(gridHoursFor(dates, [task(`${MON}T09:00`, `${MON}T17:00`)], 6, 16)).toBe(16);
  });

  it("returns the window for an empty calendar", () => {
    expect(gridHoursFor(dates, [], 6, 16)).toBe(16);
  });

  it("grows to cover a shift that runs past closing", () => {
    // 06:00 boundary, task ends 23:30 → 17.5 hours from the boundary, rounded
    // up. Without this the last hour and a half of the shift is invisible.
    expect(gridHoursFor(dates, [task(`${MON}T20:00`, `${MON}T23:30`)], 6, 16)).toBe(18);
  });

  it("grows to cover a shift running into the small hours", () => {
    // 22:00 Monday to 04:00 Tuesday, boundary 06:00: the whole shift is still
    // Monday's business day, ending 22 hours after the boundary.
    expect(gridHoursFor(dates, [task(`${MON}T22:00`, `${TUE}T04:00`)], 6, 16)).toBe(22);
  });

  it("never exceeds a full day", () => {
    // A week-long task must not stretch one column to 168 hours; it continues
    // into the next column instead.
    expect(gridHoursFor(dates, [task(`${MON}T08:00`, `2026-03-16T08:00`)], 6, 16)).toBe(24);
  });

  it("never shrinks below the operating window", () => {
    expect(gridHoursFor(dates, [task(`${MON}T07:00`, `${MON}T08:00`)], 6, 16)).toBe(16);
  });

  it("ignores tasks on other days", () => {
    expect(gridHoursFor(dates, [task(`2026-03-14T02:00`, `2026-03-14T05:00`)], 6, 16)).toBe(16);
  });

  it("ignores unscheduled tasks rather than throwing", () => {
    const unscheduled = { scheduledStart: null, scheduledEnd: null };
    expect(gridHoursFor(dates, [unscheduled], 6, 16)).toBe(16);
  });

  it("takes the largest requirement across several days", () => {
    const week = [sgt(`${MON}T12:00`), sgt(`${TUE}T12:00`)];
    const tasks = [
      task(`${MON}T09:00`, `${MON}T17:00`),
      task(`${TUE}T20:00`, `${TUE}T23:00`), // needs 17 hours from a 06:00 start
    ];
    expect(gridHoursFor(week, tasks, 6, 16)).toBe(17);
  });
});

describe("taskBlockPosition", () => {
  const date = sgt(`${MON}T12:00`);

  it("places a shift proportionally within the column", () => {
    // Boundary 06:00, grid 16 hours. A 10:00–14:00 shift starts 4 hours in and
    // lasts 4 hours: a quarter of the way down, a quarter tall.
    const block = taskBlockPosition(task(`${MON}T10:00`, `${MON}T14:00`), date, 6, 16)!;
    expect(block.topPercent).toBeCloseTo(25, 5);
    expect(block.heightPercent).toBeCloseTo(25, 5);
  });

  it("gives an overnight shift a POSITIVE height", () => {
    // The original bug, stated directly. 22:00–02:00 once produced −16 hours.
    const block = taskBlockPosition(task(`${MON}T22:00`, `${TUE}T02:00`), date, 6, 24)!;
    expect(block.heightPercent).toBeGreaterThan(0);
    expect(block.heightPercent).toBeCloseTo((4 / 24) * 100, 5);
  });

  it("starts at the top of the column for a shift already in progress", () => {
    // Tuesday's column, boundary 06:00, for a shift that began Monday 22:00 and
    // runs to Tuesday 10:00. Tuesday sees 06:00–10:00, drawn from the very top.
    const block = taskBlockPosition(
      task(`${MON}T22:00`, `${TUE}T10:00`),
      sgt(`${TUE}T12:00`),
      6,
      16
    )!;
    expect(block.topPercent).toBe(0);
    expect(block.continuesBefore).toBe(true);
    expect(block.continuesAfter).toBe(false);
  });

  it("marks a shift that runs past the end of the column", () => {
    const block = taskBlockPosition(
      task(`${MON}T22:00`, `${TUE}T10:00`),
      date,
      6,
      24
    )!;
    expect(block.continuesBefore).toBe(false);
    expect(block.continuesAfter).toBe(true);
  });

  it("appears in BOTH columns it touches", () => {
    // The behaviour that replaces "belongs to the day it starts". Neither piece
    // may be missing, or a night shift vanishes from one of the two days it is
    // actually worked.
    const overnight = task(`${MON}T22:00`, `${TUE}T10:00`);
    expect(taskBlockPosition(overnight, sgt(`${MON}T12:00`), 6, 24)).not.toBeNull();
    expect(taskBlockPosition(overnight, sgt(`${TUE}T12:00`), 6, 24)).not.toBeNull();
  });

  it("returns null for a day the task does not touch", () => {
    expect(
      taskBlockPosition(task(`${MON}T09:00`, `${MON}T17:00`), sgt(`2026-03-13T12:00`), 6, 16)
    ).toBeNull();
  });

  it("returns null rather than a zero-height block when the task merely touches the boundary", () => {
    // A shift ending exactly at 06:00 belongs to the previous business day and
    // must not leave an invisible artefact at the top of this one — it would
    // still take a slot in the overlap layout and narrow every real block
    // beside it.
    expect(
      taskBlockPosition(task(`${MON}T02:00`, `${MON}T06:00`), date, 6, 16)
    ).toBeNull();
  });

  it("returns null for an unscheduled task", () => {
    expect(
      taskBlockPosition({ scheduledStart: null, scheduledEnd: null }, date, 6, 16)
    ).toBeNull();
  });

  it("returns null for an unparseable date rather than rendering NaN%", () => {
    expect(
      taskBlockPosition({ scheduledStart: "not a date", scheduledEnd: "also not" }, date, 6, 16)
    ).toBeNull();
  });

  it("accepts ISO strings as well as Dates", () => {
    // The page holds tasks as JSON, so the string path is the one that actually
    // runs in production.
    const fromStrings = taskBlockPosition(
      {
        scheduledStart: sgt(`${MON}T10:00`).toISOString(),
        scheduledEnd: sgt(`${MON}T14:00`).toISOString(),
      },
      date,
      6,
      16
    )!;
    expect(fromStrings.topPercent).toBeCloseTo(25, 5);
  });

  it("keeps every block inside the column", () => {
    const cases = [
      task(`${MON}T06:00`, `${MON}T22:00`),
      task(`${MON}T22:00`, `${TUE}T04:00`),
      task(`${MON}T05:00`, `${MON}T09:00`),
      task(`${MON}T08:00`, `2026-03-16T08:00`),
    ];
    for (const t of cases) {
      const block = taskBlockPosition(t, date, 6, 24);
      if (!block) continue;
      expect(block.topPercent).toBeGreaterThanOrEqual(0);
      expect(block.heightPercent).toBeGreaterThan(0);
      expect(block.topPercent + block.heightPercent).toBeLessThanOrEqual(100.0001);
    }
  });
});

describe("currentTimePosition", () => {
  it("places the now-line proportionally", () => {
    // 14:00 with a 06:00 boundary and a 16-hour grid: 8 hours in, halfway.
    expect(currentTimePosition(sgt(`${MON}T14:00`), 6, 16)).toBeCloseTo(50, 5);
  });

  it("is null before the grid opens", () => {
    expect(currentTimePosition(sgt(`${MON}T05:00`), 6, 16)).toBeNull();
  });

  it("is null after the grid closes", () => {
    expect(currentTimePosition(sgt(`${MON}T23:00`), 6, 16)).toBeNull();
  });

  it("is zero exactly on the boundary", () => {
    expect(currentTimePosition(sgt(`${MON}T06:00`), 6, 16)).toBe(0);
  });

  it("shows the small hours when the grid has been extended to cover them", () => {
    // 02:00 belongs to the previous business day under a 06:00 boundary, and is
    // 20 hours into it — visible only because the grid was extended past the
    // operating window.
    expect(currentTimePosition(sgt(`${TUE}T02:00`), 6, 24)).toBeCloseTo((20 / 24) * 100, 5);
  });
});
