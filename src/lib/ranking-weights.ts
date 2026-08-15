/**
 * How much each dimension counts when the engine ranks candidates.
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
 * The same ratios, expressed as whole numbers totalling exactly 100.
 *
 * ## Why the settings screen needs this on load
 *
 * That panel shows two numbers per row: the percentage beside the label, which
 * is `asPercentages` and therefore always a SHARE, and the slider handle, which
 * is the raw stored value. Editing the screen keeps them identical, because
 * every save writes a rebalanced set totalling 100 — so they only come apart on
 * data that arrived some other way.
 *
 * They can, though, and legitimately: the ranker normalises, so 30/25/25/20 and
 * 60/50/50/40 rank identically and the library deliberately permits both. A set
 * stored as the latter would open the panel with labels reading 30/25/25/20,
 * handles sitting at 60/50/50/40 — two of them jammed against the cap — and a
 * header saying "Total 200%". Nothing would rank wrongly; the screen would
 * simply be arguing with itself, with no way to tell which half to believe.
 *
 * Converting on the way in removes the possibility rather than papering over
 * it: after this the raw values ARE the shares.
 *
 * ## Why not just `asPercentages`
 *
 * It rounds each key independently, so three equal weights give 33/33/33 and a
 * header reading 99%. Here the remainder is handed to the keys with the largest
 * fractional parts — the standard largest-remainder method — rather than dumped
 * on a fixed key, which would quietly favour the same dimension every time.
 */
export function asWholePercentages(weights: RankingWeights): RankingWeights {
  const normalised = normaliseWeights(weights);

  const exact = WEIGHT_KEYS.map((key) => ({
    key,
    value: normalised[key] * 100,
  }));
  const floors = exact.map((e) => ({ ...e, floor: Math.floor(e.value) }));
  const remainder = 100 - floors.reduce((sum, e) => sum + e.floor, 0);

  // Ties settle by the catalogue's own order, so the result is deterministic
  // rather than dependent on the sort's stability.
  const order = [...floors].sort(
    (a, b) =>
      b.value - b.floor - (a.value - a.floor) ||
      WEIGHT_KEYS.indexOf(a.key) - WEIGHT_KEYS.indexOf(b.key)
  );

  const result = {} as RankingWeights;
  floors.forEach((e) => {
    result[e.key] = e.floor;
  });
  for (let i = 0; i < remainder; i++) {
    result[order[i % order.length].key] += 1;
  }

  return result;
}

/**
 * Move one priority and absorb the difference across the others, keeping the
 * total at exactly 100.
 *
 * ## Why the screen needs this at all
 *
 * The weights are ratios — the ranker normalises them, so 30/25/25/20 and
 * 60/50/50/40 rank identically, and that is why "they need not total 100" is
 * true rather than merely reassuring. But four sliders that each move
 * independently make the ONE question an admin is actually asking — "how much
 * does this matter compared to the rest?" — unanswerable without arithmetic,
 * because dragging workload from 30 to 60 changes availability's real share
 * from 25% to 19% while its slider still reads 25.
 *
 * Holding the total at 100 makes the number on each slider its actual share.
 *
 * ## The rules it has to respect
 *
 * `MAX_SHARE` caps any single dimension, so the moved value is clamped before
 * anything is redistributed — otherwise the screen would let somebody build a
 * set that `weightsProblem` then refuses on save, which is a worse experience
 * than not letting them drag that far.
 *
 * The remainder is shared in proportion to what the OTHERS already held, so
 * their relative order survives: if availability mattered twice as much as
 * department before, it still does afterwards. Splitting it equally would
 * quietly flatten priorities the admin had set.
 *
 * When the others are all at zero there is no proportion to preserve, so the
 * remainder is spread evenly — the only case where this invents a preference,
 * and it beats leaving the total below 100 or refusing the drag.
 *
 * Rounding is settled on the LAST key rather than by rounding each share, so
 * the total is exactly 100 and never 99 or 101 from four independent rounds.
 */
export function rebalanceWeights(
  weights: RankingWeights,
  moved: WeightKey,
  value: number
): RankingWeights {
  const capped = Math.max(0, Math.min(Math.round(MAX_SHARE * 100), Math.round(value)));
  const others = WEIGHT_KEYS.filter((k) => k !== moved);
  const remainder = 100 - capped;
  const othersTotal = others.reduce((sum, k) => sum + Math.max(0, weights[k]), 0);

  const result = { ...weights, [moved]: capped } as RankingWeights;

  let allocated = 0;
  others.forEach((key, i) => {
    const isLast = i === others.length - 1;
    if (isLast) {
      result[key] = remainder - allocated;
      return;
    }
    const share =
      othersTotal > 0
        ? (Math.max(0, weights[key]) / othersTotal) * remainder
        : remainder / others.length;
    result[key] = Math.round(share);
    allocated += result[key];
  });

  return result;
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
