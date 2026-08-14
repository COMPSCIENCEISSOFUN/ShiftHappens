// @vitest-environment node
/**
 * The rule that reconciles the allocation mode an organisation ASKED for with
 * the one its plan includes.
 *
 * Worth its own file because the whole point of `@/lib/allocation-mode` is
 * that the decision is made once, in a pure function, rather than re-derived
 * at each of the five places that used to read `CompanySettings.allocationMode`
 * off the repository. If the ladder is wrong here it is wrong in the cron
 * sweep, the recurring materialiser, the backfill path, the task board and the
 * settings screen simultaneously — so every combination is enumerated rather
 * than sampled.
 */
import { describe, it, expect } from "vitest";
import {
  ALLOCATION_MODES,
  effectiveAllocationMode,
  isAllocationModeDowngraded,
  type AllocationEntitlements,
} from "@/lib/allocation-mode";

/** What each plan tier resolves to, by the two features that matter. */
const FREE: AllocationEntitlements = { auto: false, suggestions: false };
const PAID: AllocationEntitlements = { auto: true, suggestions: true };
/**
 * Ranking but not automation.
 *
 * No tier sells this today — Pro grants both — and it is tested anyway,
 * because the ladder's whole reason for stepping down one rung at a time
 * rather than falling to manual is to answer this case correctly if a plan
 * ever does.
 */
const RANK_ONLY: AllocationEntitlements = { auto: false, suggestions: true };

describe("effectiveAllocationMode", () => {
  it("leaves every mode alone on a plan that includes everything", () => {
    for (const mode of ALLOCATION_MODES) {
      expect(effectiveAllocationMode(mode, PAID)).toBe(mode);
    }
  });

  it("resolves every mode to manual on Free", () => {
    for (const mode of ALLOCATION_MODES) {
      expect(effectiveAllocationMode(mode, FREE)).toBe("manual");
    }
  });

  /*
   * The case the whole file exists for: a Pro organisation that chose `auto`
   * and later downgraded still has `"auto"` in its settings row. Nothing
   * rewrites that column, so this function is the only thing standing between
   * a Free plan and a background job putting people on shifts.
   */
  it("does not let a stored auto preference survive a downgrade", () => {
    expect(effectiveAllocationMode("auto", FREE)).toBe("manual");
  });

  it("steps auto down one rung when only ranking is included", () => {
    expect(effectiveAllocationMode("auto", RANK_ONLY)).toBe("suggested");
    expect(effectiveAllocationMode("suggested", RANK_ONLY)).toBe("suggested");
  });

  /*
   * The safe end, and not merely tidiness. Without the fallback an
   * unrecognised value falls past the "manual" and "suggested" branches in
   * `findCover` and lands on the AUTO path — an organisation that never asked
   * for automatic assignment having somebody rostered by a background job.
   * `findCover` keeps a legacy `"manual"` branch for exactly this reason.
   */
  it.each([null, undefined, "", "AUTO", "automatic", "smart"])(
    "treats %p as manual rather than falling through to auto",
    (stored) => {
      expect(effectiveAllocationMode(stored, PAID)).toBe("manual");
      expect(effectiveAllocationMode(stored, FREE)).toBe("manual");
    }
  );

  it("never returns a mode the entitlements do not support", () => {
    const cases: AllocationEntitlements[] = [FREE, PAID, RANK_ONLY];
    for (const entitlements of cases) {
      for (const mode of [...ALLOCATION_MODES, "nonsense", null]) {
        const resolved = effectiveAllocationMode(mode, entitlements);
        if (resolved === "auto") expect(entitlements.auto).toBe(true);
        if (resolved === "suggested") expect(entitlements.suggestions).toBe(true);
      }
    }
  });
});

describe("isAllocationModeDowngraded", () => {
  it("is false when the plan grants what was asked for", () => {
    for (const mode of ALLOCATION_MODES) {
      expect(isAllocationModeDowngraded(mode, PAID)).toBe(false);
    }
  });

  it("is true for a preference the plan holds back", () => {
    expect(isAllocationModeDowngraded("auto", FREE)).toBe(true);
    expect(isAllocationModeDowngraded("suggested", FREE)).toBe(true);
    expect(isAllocationModeDowngraded("auto", RANK_ONLY)).toBe(true);
  });

  it("is false for manual, which no plan can hold back", () => {
    expect(isAllocationModeDowngraded("manual", FREE)).toBe(false);
  });

  /*
   * An unreadable column is not a downgrade. It resolves to manual like
   * everything else, but reporting it as "your plan is holding your
   * preference back" would send an admin to the billing page over a data
   * problem no upgrade fixes.
   */
  it("does not report an unrecognised stored value as a downgrade", () => {
    expect(isAllocationModeDowngraded("nonsense", FREE)).toBe(false);
    expect(isAllocationModeDowngraded(null, FREE)).toBe(false);
  });
});
