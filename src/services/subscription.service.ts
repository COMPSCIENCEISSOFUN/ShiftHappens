/**
 * SubscriptionService — Control layer for subscription tier enforcement.
 * Provides limit checking, feature gating, and usage reporting.
 *
 * Usage in other services:
 *   await this.subscriptionService.enforceResourceLimit(orgId, 'departments');
 *   await this.subscriptionService.enforceFeatureAccess(orgId, 'audit_log');
 *
 * Usage in API routes / UI:
 *   const usage = await subscriptionService.getUsage(orgId);
 *   const canExport = await subscriptionService.canUseFeature(orgId, 'pdf_export');
 */

import { SubscriptionRepository } from '@/repositories/subscription.repository';
import {
  type SubscriptionTier,
  type ResourceType,
  type GatedFeature,
  SUBSCRIPTION_TIERS,
  GATED_FEATURES,
  TIER_CONFIG,
  getTierConfig,
  getResourceLimit,
  isFeatureAvailable,
  SubscriptionLimitError,
  FeatureNotAvailableError,
} from '@/lib/subscription-tiers';

export interface LimitCheckResult {
  allowed: boolean;
  current: number;
  limit: number | null;
  tier: SubscriptionTier;
}

export interface UsageReport {
  tier: SubscriptionTier;
  displayName: string;
  resources: Record<
    ResourceType,
    { current: number; limit: number | null; percentage: number | null }
  >;
  features: Record<GatedFeature, boolean>;
}

/** A stored tier string is only trusted if it is one we know; anything else is Free. */
function validateTier(raw: string): SubscriptionTier {
  return SUBSCRIPTION_TIERS.includes(raw as SubscriptionTier)
    ? (raw as SubscriptionTier)
    : 'free';
}

/**
 * The limit actually in force: the tier's allowance plus any quota bought on
 * top of it.
 *
 * Unlimited stays unlimited — adding to `null` would turn Enterprise's absence
 * of a cap into a number. Only `projects` currently sells add-on quota; every
 * other resource returns its tier allowance untouched, so a pack can never
 * silently raise a limit nobody sold.
 */
function effectiveLimit(
  tier: SubscriptionTier,
  resource: ResourceType,
  projectQuotaAddon: number
): number | null {
  const base = getResourceLimit(tier, resource);
  if (base === null) return null;
  return resource === 'projects' ? base + projectQuotaAddon : base;
}

export class SubscriptionService {
  private subscriptionRepository = new SubscriptionRepository();

  /**
   * Get the validated subscription tier for an org.
   * Falls back to 'free' if the stored value is invalid.
   */
  async getOrganizationTier(organizationId: string): Promise<SubscriptionTier> {
    const raw = await this.subscriptionRepository.getOrganizationTier(organizationId);
    return validateTier(raw);
  }

  /**
   * Keeps a downgraded organisation whole, without confiscating anything.
   *
   * Call after any tier change. It only ever RAISES the quota, so an upgrade
   * runs it harmlessly and a downgrade is the case it exists for.
   *
   * ## The problem it solves
   *
   * Projects are permanent — they cannot be archived, and only an empty one can
   * be deleted. So an Enterprise organisation with fifteen that drops to Pro
   * keeps all fifteen and has no way to shed any of them. With a bare
   * `limit = 10 + addon`, creating a sixteenth would mean buying SIX slots to
   * get ONE usable project, while a customer sitting at ten buys one slot for
   * one project. Same money, wildly different value, and the person penalised
   * is the one who used to pay the most.
   *
   * Recording the overage as granted quota fixes the arithmetic: they land
   * exactly at their limit, nothing is taken away, and the next slot they buy
   * gets them a project like it does for everybody else.
   *
   * ## `projectQuotaAddon` therefore holds two kinds of slot
   *
   * Slots somebody paid for, and slots granted here. It is deliberately not
   * split: from the organisation's side a slot is a slot, and a second column
   * would have to be summed everywhere this one is already read. It does mean
   * the number is NOT a record of money received — do not report revenue from
   * it.
   *
   * @returns the quota now in force, so a caller can log what it did.
   */
  async grandfatherProjectOverage(organizationId: string): Promise<number> {
    const state = await this.subscriptionRepository.getPlanState(organizationId);
    const tier = validateTier(state.tier);

    const base = getResourceLimit(tier, 'projects');
    // Unlimited: nothing can be over it, so there is nothing to preserve.
    if (base === null) return state.projectQuotaAddon;

    const current = await this.subscriptionRepository.countResource(
      organizationId,
      'projects'
    );

    const shortfall = current - base;
    // Never lowers an existing grant. Somebody who bought slots and then
    // downgraded keeps what they paid for as well as what they carried in.
    if (shortfall <= state.projectQuotaAddon) return state.projectQuotaAddon;

    await this.subscriptionRepository.setProjectQuotaAddon(
      organizationId,
      shortfall
    );
    return shortfall;
  }

