/**
 * The two ranking dimensions that did not measure what their names claimed.
 *
 * `scoreAvailability` returned 40 for "Not set" and 80 for anything else. Once
 * availability became a hard eligibility constraint, everyone reaching the
 * ranker had it set — so it returned 80 for EVERY candidate, and a quarter of
 * the score could not change anybody's position. The docblock above it said
 * "tighter schedule match = higher score" the whole time.
 *
 * `scoreCertifications` counted certificates. A missing REQUIRED certificate
 * already fails eligibility, so everyone being ranked holds what the job needs
 * — counting could only ever reward extras, including unrelated ones. Three
 * irrelevant certificates beat the single one the shift asked for. That is
 * worse than the inert dimension: it actively promoted the wrong person at 25%
 * of the score.
 */
import { describe, it, expect } from "vitest";
import {
  availabilityFit,
  certificationRelevance,
  type AvailabilityWindow,
} from "@/lib/ranking-inputs";

/** 14 Aug 2026 is a Friday; 10:00–14:00 UTC is 18:00–22:00 Singapore. */
const SHIFT = {
  start: new Date("2026-08-14T02:00:00.000Z"), // 10:00 SGT
  end: new Date("2026-08-14T06:00:00.000Z"), // 14:00 SGT
};
const FRIDAY = 5;

function window(startTime: string, endTime: string, dayOfWeek = FRIDAY): AvailabilityWindow {
  return { dayOfWeek, startTime, endTime, isAvailable: true };
}

describe("availability fit", () => {
  it("is 1 when the shift fills their whole window", () => {
    expect(availabilityFit([window("10:00", "14:00")], SHIFT)).toBeCloseTo(1, 2);
  });

  it("falls as their window gets wider than the shift", () => {
    const tight = availabilityFit([window("09:00", "15:00")], SHIFT)!;
    const loose = availabilityFit([window("06:00", "22:00")], SHIFT)!;
    expect(tight).toBeGreaterThan(loose);
  });

  /*
   * The behaviour that makes this dimension worth having, and the one the old
   * implementation could not express: two people who are both AVAILABLE are not
   * equally good choices. Spending the constrained one here keeps the flexible
   * one for a gap only they can fill later.
   */
  it("prefers the person with least slack", () => {
    const onlyFreeThen = availabilityFit([window("10:00", "14:00")], SHIFT)!;
    const freeAllDay = availabilityFit([window("00:00", "23:59")], SHIFT)!;
    expect(onlyFreeThen).toBeGreaterThan(freeAllDay);
  });

  /*
   * Full-time staff default to all seven days open, so this lands them below a
   * casual who is free exactly then — the "casuals get placed, full-timers fill
   * the gaps" model arriving through the scoring rather than a rule.
   */
  it("puts an all-week member below a narrowly-available one", () => {
    const casual = availabilityFit([window("18:00", "22:00")], {
      start: new Date("2026-08-14T10:00:00.000Z"), // 18:00 SGT
      end: new Date("2026-08-14T14:00:00.000Z"), // 22:00 SGT
    })!;
    const fullTimer = availabilityFit([window("00:00", "23:59")], {
      start: new Date("2026-08-14T10:00:00.000Z"),
      end: new Date("2026-08-14T14:00:00.000Z"),
    })!;
    expect(casual).toBeGreaterThan(fullTimer);
  });

  it("reads the window for the shift's own weekday", () => {
    const wrongDay = availabilityFit([window("10:00", "14:00", 1)], SHIFT)!;
    const rightDay = availabilityFit([window("10:00", "14:00", FRIDAY)], SHIFT)!;
    expect(rightDay).toBeGreaterThan(wrongDay);
  });

  /*
   * No row means unrestricted, not unavailable — whether they can work it at
   * all was settled by the eligibility layer, and re-deciding it here would
   * apply a rule this file does not own. Maximum slack is the consistent
   * answer, so they rank lowest.
   */
  it("treats a member with no window as fully open", () => {
    const fit = availabilityFit([], SHIFT)!;
    expect(fit).toBeCloseTo(4 / 24, 2);
  });

  it("says nothing when the shift has no time", () => {
    expect(availabilityFit([window("10:00", "14:00")], null)).toBeNull();
  });

  /*
   * A window ending before it starts wraps past midnight — 22:00–06:00 is eight
   * hours, not minus sixteen. This asserted null, because a wrapped window was
   * unstorable and therefore assumed to be corrupt. Now that a night worker can
   * declare one, measuring it as negative would score them against a nonsense
   * window and rank them last for exactly the shifts they exist to cover.
   */
  it("measures a window that runs past midnight as its real length", () => {
    const overnight = availabilityFit([window("22:00", "06:00")], SHIFT)!;
    // Eight hours declared, four-hour shift.
    expect(overnight).toBeCloseTo(4 / 8, 2);
  });

  it("never exceeds 1, even for a shift longer than the window", () => {
    const long = availabilityFit([window("10:00", "11:00")], SHIFT)!;
    expect(long).toBeLessThanOrEqual(1);
  });
});

describe("certification relevance", () => {
  it("is 1 when they hold everything the department needs", () => {
    expect(
      certificationRelevance(["First Aid", "Food Safety"], ["First Aid", "Food Safety"])
    ).toBe(1);
  });

  it("is a share when they hold some", () => {
    expect(
      certificationRelevance(["First Aid"], ["First Aid", "Food Safety"])
    ).toBe(0.5);
  });

  /*
   * The defect this replaced, stated as a test. Counting made three unrelated
   * certificates beat the one the work actually calls for.
   */
  it("ignores certificates the department never asks for", () => {
    const irrelevant = certificationRelevance(
      ["Scuba", "Forklift", "Sommelier"],
      ["First Aid"]
    );
    const relevant = certificationRelevance(["First Aid"], ["First Aid"]);
    expect(relevant).toBeGreaterThan(irrelevant!);
  });

  /*
   * Names are free text typed by whoever uploaded the certificate and by
   * whoever wrote the task, so treating case as meaningful would silently
   * penalise people for somebody else's capitalisation.
   */
  it("matches regardless of case and padding", () => {
    expect(certificationRelevance([" first aid "], ["First Aid"])).toBe(1);
  });

  it("says nothing when the department requires none", () => {
    expect(certificationRelevance(["First Aid"], [])).toBeNull();
  });

  it("is 0 when they hold none of what is needed", () => {
    expect(certificationRelevance([], ["First Aid"])).toBe(0);
  });

  // The same requirement named by several tasks is one requirement.
  it("does not count a duplicated requirement twice", () => {
    expect(
      certificationRelevance(["First Aid"], ["First Aid", "first aid", "FIRST AID"])
    ).toBe(1);
  });
});
