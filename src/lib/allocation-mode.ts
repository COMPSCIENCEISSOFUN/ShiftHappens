/**
 * How much of the allocation decision the system is allowed to make, and the
 * rule that reconciles what the organisation ASKED for with what its plan
 * includes.
 *
 * ## The three modes
 *
 *   manual     — a human picks, and the system says only that cover is needed.
 *   suggested  — a human picks, shown the engine's ranking.
 *   auto       — the engine picks, and assigns.
 *
 * ## Why the stored value is not the answer
 *
 * `CompanySettings.allocationMode` records a preference. As of 2026-08-14
 * ranking is `smart_suggestions` and deciding is `auto_allocation`, both above
 * Free — so an organisation that was on Pro, chose `auto`, and later
 * downgraded still has `"auto"` in its settings row and must not still get the
 * behaviour.
 *
 * Two ways to handle that, and only one of them is safe. Rewriting the column
 * on downgrade loses the preference, so an organisation that upgrades again
 * silently comes back on `manual` and has to notice and re-choose. Resolving
 * it on READ keeps the preference intact and makes the plan the thing that
 * decides — which is also the only version that cannot be defeated by a
 * settings row written before the gate existed, by a hand-applied migration,
 * or by a webhook that changed the tier and did not think about this column.
 *
 * ## Why it steps down rather than falling to manual
 *
 * A plan that includes ranking but not automation should get ranking. The
 * ladder is ordered, so each missing feature costs exactly one rung:
 * `auto` without `auto_allocation` becomes `suggested`, and `suggested`
 * without `smart_suggestions` becomes `manual`. Free lacks both and therefore
 * lands on `manual` from any starting point, which is the positioning —
 * Free is manual allocation.
 *
 * Pure and DB-free so it can be unit-tested against every combination, and so
 * the decision is stated once rather than re-derived at each of the five
 * places that used to read the column directly.
 */

export const ALLOCATION_MODES = ["manual", "suggested", "auto"] as const;
export type AllocationMode = (typeof ALLOCATION_MODES)[number];

/** What the plan permits the engine to do. */
export interface AllocationEntitlements {
  /** `auto_allocation` — the engine may assign. */
  auto: boolean;
  /** `smart_suggestions` — the engine may rank. */
  suggestions: boolean;
}

/**
 * The mode actually in force.
 *
 * @param stored the raw `CompanySettings.allocationMode` value. Anything
 *   unrecognised is treated as `manual` — the safe end. A row holding a
 *   value this file does not know about must not fall through to the auto
 *   branch and put somebody on a rota by background job, which is the failure
 *   `findCover` kept its legacy `"manual"` branch to avoid.
 */
export function effectiveAllocationMode(
  stored: string | null | undefined,
  entitlements: AllocationEntitlements
): AllocationMode {
  const requested: AllocationMode = ALLOCATION_MODES.includes(
    stored as AllocationMode
  )
    ? (stored as AllocationMode)
    : "manual";

  if (requested === "auto" && !entitlements.auto) {
    return entitlements.suggestions ? "suggested" : "manual";
  }
  if (requested === "suggested" && !entitlements.suggestions) {
    return "manual";
  }
  return requested;
}

/**
 * Is the stored preference being held back by the plan?
 *
 * For the settings screen, which should say "you asked for auto, your plan
 * gives you manual" rather than silently showing a radio button that does not
 * describe what happens.
 */
export function isAllocationModeDowngraded(
  stored: string | null | undefined,
  entitlements: AllocationEntitlements
): boolean {
  return (
    ALLOCATION_MODES.includes(stored as AllocationMode) &&
    effectiveAllocationMode(stored, entitlements) !== stored
  );
}
