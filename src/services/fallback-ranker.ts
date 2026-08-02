/**
 * Fallback Staff Ranker (Control Layer)
 * 
 * Algorithmic staff ranking used when all AI providers fail.
 * Scores candidates across four weighted dimensions:
 * 
 * 1. Hours utilization (30%) — fewer hours worked = higher score
 * 2. Availability fit (25%) — tighter schedule match = higher score
 * 3. Certifications (25%) — more relevant certs = higher score
 * 4. Department experience (20%) — more experience = higher score
 * 
 * This ensures the system provides intelligent recommendations
 * even without AI, making the platform resilient and independently useful.
 */
import type { StaffCandidate, RankedStaff } from "./ai-provider";

export class FallbackRanker {
  /** Matches the `name` on the AI providers, so provenance reads the same way. */
  static readonly name_ = "algorithmic" as const;

  /**
   * Ranks candidates using a weighted multi-factor scoring algorithm.
   * Each factor produces a 0-100 score, then weighted and combined.
   */
  static rank(candidates: StaffCandidate[]): RankedStaff[] {
    if (candidates.length === 0) return [];

    const scored = candidates.map((c) => {
      const hoursScore = this.scoreHours(c.hoursWorkedToday, c.maxHours);
      const certScore = this.scoreCertifications(c.certifications);
      const deptScore = this.scoreDepartmentExperience(c.departmentHistory);
      const availScore = this.scoreAvailability(c.availableHours);

      // Weighted combination
      const totalScore = Math.round(
        hoursScore * 0.30 +
        availScore * 0.25 +
        certScore * 0.25 +
        deptScore * 0.20
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
        explanation: `${c.name}: ${reasons.join(", ")}. Score breakdown: hours ${hoursScore}, availability ${availScore}, certs ${certScore}, experience ${deptScore}.`,
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