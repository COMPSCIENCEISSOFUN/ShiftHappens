/**
 * Chart palette — the record of what was validated, and why each ramp differs.
 *
 * The colours themselves live in `globals.css` as custom properties, because a
 * hand-rolled chart uses inline styles and an inline style cannot respond to
 * the `.dark` class. This file is the reasoning and the receipts.
 *
 * ## Three ramps, because there are three jobs
 *
 * - **Categorical** encodes *identity* — which series is which. Manual,
 *   AI-suggested and auto-scheduled are three unrelated things; reordering
 *   them changes nothing, so they get three distinct hues in a fixed order.
 * - **Ordinal** encodes *position in a sequence*. Free → Pro → Enterprise is a
 *   ladder, so reordering it WOULD change the meaning. It takes one hue in
 *   three lightness steps, and the reader sees the order in the colour without
 *   reading the legend. Giving tiers three unrelated hues would throw that
 *   away.
 * - **Sequential** encodes *magnitude*. The coverage heatmap is "how many
 *   staff", so it is one hue, light to dark, with the lightest step allowed to
 *   recede toward the surface — near-zero coverage should look like nearly
 *   nothing.
 *
 * Using one set of colours for all three jobs is the single most common way a
 * dashboard becomes unreadable.
 *
 * ## Validator results
 *
 * Run against the palette validator rather than eyeballed, in both modes:
 *
 * - Categorical (3 slots), all-pairs:
 *     light — lightness band PASS, chroma PASS, CVD worst pair ΔE 9.2 (deutan),
 *             normal-vision worst ΔE 24.0, contrast WARN on the aqua at 2.74:1
 *     dark  — all five checks PASS, CVD worst ΔE 9.4, normal-vision ΔE 20.9
 *
 *   The light-mode contrast WARN is not dismissable: it obliges a second way to
 *   read the value. Every categorical chart here ships direct labels AND a
 *   screen-reader table, which is that relief.
 *
 * - Ordinal (tiers, 3 steps): all checks PASS in both modes — monotone
 *   lightness, adjacent ΔL ≥ 0.06, light end 2.06:1 light / 2.15:1 dark.
 *
 * - Sequential (heatmap, 5 steps): monotone lightness PASS, adjacent ΔL PASS.
 *   The validator's ordinal light-end gate is deliberately not applied — for a
 *   sequential ramp the lightest step is *meant* to sit near the surface.
 *
 * ## Rules worth not relearning
 *
 * Categorical hues are assigned in fixed order and never cycled. A fourth
 * series does not get a generated hue — under colour-blind simulation a
 * generated hue is indistinguishable from one already in use.
 *
 * "Unrecorded" is not a series. It takes the neutral, so an absence of data can
 * never be mistaken for a category that competes with the real ones.
 *
 * Text never wears the series colour. Values and labels stay in the normal ink
 * tokens; the coloured mark beside them carries the identity.
 */

/** Identity. Fixed order — index 0 is always the first series. */
export const CATEGORICAL = [
  "var(--chart-cat-1)",
  "var(--chart-cat-2)",
  "var(--chart-cat-3)",
] as const;

/** Absence of data. Never a categorical slot. */
export const NEUTRAL = "var(--chart-neutral)";

/** Order. Light to dark — index 0 is the lowest rung. */
export const ORDINAL = [
  "var(--chart-ord-1)",
  "var(--chart-ord-2)",
  "var(--chart-ord-3)",
] as const;

/** Magnitude. Index 0 means "none" and is nearly the surface. */
export const SEQUENTIAL = [
  "var(--chart-seq-0)",
  "var(--chart-seq-1)",
  "var(--chart-seq-2)",
  "var(--chart-seq-3)",
  "var(--chart-seq-4)",
  "var(--chart-seq-5)",
] as const;

/** Recessive track behind a meter or bar. */
export const TRACK = "var(--chart-track)";

/**
 * Buckets a value onto the sequential ramp.
 *
 * Zero is pinned to index 0 rather than scaled, so "nobody available" is always
 * the same colour regardless of how busy the rest of the week is. Without that
 * pin, an empty hour in a quiet week and a well-staffed hour in a busy one can
 * end up the same shade.
 */
export function sequentialStep(value: number, max: number): string {
  if (value <= 0 || max <= 0) return SEQUENTIAL[0];
  const steps = SEQUENTIAL.length - 1;
  const index = Math.min(steps, Math.max(1, Math.ceil((value / max) * steps)));
  return SEQUENTIAL[index];
}
