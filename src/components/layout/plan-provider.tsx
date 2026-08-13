/**
 * The organisation's plan, available to any page under `(app)`.
 *
 * ## Why this exists
 *
 * There are two independent gates in this product and only one of them was
 * visible. `PermissionProvider` tells a page what the caller may do;
 * nothing told it what the PLAN allows. So every tier-gated screen enforced
 * correctly on the server and said nothing on the way in:
 *
 *   - Import Members showed its button on a Free organisation, ran the whole
 *     upload-and-column-mapping flow, and refused at submit — after the work.
 *   - The Roles page let a Free organisation compose a role box by box and
 *     refused it on save, having already offered fourteen categories of
 *     checkboxes.
 *   - The Audit Log page loaded and its data request came back 403.
 *
 * The permission-picker fix on the Roles page had already established the house
 * answer for this — grey the control, name the tier — but it applied to
 * individual checkboxes inside one screen. This is the same idea at the level
 * of a page.
 *
 * ## Why the tier comes from the server and the usage does not
 *
 * `tier` is passed down from the `(app)` layout, which has already loaded the
 * organisation for the suspension check. It costs nothing, it is correct on the
 * first paint, and feature availability derives from it through a pure function
 * — so a page never renders its unlocked state and then takes it away.
 *
 * That flicker was real. The sidebar fetched `/subscription` on mount and
 * treated "not answered yet" as "allowed", so Roles and Audit Log appeared in
 * the menu on every page load and then vanished. That fetch is now gone; the
 * sidebar reads the same `tier` this provider does.
 *
 * USAGE COUNTS cannot come the same way. They are five `count()` queries, they
 * change as you work, and putting them in the layout would run them on every
 * page load for the benefit of the two or three pages that show a create
 * button. They are fetched once here instead.
 *
 * ## Why the counts are fetched rather than derived from what a page has
 *
 * The obvious alternative is for the Members page to count its own rows. It
 * would be wrong. `countResource` counts ACTIVE memberships, non-archived
 * departments, and tasks that are neither completed nor cancelled — while the
 * pages hold filtered, searched and sometimes paged lists. A second count that
 * disagreed with the enforced one is precisely the defect
 * `SubscriptionRepository` warns about in its own comment: one number shown,
 * a different one enforced.
 *
 * ## What this is NOT
 *
 * Not a security boundary, for the same reason `PermissionProvider` is not.
 * Every gated route calls `enforceFeatureAccess` or `enforceResourceLimit`
 * itself, and that is what actually refuses. This exists so the product stops
 * offering what it will not do.
 */
"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getMinimumTierForFeature,
  getResourceLimit,
  getTierConfig,
  isFeatureAvailable,
  type GatedFeature,
  type ResourceType,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";

interface PlanContextValue {
  /** The organisation's plan. Correct on the first paint. */
  tier: SubscriptionTier;
  /** Its display name — "Free", "Pro", "Enterprise". */
  tierName: string;
  /** Does this plan include the feature? */
  has: (feature: GatedFeature) => boolean;
  /** The lowest plan that does. Named, because "Enterprise" is actionable. */
  requiredTier: (feature: GatedFeature) => SubscriptionTier;
  /** The cap for a resource on this plan. Null means unlimited. */
  limitFor: (resource: ResourceType) => number | null;
  /**
   * How many exist now, or null while the count is still in flight.
   *
   * Null is a third state and callers must treat it as such — see `atLimit`.
   */
  usageOf: (resource: ResourceType) => number | null;
  /**
   * Is the organisation at its cap?
   *
   * FALSE while the count is unknown, deliberately. A create button that
   * started disabled and enabled itself a moment later would be worse than one
   * that is briefly optimistic: the server refuses either way, with a message
   * naming the limit and the upgrade.
   */
  atLimit: (resource: ResourceType) => boolean;
}

/**
 * Default is the FREE tier with no usage.
 *
 * A page rendered outside the provider — a test, a future layout — shows the
 * most restricted plan rather than the least. The opposite default would turn a
 * wiring mistake into an unlocked product.
 */
const PlanContext = createContext<PlanContextValue | null>(null);

