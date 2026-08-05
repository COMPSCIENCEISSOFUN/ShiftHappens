import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOCATION_WEIGHTS,
  normalizeAllocationWeights,
  parseAllocationWeights,
  setAllocationWeight,
} from "@/lib/allocation-weights";

describe("allocation weights", () => {
  it("keeps the editable priority controls at exactly 100%", () => {
    const changed = setAllocationWeight({ workloadBalance: 30, availabilityFit: 25, certificationBreadth: 25, departmentExperience: 20 }, "availabilityFit", 70);
    expect(Object.values(changed).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(changed.availabilityFit).toBe(70);
    expect(Object.values(changed).every((value) => value >= 0 && value <= 100)).toBe(true);
  });
  it("normalizes supported factors to a total of 100", () => {
    expect(
      normalizeAllocationWeights({
        workloadBalance: 1,
        availabilityFit: 1,
        certificationBreadth: 1,
        departmentExperience: 1,
      })
    ).toEqual({
      workloadBalance: 25,
      availabilityFit: 25,
      certificationBreadth: 25,
      departmentExperience: 25,
    });
  });

  it("uses defaults for missing or malformed stored configuration", () => {
    expect(parseAllocationWeights(null)).toEqual(DEFAULT_ALLOCATION_WEIGHTS);
    expect(parseAllocationWeights("not-json")).toEqual(DEFAULT_ALLOCATION_WEIGHTS);
    expect(parseAllocationWeights('{"workloadBalance":-1}')).toEqual(
      DEFAULT_ALLOCATION_WEIGHTS
    );
  });
});
