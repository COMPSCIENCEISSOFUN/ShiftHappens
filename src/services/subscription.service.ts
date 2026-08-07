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

export class SubscriptionService {
  private subscriptionRepository = new SubscriptionRepository();

  /**
   * Get the validated subscription tier for an org.
   * Falls back to 'free' if the stored value is invalid.
   */
  async getOrganizationTier(organizationId: string): Promise<SubscriptionTier> {
    const raw = await this.subscriptionRepository.getOrganizationTier(organizationId);
    if (SUBSCRIPTION_TIERS.includes(raw as SubscriptionTier)) {
      return raw as SubscriptionTier;
    }
    return 'free';
  }

  /**
   * Check whether creating one more resource would stay within limits.
   * Returns a result object — does NOT throw.
   */
  async checkResourceLimit(
    organizationId: string,
    resource: ResourceType
  ): Promise<LimitCheckResult> {
    const tier = await this.getOrganizationTier(organizationId);
    const limit = getResourceLimit(tier, resource);
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
   * Get full usage report for an org — used by settings page and upgrade prompts.
   */
  async getUsage(organizationId: string): Promise<UsageReport> {
    const tier = await this.getOrganizationTier(organizationId);
    const config = getTierConfig(tier);
    const counts = await this.subscriptionRepository.getResourceCounts(organizationId);

    const resourceMap: Record<ResourceType, number> = {
      members: counts.members,
      active_tasks: counts.activeTasks,
      departments: counts.departments,
      work_rules: counts.workRules,
      custom_roles: counts.customRoles,
    };

    const resources = {} as UsageReport['resources'];
    for (const resource of Object.keys(config.limits) as ResourceType[]) {
      const current = resourceMap[resource];
      const limit = config.limits[resource];
      resources[resource] = {
        current,
        limit,
        percentage: limit !== null ? Math.round((current / limit) * 100) : null,
      };
    }

    const features = {} as UsageReport['features'];
    const allGated: GatedFeature[] = [
      'custom_roles',
      'pdf_export',
      'mass_import',
      'audit_log',
      'priority_support',
    ];
    for (const feature of allGated) {
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