export function PlanProvider({
  orgId,
  tier,
  children,
}: {
  orgId?: string;
  tier: SubscriptionTier;
  children: ReactNode;
}) {
  /*
   * The server's answer for both halves, not just the count.
   *
   * The limit used to be computed here from the tier alone, which was true
   * until quota could be bought on top of it. An organisation that had paid for
   * extra projects would then be shown "1 of 1 — limit reached" beside a button
   * the server would have happily accepted: the UI enforcing a stricter rule
   * than the API, against the customer, on the thing they had just paid for.
   *
   * `getUsage` already folds the add-on in, so the fix is to believe it.
   */
  const [usage, setUsage] = useState<Partial<
    Record<ResourceType, { current: number; limit?: number | null }>
  > | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;

    (async () => {
      try {
        /*
         * `no-store`, because a cached answer here contradicts the page it is
         * rendered beside.
         *
         * The TIER arrives with the layout, server-rendered and always fresh.
         * The usage arrives from this fetch. When the browser served a cached
         * copy from before an upgrade, the two disagreed on screen — the
         * Projects page told an Enterprise organisation that "Projects are part
         * of Pro" and then, in the next sentence, that it was on Enterprise,
         * because the heading came from the stale limit and the sentence from
         * the live tier.
         *
         * This response is a snapshot of counts that change constantly and is
         * cheap to recompute; there was never anything to gain by caching it.
         */
        const res = await fetch(`/api/organizations/${orgId}/subscription`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data?.resources) return;
        const counts: Partial<
          Record<ResourceType, { current: number; limit?: number | null }>
        > = {};
        for (const [resource, value] of Object.entries(data.resources)) {
          const served = value as { current: number; limit?: number | null };
          counts[resource as ResourceType] = {
            current: served.current,
            /*
             * Carried through as-is, including `undefined`. The three states
             * are distinct and collapsing any two of them is a bug: a number
             * is the cap, `null` is unlimited, and ABSENT means the response
             * did not say — which must fall back to the tier rather than
             * default to unlimited. Coalescing absent to null would let a
             * truncated or partial payload silently uncap every screen.
             */
            limit: served.limit,
          };
        }
        setUsage(counts);
      } catch {
        /*
         * Left null, which reads as "unknown" everywhere downstream and so
         * never disables anything. A create button that stopped working
         * because a usage panel failed to load would be a worse outcome than
         * one that lets the server give the real answer.
         */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const value = useMemo<PlanContextValue>(() => {
    /*
     * The served limit when the usage call has answered, the tier's baseline
     * before it has. Presence is tested rather than `??`, because `null` is a
     * legitimate served value meaning UNLIMITED — coalescing it would quietly
     * reimpose the tier cap on an Enterprise organisation.
     */
    const limitFor = (resource: ResourceType) => {
      const served = usage?.[resource];
      return served && served.limit !== undefined
        ? served.limit
        : getResourceLimit(tier, resource);
    };
    const usageOf = (resource: ResourceType) => usage?.[resource]?.current ?? null;

    return {
      tier,
      tierName: getTierConfig(tier).displayName,
      has: (feature) => isFeatureAvailable(tier, feature),
      requiredTier: (feature) => getMinimumTierForFeature(feature),
      limitFor,
      usageOf,
      atLimit: (resource) => {
        const limit = limitFor(resource);
        if (limit === null) return false;
        const current = usageOf(resource);
        return current !== null && current >= limit;
      },
    };
  }, [tier, usage]);

  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan(): PlanContextValue {
  const context = useContext(PlanContext);
  if (context) return context;

  /*
   * Outside a provider, answer as the Free tier with nothing counted. Built
   * here rather than as a module constant so `getTierConfig` is not called at
   * import time in files that never render a plan-gated control.
   */
  return {
    tier: "free",
    tierName: getTierConfig("free").displayName,
    has: (feature) => isFeatureAvailable("free", feature),
    requiredTier: (feature) => getMinimumTierForFeature(feature),
    limitFor: (resource) => getResourceLimit("free", resource),
    usageOf: () => null,
    atLimit: () => false,
  };
}
