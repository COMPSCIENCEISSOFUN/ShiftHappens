/**
 * Algorithmic Staff Ranker (Control Layer)
 *
 * The engine's deterministic opinion about who should take a shift. Used when
 * every AI provider fails, and on the paths that deliberately never call one —
 * so it is not a degraded mode, it is the answer the product can always give.
 */
import type { StaffCandidate, RankedStaff } from "./ai-provider";
import { pinnedExperienceFloor } from "@/lib/ranking-inputs";
import {
  DEFAULT_WEIGHTS,
  normaliseWeights,
  type RankingWeights,
} from "@/lib/ranking-weights";

/** What a dimension returns when it has nothing to distinguish anybody by. */
const NEUTRAL = 50;

/**
 * Put a provider's rankings into the order it claimed.
 *
 * The models return `rank` and `score` on each entry but emit the ARRAY in
 * whatever order they felt like, and nothing sorted it. `autoAllocate` then did
 * `rankings.slice(0, headcount)` — taking whoever happened to be listed first
 * and storing `allocationRank: 1` against them regardless of what the model
 * actually said. On a shift needing two people out of five, that is the wrong
 * two, recorded as the engine's top picks, feeding a dashboard that asks
 * whether the engine's top picks work out.
 *
 * `FallbackRanker.rank` already sorts its own output, so this only ever
 * reorders provider results — and applying it to both keeps one guarantee for
 * every caller: the array is the ranking.
 *
 * Rank ascending first, because that is the model's stated intent. Score
 * descending breaks ties, and the original index breaks those, so the result is
 * deterministic even when a model returns the same rank for everybody — which
 * `ordering-determinism` exists to stop happening silently elsewhere.
 */
export function byRank<T extends { rank: number; score: number }>(
  rankings: readonly T[]
): T[] {
  return rankings
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        a.entry.rank - b.entry.rank ||
        b.entry.score - a.entry.score ||
        a.index - b.index
    )
    .map(({ entry }) => entry);
}

export class FallbackRanker {
  /** Matches the `name` on the AI providers, so provenance reads the same way. */
  static readonly name_ = "algorithmic" as const;

  /**
   * Ranks candidates on four weighted dimensions.
   *
   * `weights` defaults to the organisation's previous hardcoded values, so a
   * caller that has not been updated ranks exactly as it always did.
   */
  static rank(
    candidates: StaffCandidate[],
    weights: RankingWeights = DEFAULT_WEIGHTS
  ): RankedStaff[] {
    if (candidates.length === 0) return [];

    const w = normaliseWeights(weights);

    const scored = candidates.map((c) => {
      const hoursScore = this.scoreHours(c.hoursWorkedToday, c.maxHours);
      const certScore = this.scoreCertifications(c.certificationRelevance);
      const deptScore = this.scoreDepartmentExperience(
        c.departmentHistory,
        c.pinnedSeniority
      );
      const availScore = this.scoreAvailability(c.availabilityFit);

      const totalScore = Math.round(
        hoursScore * w.workload +
          availScore * w.availability +
          certScore * w.certifications +
          deptScore * w.department
      );

      const reasons: string[] = [];
      if (c.hoursWorkedToday === 0) {
        reasons.push("fresh (0h worked)");
      } else {
        reasons.push(`${c.hoursWorkedToday}h worked today`);
      }
      if (c.availabilityFit === null || c.availabilityFit === undefined) {
        reasons.push("availability fit not applicable");
      } else {
        reasons.push(`${Math.round(c.availabilityFit * 100)}% availability fit`);
      }
      if (c.certificationRelevance === null || c.certificationRelevance === undefined) {
        reasons.push("no certifications required here");
      } else {
        reasons.push(
          `${Math.round(c.certificationRelevance * 100)}% of the certs this department needs`
        );
      }
      if (c.departmentHistory > 0) {
        reasons.push(`${c.departmentHistory}x dept experience`);
      }

      return {
        membershipId: c.membershipId,
        score: totalScore,
        explanation: `${c.name}: ${reasons.join(", ")}. Score breakdown: hours ${hoursScore}, availability ${availScore}, certs ${certScore}, experience ${deptScore}.`,
      };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.map((s, i) => ({
      membershipId: s.membershipId,
      rank: i + 1,
      score: s.score,
      explanation: s.explanation,
    }));
  }

  /**
   * Hours score: fewer hours = higher score.
   * Someone at or over the limit scores 0 — they should not be picked.
   */
  private static scoreHours(hoursWorked: number, maxHours: number): number {
    if (maxHours <= 0) return NEUTRAL;
    const used = Math.min(1, Math.max(0, hoursWorked / maxHours));
    return Math.round((1 - used) * 100);
  }

  /**
   * How much of what this department's work calls for the member holds.
   *
   * `null` when the department requires nothing — a real state, and one where
   * the honest answer is that this dimension has no opinion rather than a
   * number derived from counting unrelated certificates.
   */
  private static scoreCertifications(relevance: number | null | undefined): number {
    if (relevance === null || relevance === undefined) return NEUTRAL;
    return Math.round(Math.min(1, Math.max(0, relevance)) * 100);
  }

  /**
   * Department experience: more completed shifts here = higher score.
   * Bucketed rather than linear — the difference between 0 and 3 shifts matters
   * far more than the difference between 40 and 43.
   */
  private static scoreDepartmentExperience(
    history: number,
    pinnedSeniority?: string | null
  ): number {
    const earned =
      history === 0 ? 30 : history <= 3 ? 60 : history <= 10 ? 80 : 100;

    /*
     * A manager's pin is a floor, never a ceiling.
     *
     * The count is blind to experience gained somewhere else, which is the one
     * case the pin exists for. Taking the higher of the two means an external
     * hire marked Senior stops being ranked as a novice, while somebody who has
     * since earned a higher count keeps it.
     */
    const floor = pinnedExperienceFloor(pinnedSeniority);
    return floor === null ? earned : Math.max(earned, floor);
  }

  /**
   * How tightly the member's free window wraps the shift.
   *
   * 1 is an exact match and scores 100; somebody free all week for a four-hour
   * shift scores about 17. `null` means unknowable — a shift with no scheduled
   * time — and is neutral for everybody rather than silently reordering them.
   */
  private static scoreAvailability(fit: number | null | undefined): number {
    if (fit === null || fit === undefined) return NEUTRAL;
    return Math.round(Math.min(1, Math.max(0, fit)) * 100);
  }
}
