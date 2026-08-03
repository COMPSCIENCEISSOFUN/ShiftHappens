/**
 * Tests for Fallback Ranker
 * Verifies the weighted multi-factor scoring algorithm
 * used when AI providers are unavailable.
 */
import { describe, it, expect } from "vitest";
import { FallbackRanker } from "@/services/fallback-ranker";
import type { StaffCandidate } from "@/services/ai-provider";

describe("FallbackRanker", () => {
  it("ranks candidates by weighted score", () => {
    const candidates: StaffCandidate[] = [
      {
        membershipId: "m1",
        name: "Alex",
        hoursWorkedToday: 6,
        maxHours: 8,
        certifications: [],
        availableHours: "Mon 09:00-17:00",
        departmentHistory: 0,
      },
      {
        membershipId: "m2",
        name: "Jamie",
        hoursWorkedToday: 0,
        maxHours: 8,
        certifications: ["Food Safety", "First Aid"],
        availableHours: "Mon 09:00-17:00",
        departmentHistory: 5,
      },
      {
        membershipId: "m3",
        name: "Taylor",
        hoursWorkedToday: 2,
        maxHours: 8,
        certifications: ["Food Safety"],
        availableHours: "Mon 08:00-18:00",
        departmentHistory: 12,
      },
    ];

    const ranked = FallbackRanker.rank(candidates);

    expect(ranked).toHaveLength(3);
    expect(ranked[0].membershipId).toBe("m2");
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].membershipId).toBe("m3");
    expect(ranked[1].rank).toBe(2);
    expect(ranked[2].membershipId).toBe("m1");
    expect(ranked[2].rank).toBe(3);
  });

  it("returns empty for no candidates", () => {
    const ranked = FallbackRanker.rank([]);
    expect(ranked).toHaveLength(0);
  });

  it("gives higher score to staff with fewer hours", () => {
    const candidates: StaffCandidate[] = [
      {
        membershipId: "m1",
        name: "Overworked",
        hoursWorkedToday: 7,
        maxHours: 8,
        certifications: ["Food Safety"],
        availableHours: "Mon 09:00-17:00",
        departmentHistory: 5,
      },
      {
        membershipId: "m2",
        name: "Fresh",
        hoursWorkedToday: 0,
        maxHours: 8,
        certifications: ["Food Safety"],
        availableHours: "Mon 09:00-17:00",
        departmentHistory: 5,
      },
    ];

    const ranked = FallbackRanker.rank(candidates);

    expect(ranked[0].membershipId).toBe("m2");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("includes score breakdown in explanation", () => {
    const candidates: StaffCandidate[] = [
      {
        membershipId: "m1",
        name: "Test Staff",
        hoursWorkedToday: 2,
        maxHours: 8,
        certifications: ["Food Safety"],
        availableHours: "Mon 09:00-17:00",
        departmentHistory: 3,
      },
    ];

    const ranked = FallbackRanker.rank(candidates);

    expect(ranked[0].explanation).toContain("Test Staff");
    expect(ranked[0].explanation).toContain("Score breakdown");
    expect(ranked[0].explanation).toContain("workload balance");
    expect(ranked[0].explanation).toContain("certification breadth");
  });

  it("changes ranking order when organization priorities change", () => {
    const candidates: StaffCandidate[] = [
      {
        membershipId: "fresh",
        name: "Fresh Starter",
        hoursWorkedToday: 0,
        maxHours: 8,
        certifications: [],
        availableHours: "Not set",
        departmentHistory: 0,
      },
      {
        membershipId: "experienced",
        name: "Experienced Worker",
        hoursWorkedToday: 8,
        maxHours: 8,
        certifications: [],
        availableHours: "Not set",
        departmentHistory: 20,
      },
    ];

    const workloadFirst = FallbackRanker.rank(candidates, {
      workloadBalance: 100,
      availabilityFit: 0,
      certificationBreadth: 0,
      departmentExperience: 0,
    });
    const experienceFirst = FallbackRanker.rank(candidates, {
      workloadBalance: 0,
      availabilityFit: 0,
      certificationBreadth: 0,
      departmentExperience: 100,
    });

    expect(workloadFirst[0].membershipId).toBe("fresh");
    expect(experienceFirst[0].membershipId).toBe("experienced");
    expect(experienceFirst[0].explanation).toContain("department experience 100% x 100");
    expect(experienceFirst[0].explanation).not.toContain("workload balance");
  });
});
