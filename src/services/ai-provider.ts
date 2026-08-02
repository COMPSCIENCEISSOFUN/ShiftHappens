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
  availableHours: string;
  departmentHistory: number;
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
      scheduledStart: string | null;
      scheduledEnd: string | null;
      requiredHeadcount: number;
    },
    candidates: StaffCandidate[]
  ): Promise<RankedStaff[]>;
}