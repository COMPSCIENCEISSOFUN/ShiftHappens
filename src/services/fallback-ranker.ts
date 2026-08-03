/**
 * Fallback Staff Ranker (Control Layer)
 * 
 * Algorithmic staff ranking used when all AI providers fail.
 * Scores candidates across four organization-weighted dimensions:
 * 
 * 1. Workload balance: fewer hours worked produces a higher score.
 * 2. Availability fit: recorded availability produces a higher score.
 * 3. Certification breadth: more verified certifications produces a higher score.
 * 4. Department experience: more experience produces a higher score.
 * 
 * This ensures the system provides intelligent recommendations
 * even without AI, making the platform resilient and independently useful.
 */
import type { StaffCandidate, RankedStaff } from "./ai-provider";
import {
  ALLOCATION_FACTORS,
  DEFAULT_ALLOCATION_WEIGHTS,
  normalizeAllocationWeights,
  type AllocationWeights,
} from "@/lib/allocation-weights";

export class FallbackRanker {
  /**
   * Ranks candidates using a weighted multi-factor scoring algorithm.
   * Each factor produces a 0-100 score, then weighted and combined.
   */
  static rank(
    candidates: StaffCandidate[],
    weights: AllocationWeights = DEFAULT_ALLOCATION_WEIGHTS
  ): RankedStaff[] {
    if (candidates.length === 0) return [];
    const normalizedWeights = normalizeAllocationWeights(weights);

    const scored = candidates.map((c) => {
      const hoursScore = this.scoreHours(c.hoursWorkedToday, c.maxHours);
      const certScore = this.scoreCertifications(c.certifications);
      const deptScore = this.scoreDepartmentExperience(c.departmentHistory);
      const availScore = this.scoreAvailability(c.availableHours);

      // Weighted combination
      const factorScores: Record<keyof AllocationWeights, number> = {
        workloadBalance: hoursScore,
        availabilityFit: availScore,
        certificationBreadth: certScore,
        departmentExperience: deptScore,
      };
      const totalScore = Math.round(
        ALLOCATION_FACTORS.reduce(
          (total, { key }) =>
            total + factorScores[key] * (normalizedWeights[key] / 100),
          0
        )
      );

      const reasons: string[] = [];
      if (c.hoursWorkedToday === 0) {
        reasons.push("fresh (0h worked)");
      } else {
        reasons.push(`${c.hoursWorkedToday}h worked today`);
      }
      if (c.certifications.length > 0) {
        reasons.push(`${c.certifications.length} cert(s): ${c.certifications.join(", ")}`);
      }
      if (c.departmentHistory > 0) {
        reasons.push(`${c.departmentHistory}x dept experience`);
      }

      return {
        membershipId: c.membershipId,
        name: c.name,
        score: totalScore,
        explanation: `${c.name}: ${reasons.join(", ")}. Score breakdown: ${ALLOCATION_FACTORS
          .filter(({ key }) => normalizedWeights[key] > 0)
          .map(
            ({ key, label }) =>
              `${label.toLowerCase()} ${normalizedWeights[key]}% x ${factorScores[key]}`
          )
          .join(", ")}.`,
      };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Assign ranks
    return scored.map((s, i) => ({
      membershipId: s.membershipId,
      rank: i + 1,
      score: s.score,
      explanation: s.explanation,
    }));
  }

  /**
   * Hours score: fewer hours = higher score.
   * 0 hours = 100, at max = 0, linear interpolation.
   */
  private static scoreHours(hoursWorked: number, maxHours: number): number {
    if (maxHours <= 0) return 50;
    const ratio = hoursWorked / maxHours;
    return Math.round(Math.max(0, (1 - ratio) * 100));
  }

  /**
   * Certification score: more certs = higher score.
   * 0 certs = 20 (baseline), 1 = 60, 2 = 80, 3+ = 100.
   */
  private static scoreCertifications(certs: string[]): number {
    if (certs.length === 0) return 20;
    if (certs.length === 1) return 60;
    if (certs.length === 2) return 80;
    return 100;
  }

  /**
   * Department experience score: more assignments = higher score.
   * 0 = 30 (new is fine), 1-3 = 60, 4-10 = 80, 10+ = 100.
   */
  private static scoreDepartmentExperience(history: number): number {
    if (history === 0) return 30;
    if (history <= 3) return 60;
    if (history <= 10) return 80;
    return 100;
  }

  /**
   * Availability score: based on whether availability is set.
   * "Not set" = 40 (unknown), otherwise = 80 (available).
   */
  private static scoreAvailability(availableHours: string): number {
    if (availableHours === "Not set") return 40;
    return 80;
  }
}