  /**
   * Check whether creating one more resource would stay within limits.
   * Returns a result object — does NOT throw.
   */
  async checkResourceLimit(
    organizationId: string,
    resource: ResourceType
  ): Promise<LimitCheckResult> {
    const state = await this.subscriptionRepository.getPlanState(organizationId);
    const tier = validateTier(state.tier);
    const limit = effectiveLimit(tier, resource, state.projectQuotaAddon);
    const current = await this.subscriptionRepository.countResource(
      organizationId,
      resource
    );

    return {
      allowed: limit === null || current < limit,
      current,
      limit,
      tier,
    };
  }

  /**
   * Enforce a resource limit — throws SubscriptionLimitError if at or over limit.
   * Call this at the start of create methods in domain services.
   */
  async enforceResourceLimit(
    organizationId: string,
    resource: ResourceType
  ): Promise<void> {
    const check = await this.checkResourceLimit(organizationId, resource);

    if (!check.allowed) {
      throw new SubscriptionLimitError(
        resource,
        check.current,
        check.limit!,
        check.tier
      );
    }
  }

  /**
   * Check if a gated feature is available on the org's tier.
   * Returns boolean — does NOT throw.
   */
  async canUseFeature(
    organizationId: string,
    feature: GatedFeature
  ): Promise<boolean> {
    const tier = await this.getOrganizationTier(organizationId);
    return isFeatureAvailable(tier, feature);
  }

  /**
   * Enforce feature access — throws FeatureNotAvailableError if not on the right tier.
   * Call this at the start of feature-specific endpoints.
   */
  async enforceFeatureAccess(
    organizationId: string,
    feature: GatedFeature
  ): Promise<void> {
    const tier = await this.getOrganizationTier(organizationId);
    if (!isFeatureAvailable(tier, feature)) {
      throw new FeatureNotAvailableError(feature, tier);
    }
  }

  /**
   * What the plan lets the allocation engine do, for `effectiveAllocationMode`.
   *
   * One tier read for both answers rather than two `canUseFeature` calls, which
   * is not just an optimisation: the two must be resolved against the SAME
   * tier. Read separately they could straddle a plan change and produce a
   * combination no tier actually sells — `auto` without `suggestions`, which
   * the ladder in `allocation-mode` has no meaningful answer for.
   */
  async allocationEntitlements(
    organizationId: string
  ): Promise<{ auto: boolean; suggestions: boolean }> {
    const tier = await this.getOrganizationTier(organizationId);
    return {
      auto: isFeatureAvailable(tier, 'auto_allocation'),
      suggestions: isFeatureAvailable(tier, 'smart_suggestions'),
    };
  }

  /**
   * Get full usage report for an org — used by settings page and upgrade prompts.
   */
  async getUsage(organizationId: string): Promise<UsageReport> {
    const state = await this.subscriptionRepository.getPlanState(organizationId);
    const tier = validateTier(state.tier);
    const config = getTierConfig(tier);
    const counts = await this.subscriptionRepository.getResourceCounts(organizationId);

    const resourceMap: Record<ResourceType, number> = {
      members: counts.members,
      active_tasks: counts.activeTasks,
      departments: counts.departments,
      work_rules: counts.workRules,
      custom_roles: counts.customRoles,
      projects: counts.projects,
    };

    const resources = {} as UsageReport['resources'];
    for (const resource of Object.keys(config.limits) as ResourceType[]) {
      const current = resourceMap[resource];
      // Same function the enforcement path uses, so the number shown on the
      // usage panel is the number `create` will actually apply.
      const limit = effectiveLimit(tier, resource, state.projectQuotaAddon);
      resources[resource] = {
        current,
        limit,
        percentage: limit !== null ? Math.round((current / limit) * 100) : null,
      };
    }

    /*
     * Derived from GATED_FEATURES rather than a list repeated here. The copy
     * this replaces had fallen two behind — `assistant` and `calendar_sync`
     * were gated and sold, but absent from every usage report, so the return
     * value did not satisfy the `Record<GatedFeature, boolean>` it claims.
     */
    const features = {} as UsageReport['features'];
    for (const feature of GATED_FEATURES) {
      features[feature] = isFeatureAvailable(tier, feature);
    }

    return {
      tier,
      displayName: config.displayName,
      resources,
      features,
    };
  }
}