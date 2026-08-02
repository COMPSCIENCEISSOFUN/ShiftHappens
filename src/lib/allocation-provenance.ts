/**
 * Allocation provenance — how an assignment came to exist.
 *
 * The engine ranks candidates, scores them, explains itself, and then the
 * assignment is written with none of that attached. So "does the smart engine
 * work?" had no answer: you could not tell an AI-chosen assignment from one a
 * manager picked by hand, nor a Groq ranking from the algorithmic fallback
 * that runs when Groq is down.
 *
 * These four values are recorded at the moment of assignment. They are a
 * snapshot, deliberately: the engine's opinion is only meaningful next to what
 * it knew at the time, and re-deriving it later is impossible because hours,
 * certifications and availability have all moved on.
 */

export const ALLOCATION_SOURCES = [
  "manual",
  "ai_suggested",
  "auto_scheduled",
] as const;

export type AllocationSource = (typeof ALLOCATION_SOURCES)[number];

export const SOURCE_LABEL: Record<AllocationSource, string> = {
  manual: "Manual",
  ai_suggested: "AI suggested",
  auto_scheduled: "Auto-scheduled",
};

/** Shown under a chart, so the distinction is legible without the schema. */
export const SOURCE_DESCRIPTION: Record<AllocationSource, string> = {
  manual: "Chosen from the eligibility list by a person",
  ai_suggested: "The engine's top-ranked candidate for a single task",
  auto_scheduled: "Came from a confirmed week-long generated schedule",
};

export const PROVIDER_LABEL: Record<string, string> = {
  groq: "Groq (Llama 3.1)",
  gemini: "Gemini 2.0 Flash",
  algorithmic: "Algorithmic ranker",
};

/**
 * What a caller hands to `assignStaff` when it knows how the choice was made.
 *
 * `byMembership` is keyed rather than positional because `assignStaff` may
 * reject an individual membership mid-loop; a parallel array would then be
 * off by one and quietly attach the wrong score to the wrong person.
 */
export interface AllocationProvenance {
  source: AllocationSource;
  provider?: string;
  byMembership?: Record<string, { rank?: number; score?: number }>;
}

export function sourceLabel(value: string | null | undefined): string {
  if (!value) return "Unrecorded";
  return SOURCE_LABEL[value as AllocationSource] ?? value;
}

export function providerLabel(value: string | null | undefined): string {
  if (!value) return "Unrecorded";
  return PROVIDER_LABEL[value] ?? value;
}

export function isAllocationSource(value: string): value is AllocationSource {
  return (ALLOCATION_SOURCES as readonly string[]).includes(value);
}
