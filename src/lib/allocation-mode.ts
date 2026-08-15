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
