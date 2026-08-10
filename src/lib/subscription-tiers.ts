/**
 * Subscription tier configuration — single source of truth.
 * Used by: SubscriptionService (enforcement), API routes (guards),
 * UI (gating/upgrade prompts), landing page (pricing table).
 *
 * All "smart" features (AI suggest, auto-schedule, NL create, smart-swap,
 * insights, calendar, notifications, availability, certifications, dark mode)
 * are available on ALL tiers. Only scale limits and business tools are gated.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export const SUBSCRIPTION_TIERS = ['free', 'pro', 'enterprise'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const RESOURCE_TYPES = [
  'members',
  'active_tasks',
  'departments',
  'work_rules',
  'custom_roles',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Features that are gated by tier. Anything NOT listed here is available to all tiers. */
export const GATED_FEATURES = [
  'custom_roles',
  'pdf_export',
  'mass_import',
  'audit_log',
  'priority_support',
  /*
   * The one AI feature that IS gated, against the rule stated at the top of
   * this file. Every other smart feature costs a provider call at a moment the
   * organisation chooses; the assistant costs one every time anybody types.
   * See the note beside `assistant:use` in `permissions.ts`.
   */
  'assistant',
] as const;
export type GatedFeature = (typeof GATED_FEATURES)[number];

// ─── Tier definitions ───────────────────────────────────────────────────────

export interface TierDefinition {
  name: SubscriptionTier;
  displayName: string;
  tagline: string;
  monthlyPrice: number | null; // null = "Contact us"
  yearlyPrice: number | null;
  limits: Record<ResourceType, number | null>; // null = unlimited
  gatedFeatures: GatedFeature[];
}

export const TIER_CONFIG: Record<SubscriptionTier, TierDefinition> = {
  free: {
    name: 'free',
    displayName: 'Free',
    tagline: 'For small teams getting started',
    monthlyPrice: 0,
    yearlyPrice: 0,
    limits: {
      members: 10,
      active_tasks: 20,
      departments: 2,
      work_rules: 3,
      custom_roles: 0,
    },
    gatedFeatures: [],
  },
  pro: {
    name: 'pro',
    displayName: 'Pro',
    tagline: 'For growing teams that need more control',
    monthlyPrice: 29,
    yearlyPrice: 290,
    limits: {
      members: 50,
      active_tasks: 200,
      departments: 10,
      work_rules: 20,
      custom_roles: 10,
    },
    gatedFeatures: ['custom_roles', 'pdf_export', 'mass_import', 'assistant'],
  },
  enterprise: {
    name: 'enterprise',
    displayName: 'Enterprise',
    tagline: 'For large organizations with complex needs',
    monthlyPrice: null,
    yearlyPrice: null,
    limits: {
      members: null,
      active_tasks: null,
      departments: null,
      work_rules: null,
      custom_roles: null,
    },
    gatedFeatures: [
      'custom_roles',
      'pdf_export',
      'mass_import',
      'audit_log',
      'priority_support',
      'assistant',
    ],
  },
};

// ─── Helper functions ───────────────────────────────────────────────────────

/** Get the full tier definition for a given tier name. */
export function getTierConfig(tier: SubscriptionTier): TierDefinition {
  return TIER_CONFIG[tier];
}

/** Get the resource limit for a tier. Returns null if unlimited. */
export function getResourceLimit(
  tier: SubscriptionTier,
  resource: ResourceType
): number | null {
  return TIER_CONFIG[tier].limits[resource];
}

/** Check if a gated feature is available on the given tier. */
export function isFeatureAvailable(
  tier: SubscriptionTier,
  feature: GatedFeature
): boolean {
  return TIER_CONFIG[tier].gatedFeatures.includes(feature);
}

/** Find the lowest tier that grants access to a gated feature. */
export function getMinimumTierForFeature(feature: GatedFeature): SubscriptionTier {
  for (const tier of SUBSCRIPTION_TIERS) {
    if (TIER_CONFIG[tier].gatedFeatures.includes(feature)) {
      return tier;
    }
  }
  return 'enterprise';
}

