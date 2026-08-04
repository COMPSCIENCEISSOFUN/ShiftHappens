import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXPERIENCED_THRESHOLD,
  DEFAULT_SENIOR_THRESHOLD,
  SENIORITY_LEVELS,
  assessSeniority,
  isAtLeast,
  isAtMost,
  isSeniorityLevel,
  levelFromShiftCount,
  seniorityLabel,
  seniorityRank,
} from "@/lib/seniority";

const DEFAULTS = {
  experiencedShiftThreshold: DEFAULT_EXPERIENCED_THRESHOLD,
  seniorShiftThreshold: DEFAULT_SENIOR_THRESHOLD,
};

describe("seniority ordering", () => {
  it("orders junior below experienced below senior", () => {
    expect(seniorityRank("junior")).toBeLessThan(seniorityRank("experienced"));
    expect(seniorityRank("experienced")).toBeLessThan(seniorityRank("senior"));
  });

  it("isAtLeast includes the level itself", () => {
    expect(isAtLeast("experienced", "experienced")).toBe(true);
    expect(isAtLeast("senior", "experienced")).toBe(true);
    expect(isAtLeast("junior", "experienced")).toBe(false);
  });

  it("isAtMost includes the level itself", () => {
    expect(isAtMost("junior", "junior")).toBe(true);
    expect(isAtMost("junior", "experienced")).toBe(true);
    expect(isAtMost("senior", "experienced")).toBe(false);
  });

  // The bug this guards: implementing "at most X" as !isAtLeast(X) moves the
  // boundary a level, so an "at most 1 junior" rule starts counting
  // experienced staff as juniors. Both functions must include the level
  // itself, which makes them overlap rather than partition.
  it("both bounds hold at the level itself, so neither negates the other", () => {
    expect(isAtLeast("junior", "junior")).toBe(true);
    expect(isAtMost("junior", "junior")).toBe(true);

    expect(isAtLeast("experienced", "junior")).toBe(true);
    expect(isAtMost("experienced", "junior")).toBe(false);
  });
});

describe("levelFromShiftCount", () => {
  it("is junior below the experienced threshold", () => {
    expect(levelFromShiftCount(0, DEFAULTS)).toBe("junior");
    expect(levelFromShiftCount(9, DEFAULTS)).toBe("junior");
  });

  it("promotes exactly at each threshold, not one past it", () => {
    expect(levelFromShiftCount(10, DEFAULTS)).toBe("experienced");
    expect(levelFromShiftCount(39, DEFAULTS)).toBe("experienced");
    expect(levelFromShiftCount(40, DEFAULTS)).toBe("senior");
  });

  it("keeps senior reachable when thresholds are inverted", () => {
    const inverted = { experiencedShiftThreshold: 40, seniorShiftThreshold: 10 };
    expect(levelFromShiftCount(10, inverted)).toBe("senior");
    expect(levelFromShiftCount(9, inverted)).toBe("junior");
  });

  it("treats equal thresholds as reaching senior", () => {
    expect(levelFromShiftCount(5, { experiencedShiftThreshold: 5, seniorShiftThreshold: 5 })).toBe(
      "senior"
    );
  });

  it("treats a zero or negative threshold as unreachable", () => {
    expect(levelFromShiftCount(0, { experiencedShiftThreshold: 0, seniorShiftThreshold: 0 })).toBe(
      "junior"
    );
    expect(levelFromShiftCount(3, { experiencedShiftThreshold: -1, seniorShiftThreshold: -1 })).toBe(
      "junior"
    );
  });
});

describe("assessSeniority", () => {
  it("derives from the count when no override is set", () => {
    const result = assessSeniority({
      override: null,
      completedShifts: 23,
      thresholds: DEFAULTS,
      departmentName: "Kitchen",
    });

    expect(result.level).toBe("experienced");
    expect(result.overridden).toBe(false);
    expect(result.explanation).toBe("Experienced — 23 completed shifts in Kitchen");
  });

  it("omits the department when counted org-wide", () => {
    const result = assessSeniority({ override: null, completedShifts: 2, thresholds: DEFAULTS });
    expect(result.explanation).toBe("Junior — 2 completed shifts");
    expect(result.scopeDepartmentId).toBeNull();
  });

  it("singularises a single shift", () => {
    const result = assessSeniority({ override: null, completedShifts: 1, thresholds: DEFAULTS });
    expect(result.explanation).toBe("Junior — 1 completed shift");
  });

  // The whole reason the override column exists: an experienced external hire
  // has no history here, and derivation alone would keep them off the shifts
  // that would build it.
  it("lets an override beat a count that would say junior", () => {
    const result = assessSeniority({
      override: "senior",
      completedShifts: 0,
      thresholds: DEFAULTS,
      departmentName: "Kitchen",
    });

    expect(result.level).toBe("senior");
    expect(result.overridden).toBe(true);
    expect(result.explanation).toBe("Senior — set by a manager");
  });

  it("lets an override lower the level too", () => {
    const result = assessSeniority({
      override: "junior",
      completedShifts: 100,
      thresholds: DEFAULTS,
    });
    expect(result.level).toBe("junior");
  });

  it("keeps the underlying count visible even when overridden", () => {
    const result = assessSeniority({
      override: "senior",
      completedShifts: 4,
      thresholds: DEFAULTS,
    });
    expect(result.completedShifts).toBe(4);
  });

  it("ignores an unrecognised override rather than trusting it", () => {
    const result = assessSeniority({
      override: "principal",
      completedShifts: 12,
      thresholds: DEFAULTS,
    });

    expect(result.level).toBe("experienced");
    expect(result.overridden).toBe(false);
  });

  it("treats an empty-string override as absent", () => {
    const result = assessSeniority({ override: "", completedShifts: 50, thresholds: DEFAULTS });
    expect(result.level).toBe("senior");
    expect(result.overridden).toBe(false);
  });
});

describe("labels", () => {
  it("names every level", () => {
    for (const level of SENIORITY_LEVELS) {
      expect(seniorityLabel(level)).not.toBe("Unrated");
    }
  });

  it("reports an absent level rather than rendering blank", () => {
    expect(seniorityLabel(null)).toBe("Unrated");
    expect(seniorityLabel(undefined)).toBe("Unrated");
  });

  it("shows an unrecognised value verbatim", () => {
    expect(seniorityLabel("principal")).toBe("principal");
  });

  it("isSeniorityLevel accepts only the defined levels", () => {
    expect(isSeniorityLevel("senior")).toBe(true);
    expect(isSeniorityLevel("Senior")).toBe(false);
    expect(isSeniorityLevel("")).toBe(false);
  });
});
