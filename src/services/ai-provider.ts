/**
 * AI Provider Interface (Control Layer)
 * 
 * Strategy pattern for AI-powered staff allocation.
 * Defines the contract that all AI providers must implement.
 * Allows swapping between Groq, Gemini, or any future provider
 * with a single configuration change.
 */

export interface StaffCandidate {
  membershipId: string;
  name: string;
  hoursWorkedToday: number;
  maxHours: number;
  certifications: string[];
  /** Human-readable summary, for the prompt. Not scored — see `availabilityFit`. */
  availableHours: string;
  departmentHistory: number;
  /**
   * A manager's manual seniority level for this member, or null.
   *
   * Raises the department-experience score to what the equivalent shift count
   * would have scored — see `pinnedExperienceFloor`. Not sent to the providers:
   * the prompt already carries the raw history count, and a second experience
   * number would invite the model to double-count one fact.
   */
  pinnedSeniority?: string | null;
  /**
   * How tightly this member's free window wraps the shift, 0–1.
   *
   * 1 is an exact match; somebody free all week for a four-hour shift is near
   * 0. `null` when it cannot be computed — a task with no scheduled time — in
   * which case the dimension is neutral for everybody rather than guessing.
   *
   * Exists because `availableHours` is a display string, so the only thing the
   * ranker could ask of it was whether it said "Not set". That made a quarter
   * of the score a constant.
   */
  availabilityFit?: number | null;
  /**
   * The share, 0–1, of the certifications this DEPARTMENT's work calls for that
   * this member holds.
   *
   * `null` when the department requires none. Replaces counting certificates,
   * which rewarded irrelevant ones — and since a missing REQUIRED certificate
   * already fails eligibility, counting could only ever measure extras.
   */
  certificationRelevance?: number | null;
}

export interface RankedStaff {
  membershipId: string;
  rank: number;
  score: number;
  explanation: string;
}

/**
 * Which strategy actually produced a ranking.
 *
 * This exists because failover was previously invisible. `rankWithFailover`
 * caught a provider error, wrote it to `console.error`, and moved on — so an
 * expired API key meant the product silently ran on the algorithmic ranker
 * indefinitely, and nothing in the database, the response or the audit log
 * said so. On a serverless host nobody reads those logs.
 *
 * "algorithmic" is not a failure state on its own: FallbackRanker is a real,
 * deliberate strategy. What matters is being able to tell which one ran.
 */
export const AI_PROVIDERS = ["groq", "gemini", "algorithmic"] as const;
export type AIProviderName = (typeof AI_PROVIDERS)[number];

/** A ranking together with the strategy that produced it. */
export interface RankingResult {
  rankings: RankedStaff[];
  provider: AIProviderName;
}

export interface AIProvider {
  /** Identifies this strategy in provenance records. */
  readonly name: AIProviderName;

  /**
   * Ranks eligible staff for a task based on multiple factors.
   * Returns a sorted array with scores and explanations.
   */
  rankStaff(
    task: {
      title: string;
      department: string | null;
      priority: string;
      /**
       * The organisation's ranking priorities, strongest first.
       *
       * The models reason in language, so they are TOLD the ordering rather
       * than bound by it — a language model cannot multiply by 0.30. Without
       * this the configured weights applied only to `FallbackRanker`, which
       * runs when both providers fail: a setting that worked exclusively
       * during an outage.
       */
      priorities?: string;
      scheduledStart: string | null;
      scheduledEnd: string | null;
      requiredHeadcount: number;
    },
    candidates: StaffCandidate[]
  ): Promise<RankedStaff[]>;
}