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
    expect(ranked[0].explanation).toContain("hours");
    expect(ranked[0].explanation).toContain("certs");
  });
});
/**
 * A manager's seniority pin, reaching the ranking.
 *
 * Department experience is counted from shifts worked in that department, which
 * is the right measure and is blind in exactly one case: somebody experienced
 * somewhere else. That is the case the pin exists for — the demo data names
 * them, "an external hire, no local history" — and the pin used to reach
 * composition rules and stop there, so the engine ranked a pinned Senior as a
 * complete novice.
 */
describe("a pinned seniority floors the experience score", () => {
  function candidate(overrides: Partial<StaffCandidate> = {}): StaffCandidate {
    return {
      membershipId: "m1",
      name: "Riley",
      hoursWorkedToday: 0,
      maxHours: 8,
      certifications: [],
      availableHours: "",
      departmentHistory: 0,
      ...overrides,
    };
  }

  // Everything except department experience is identical, so any difference in
  // the score is that dimension and nothing else.
  const onlyDepartment = {
    workload: 0,
    availability: 0,
    certifications: 0,
    department: 100,
  };

  it("ranks a pinned senior above an unpinned newcomer", () => {
    const [first] = FallbackRanker.rank(
      [
        candidate({ membershipId: "newcomer", name: "Newcomer" }),
        candidate({
          membershipId: "external",
          name: "External",
          pinnedSeniority: "senior",
        }),
      ],
      onlyDepartment
    );

    expect(first.membershipId).toBe("external");
  });

  it("scores a pinned senior with no history as if they had earned it", () => {
    const [pinned] = FallbackRanker.rank(
      [candidate({ pinnedSeniority: "senior" })],
      onlyDepartment
    );
    const [veteran] = FallbackRanker.rank(
      [candidate({ departmentHistory: 40 })],
      onlyDepartment
    );

    expect(pinned.score).toBe(veteran.score);
  });

  /*
   * A floor, not a replacement. Somebody pinned "experienced" months ago who
   * has since worked forty shifts here has earned the higher number, and a
   * stale pin must not pull them back down.
   */
  it("never lowers a score somebody has earned", () => {
    const [earned] = FallbackRanker.rank(
      [candidate({ departmentHistory: 40, pinnedSeniority: "experienced" })],
      onlyDepartment
    );
    const [unpinned] = FallbackRanker.rank(
      [candidate({ departmentHistory: 40 })],
      onlyDepartment
    );

    expect(earned.score).toBe(unpinned.score);
  });

  /*
   * Pinning somebody "junior" is not a demotion in the ranking. The bands say
   * how much a person can be trusted with, which is what composition rules act
   * on; using them to push a candidate DOWN the list would be a second meaning
   * nobody asked for.
   */
  it("does not push a junior pin below an unpinned member", () => {
    const [pinned] = FallbackRanker.rank(
      [candidate({ departmentHistory: 5, pinnedSeniority: "junior" })],
      onlyDepartment
    );
    const [unpinned] = FallbackRanker.rank(
      [candidate({ departmentHistory: 5 })],
      onlyDepartment
    );

    expect(pinned.score).toBe(unpinned.score);
  });

  it("ignores a level nobody recognises", () => {
    const [odd] = FallbackRanker.rank(
      [candidate({ pinnedSeniority: "principal_engineer" })],
      onlyDepartment
    );
    const [none] = FallbackRanker.rank([candidate()], onlyDepartment);

    expect(odd.score).toBe(none.score);
  });
});