/** Suggest the next tier up that raises the limit for a resource. Returns null if already on the highest. */
export function getUpgradeTier(
  currentTier: SubscriptionTier,
  resource: ResourceType
): SubscriptionTier | null {
  const tierOrder: SubscriptionTier[] = ['free', 'pro', 'enterprise'];
  const currentIndex = tierOrder.indexOf(currentTier);
  const currentLimit = TIER_CONFIG[currentTier].limits[resource];

  for (let i = currentIndex + 1; i < tierOrder.length; i++) {
    const nextTier = tierOrder[i];
    const nextLimit = TIER_CONFIG[nextTier].limits[resource];
    if (nextLimit === null || (currentLimit !== null && nextLimit > currentLimit)) {
      return nextTier;
    }
  }
  return null;
}

/** Human-readable limit label (e.g. "Up to 10", "Unlimited"). */
export function formatLimit(limit: number | null): string {
  return limit === null ? 'Unlimited' : `Up to ${limit}`;
}

// ─── Custom error classes ───────────────────────────────────────────────────

export class SubscriptionLimitError extends Error {
  public readonly resource: ResourceType;
  public readonly current: number;
  public readonly limit: number;
  public readonly currentTier: SubscriptionTier;
  public readonly upgradeTier: SubscriptionTier | null;

  constructor(
    resource: ResourceType,
    current: number,
    limit: number,
    currentTier: SubscriptionTier
  ) {
    const upgradeTier = getUpgradeTier(currentTier, resource);
    const upgradeHint = upgradeTier
      ? ` Upgrade to ${TIER_CONFIG[upgradeTier].displayName} for ${formatLimit(TIER_CONFIG[upgradeTier].limits[resource])}.`
      : '';
    const label = resource.replace('_', ' ');
    super(
      `${label} limit reached (${current}/${limit}).${upgradeHint}`
    );
    this.name = 'SubscriptionLimitError';
    this.resource = resource;
    this.current = current;
    this.limit = limit;
    this.currentTier = currentTier;
    this.upgradeTier = upgradeTier;
  }
}

export class FeatureNotAvailableError extends Error {
  public readonly feature: GatedFeature;
  public readonly currentTier: SubscriptionTier;
  public readonly requiredTier: SubscriptionTier;

  constructor(feature: GatedFeature, currentTier: SubscriptionTier) {
    const requiredTier = getMinimumTierForFeature(feature);
    const label = feature.replace('_', ' ');
    super(
      `${label} is not available on the ${TIER_CONFIG[currentTier].displayName} plan. Upgrade to ${TIER_CONFIG[requiredTier].displayName} to access this feature.`
    );
    this.name = 'FeatureNotAvailableError';
    this.feature = feature;
    this.currentTier = currentTier;
    this.requiredTier = requiredTier;
  }
}

// ─── Pricing table data (for landing page / settings page) ──────────────────

export interface PricingFeatureRow {
  name: string;
  free: boolean | string;
  pro: boolean | string;
  enterprise: boolean | string;
  category: 'scale' | 'ai' | 'tools';
}

export const PRICING_FEATURES: PricingFeatureRow[] = [
  // Scale limits
  { name: 'Team members', free: 'Up to 10', pro: 'Up to 50', enterprise: 'Unlimited', category: 'scale' },
  { name: 'Active tasks', free: 'Up to 20', pro: 'Up to 200', enterprise: 'Unlimited', category: 'scale' },
  { name: 'Departments', free: 'Up to 2', pro: 'Up to 10', enterprise: 'Unlimited', category: 'scale' },
  { name: 'Work rules', free: 'Up to 3', pro: 'Up to 20', enterprise: 'Unlimited', category: 'scale' },
  // AI — all tiers
  { name: 'AI-powered suggestions', free: true, pro: true, enterprise: true, category: 'ai' },
  { name: 'Smart auto-schedule', free: true, pro: true, enterprise: true, category: 'ai' },
  { name: 'Natural language tasks', free: true, pro: true, enterprise: true, category: 'ai' },
  { name: 'Smart-swap replacements', free: true, pro: true, enterprise: true, category: 'ai' },
  { name: 'AI dashboard insights', free: true, pro: true, enterprise: true, category: 'ai' },
  { name: 'Coverage gap detection', free: true, pro: true, enterprise: true, category: 'ai' },
  // Business tools
  { name: 'Calendar + heatmap', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Notifications', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Dark mode', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Custom roles (RBAC)', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'PDF report export', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Mass import (Excel)', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Audit log', free: false, pro: false, enterprise: true, category: 'tools' },
  { name: 'Priority support', free: false, pro: false, enterprise: true, category: 'tools' },
];