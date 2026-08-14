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
  /*
   * The one LIFETIME allowance here, unlike every other resource on this list.
   *
   * A project cannot be archived, and only an EMPTY one can be deleted — see
   * `ProjectService.remove`. So a project consumed is a project consumed for
   * good, and the count never comes down once work has happened inside it.
   *
   * That is deliberate: a project records why a set of shifts was grouped, who
   * owned it and over what period, and a deletable project is a renewable slot
   * that makes the limit mean nothing. It is also why Pro's allowance is ten
   * rather than the one it started at — a lifetime quota has to be generous
   * where a concurrent one can be tight.
   *
   * The empty-project exception exists only for a project created by mistake,
   * which has nothing in it to audit and would otherwise cost a permanent slot.
   */
  'projects',
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
  /*
   * Subscribing to your own shifts from a calendar app.
   *
   * Checked on every POLL rather than at subscribe time, because the client
   * holds the URL indefinitely and sends no session — so a downgrade has to be
   * able to stop a feed that is already in somebody's calendar. The feed keeps
   * returning a VALID calendar when it refuses, carrying one event that says
   * why: a client handed a 403 shows the reader nothing at all, and shifts
   * silently ceasing to appear reads as an empty rota rather than a plan
   * change.
   */
  'calendar_sync',
] as const;
export type GatedFeature = (typeof GATED_FEATURES)[number];

// ─── Tier definitions ───────────────────────────────────────────────────────

export interface TierDefinition {
  name: SubscriptionTier;
  displayName: string;
  tagline: string;
  monthlyPrice: number | null; // null = not sold through self-serve checkout
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
      /*
       * Three, raised from two on 2026-08-14.
       *
       * Two was below the floor of the businesses this is sold to: a café with
       * a kitchen, a floor and a bar is three, and a Free organisation with the
       * template applied arrived already over its cap — the usage panel opened
       * on "3 of 2 — limit reached" before the customer had done anything. A
       * limit somebody is over on day one reads as a fault rather than as an
       * invitation to upgrade.
       */
      departments: 3,
      work_rules: 3,
      custom_roles: 0,
      projects: 0,
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
      /*
       * Ten, raised from one on 2026-08-14, and the number moved because the
       * KIND of limit did.
       *
       * A project is now permanent: it cannot be archived, and it can only be
       * deleted while it holds no work items. So this is a lifetime quota, not
       * a count of what may run at once — and those are wildly different offers
       * wearing the same words. One concurrent project is a tight plan; one
       * project EVER is a countdown, and a customer who used theirs last
       * January would be paying $29 a month to be permanently unable to start
       * anything.
       *
       * Ten permanent projects is roughly as generous as two concurrent ones
       * and does not read as a trap.
       *
       * Raised further by buying add-on quota, added to this baseline
       * per-organisation — see `SubscriptionService.checkResourceLimit`. That
       * purchase is now ONE-OFF rather than a recurring subscription item: the
       * thing it unlocks is permanent, so billing for it monthly forever would
       * be a bill that only ever goes up.
       */
      projects: 10,
    },
    gatedFeatures: [
      'custom_roles',
      'pdf_export',
      'mass_import',
      'assistant',
      'calendar_sync',
      /*
       * Moved down from Enterprise on 2026-08-11.
       *
       * It was the only gated feature that a Pro organisation could be granted
       * a PERMISSION for and still never use: `audit:view` maps to this
       * feature, custom roles are Pro-and-above, and the route guard checks the
       * plan before the permission — so the role builder offered every Pro
       * organisation a checkbox that could not do anything for anybody.
       *
       * `role.service.getAllPermissions` was written to explain that box rather
       * than to remove it. With this move the box becomes real, which is the
       * better resolution of the same problem.
       */
      'audit_log',
    ],
  },
  enterprise: {
    name: 'enterprise',
    displayName: 'Enterprise',
    tagline: 'For large organizations with complex needs',
    monthlyPrice: 59,
    yearlyPrice: 590,
    limits: {
      members: null,
      active_tasks: null,
      departments: null,
      work_rules: null,
      custom_roles: null,
      projects: null,
    },
    gatedFeatures: [
      'custom_roles',
      'pdf_export',
      'mass_import',
      'audit_log',
      'calendar_sync',
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
  { name: 'Projects', free: '—', pro: '1 included', enterprise: 'Unlimited', category: 'scale' },
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
  /*
   * Both of these are in GATED_FEATURES and have been sold to Pro all along —
   * they were simply missing from this table, so the pricing page advertised
   * neither. Listed as 'tools' rather than 'ai' because the pricing cards
   * render only the 'tools' rows; an 'ai' row is data nothing displays.
   */
  { name: 'AI assistant', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Calendar sync', free: false, pro: true, enterprise: true, category: 'tools' },
  /*
   * Pro since 2026-08-11 — see the note beside `audit_log` in the Pro tier
   * above. This row still said Enterprise-only, which put an ✗ on the pricing
   * page against a feature every Pro organisation already had.
   */
  { name: 'Audit log', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Priority support', free: false, pro: false, enterprise: true, category: 'tools' },
];
