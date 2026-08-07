/**
 * How much each dimension counts when the engine ranks candidates.
 *
 * ## Why this exists now
 *
 * `CompanySettings.smartAllocationWeights` has been on the schema since the
 * settings migration and was read by NOTHING — not a service, not a route, not
 * a test. Meanwhile `FallbackRanker` hardcoded the four numbers the column
 * names. So the data model advertised a tunable allocation engine and the
 * engine ignored it.
 *
 * ## Relative, not absolute
 *
 * Nothing here requires the four to sum to 100. Ranking depends only on the
 * RATIO between them — 30/25/25/20 and 60/50/50/40 produce identical orders —
 * so they are normalised at the point of use. That matters for the UI: four
 * sliders that must total a constant fight the person moving them, because
 * every adjustment demands arithmetic on the other three.
 *
 * Everything in this file is pure, so the rules can be tested without a
 * database and reused by both the Boundary (validating a form) and the Control
 * layer (ranking).
 */

export interface RankingWeights {
  /** Fewer hours already committed this week scores higher. */
  workload: number;
  /** How tightly the member's declared window wraps the shift. */
  availability: number;
  /** Holding the certifications this department's work actually calls for. */
  certifications: number;
  /** Completed shifts in the task's department. */
  department: number;
}

export const WEIGHT_KEYS = [
  "workload",
  "availability",
  "certifications",
  "department",
] as const;

export type WeightKey = (typeof WEIGHT_KEYS)[number];

/**
 * What the ranker used before the column was wired up.
 *
 * Kept as the default so switching the feature on changes nobody's rankings
 * until they deliberately move a slider — a settings screen that silently
 * reshuffles every roster the moment it ships is not a feature anybody asked
 * for.
 */
export const DEFAULT_WEIGHTS: RankingWeights = {
  workload: 30,
  availability: 25,
  certifications: 25,
  department: 20,
};

/** Labels for the settings screen. Presentation vocabulary, stated once. */
export const WEIGHT_LABELS: Record<WeightKey, string> = {
  workload: "Workload balance",
  availability: "Availability fit",
  certifications: "Certification relevance",
  department: "Department experience",
};

export const WEIGHT_DESCRIPTIONS: Record<WeightKey, string> = {
  workload: "Prefer people with fewer hours already booked this week",
  availability: "Prefer people whose free window closely matches the shift",
  certifications: "Prefer people holding the certifications this department needs",
  department: "Prefer people who have worked in this department before",
};

/** No single dimension may exceed this share once normalised. */
export const MAX_SHARE = 0.7;

/**
 * Prefix every weights refusal carries.
 *
 * The route has to tell "this input was rejected" (400) from "something broke"
 * (500), and matching on the message text is how that goes wrong: the first
 * attempt used /priorit/i, which caught two of the three messages and let the
 * third — the dominant-dimension one — fall through to a 500. An explicit
 * marker cannot drift as the wording does.
 */
export const WEIGHTS_ERROR_PREFIX = "Ranking priorities:";

/**
 * Reads the stored JSON, falling back to the defaults on anything unusable.
 *
 * Deliberately forgiving. The column is a free-form string that predates any
 * validation, so it may hold null, old shapes, or hand-edited nonsense — and a
 * ranking engine that throws because a settings row is malformed is worse than
 * one that quietly uses sensible numbers. Per-key: a missing or invalid entry
 * takes its default rather than discarding the whole object, so a partial
 * write does not silently reset the three keys that were fine.
 */
export function parseWeights(stored: string | null | undefined): RankingWeights {
  if (!stored) return { ...DEFAULT_WEIGHTS };

  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_WEIGHTS };

  const source = raw as Record<string, unknown>;
  const result = { ...DEFAULT_WEIGHTS };
  for (const key of WEIGHT_KEYS) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      result[key] = value;
    }
  }

  // All zeroes would make every candidate score zero and the order arbitrary.
  if (WEIGHT_KEYS.every((k) => result[k] === 0)) return { ...DEFAULT_WEIGHTS };
  return result;
}

/**
 * The weights as fractions summing to 1.
 *
 * This is what makes "they need not total 100" true rather than merely stated:
 * the ranker multiplies by these, so any set of positive numbers behaves the
 * same as the equivalent percentages.
 */
export function normaliseWeights(weights: RankingWeights): RankingWeights {
  const total = WEIGHT_KEYS.reduce((sum, k) => sum + Math.max(0, weights[k]), 0);
  if (total <= 0) return normaliseWeights(DEFAULT_WEIGHTS);
  return WEIGHT_KEYS.reduce(
    (acc, k) => ({ ...acc, [k]: Math.max(0, weights[k]) / total }),
    {} as RankingWeights
  );
}

/** The same values as whole percentages, for display. */
export function asPercentages(weights: RankingWeights): Record<WeightKey, number> {
  const normalised = normaliseWeights(weights);
  return WEIGHT_KEYS.reduce(
    (acc, k) => ({ ...acc, [k]: Math.round(normalised[k] * 100) }),
    {} as Record<WeightKey, number>
  );
}

/**
 * Why a set of weights is unusable, or null if it is fine.
 *
 * Only two things are actually refused. Everything non-negative ranks
 * *somehow*, so the bar is "does this produce a meaningful order", not "does it
 * look tidy":
 *
 *  - all zeroes gives every candidate the same score, making the order
 *    arbitrary and the screen a lie;
 *  - one dimension above {@link MAX_SHARE} of the total collapses the ranking
 *    onto a single factor, which is a state somebody reaches by dragging one
 *    slider to the end without realising the others stopped mattering.
 */
export function weightsProblem(weights: RankingWeights): string | null {
  if (WEIGHT_KEYS.some((k) => !Number.isFinite(weights[k]) || weights[k] < 0)) {
    return "Priorities must be zero or more";
  }
  const total = WEIGHT_KEYS.reduce((sum, k) => sum + weights[k], 0);
  if (total <= 0) return "At least one priority must be above zero";

  const dominant = WEIGHT_KEYS.find((k) => weights[k] / total > MAX_SHARE);
  if (dominant) {
    return `${WEIGHT_LABELS[dominant]} would decide almost every ranking on its own — keep it under ${Math.round(
      MAX_SHARE * 100
    )}% of the total`;
  }
  return null;
}

/**
 * The priorities as a sentence for the AI prompt.
 *
 * The models cannot multiply by 0.30 — they reason in language — so they are
 * TOLD the ordering rather than bound by it. That difference is real and the
 * settings screen says so; stating it here too keeps the two descriptions from
 * drifting.
 *
 * Ordered strongest first, and a dimension weighted zero is omitted entirely
 * rather than listed as "0% important", which reads as a hint to consider it.
 */
export function describeWeightsForPrompt(weights: RankingWeights): string {
  const pct = asPercentages(weights);
  const ranked = WEIGHT_KEYS.filter((k) => pct[k] > 0).sort(
    (a, b) => pct[b] - pct[a]
  );
  if (ranked.length === 0) return "";
  return ranked.map((k) => `${WEIGHT_LABELS[k]} (${pct[k]}%)`).join(" > ");
}
