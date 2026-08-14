// @vitest-environment node
/**
 * The whole plan matrix, asserted explicitly rather than derived.
 *
 * Every other test in this area checks one feature against one tier. This one
 * states the entire grid in one place, so a change to `TIER_CONFIG` has to be
 * deliberate: adding a feature to Pro without deciding what Free and
 * Enterprise do with it fails here, not in production.
 *
 * The rule being pinned:
 *   Free        — no gated feature at all
 *   Pro         — everything except priority support
 *   Enterprise  — everything
 *
 * The grid grew by six on 2026-08-14, when the smart/automation family moved
 * above Free: ranked suggestions, automatic allocation, natural-language task
 * creation, the weekly auto-schedule, advanced analytics and Projects. Free's
 * row is unchanged — it was already empty — which is the point of stating it
 * as an explicit list rather than deriving it.
 *
 * `priority_support` is the one entry with no code path behind it, and that is
 * correct: it is a response-time commitment, not a route. It is listed anyway
 * because the pricing page sells it, and a row that is sold but absent from the
 * tier config would show a ✓ nobody honours.
 */
import { describe, it, expect } from "vitest";
import {
  GATED_FEATURES,
  isFeatureAvailable,
  type GatedFeature,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";

const EXPECTED: Record<SubscriptionTier, GatedFeature[]> = {
  free: [],
  pro: [
    "custom_roles",
    "pdf_export",
    "mass_import",
    "audit_log",
    "assistant",
    "calendar_sync",
    "smart_suggestions",
    "auto_allocation",
    "ai_task_create",
    "auto_schedule",
    "advanced_analytics",
    "projects",
  ],
  enterprise: [
    "custom_roles",
    "pdf_export",
    "mass_import",
    "audit_log",
    "priority_support",
    "assistant",
    "calendar_sync",
    "smart_suggestions",
    "auto_allocation",
    "ai_task_create",
    "auto_schedule",
    "advanced_analytics",
    "projects",
  ],
};

describe("what each plan includes", () => {
  for (const [tier, granted] of Object.entries(EXPECTED) as [
    SubscriptionTier,
    GatedFeature[],
  ][]) {
    it(`grants exactly the intended features on ${tier}`, () => {
      const actual = GATED_FEATURES.filter((feature) =>
        isFeatureAvailable(tier, feature)
      );
      expect([...actual].sort()).toEqual([...granted].sort());
    });
  }

  it("gives Free nothing that is gated", () => {
    for (const feature of GATED_FEATURES) {
      expect(isFeatureAvailable("free", feature)).toBe(false);
    }
  });

  it("gives Enterprise everything that is gated", () => {
    for (const feature of GATED_FEATURES) {
      expect(isFeatureAvailable("enterprise", feature)).toBe(true);
    }
  });

  it("separates Pro from Enterprise by priority support alone", () => {
    const proOnly = GATED_FEATURES.filter(
      (f) => isFeatureAvailable("enterprise", f) && !isFeatureAvailable("pro", f)
    );
    expect(proOnly).toEqual(["priority_support"]);
  });
});
