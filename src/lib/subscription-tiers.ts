/**
 * Subscription tier configuration — single source of truth.
 * Used by: SubscriptionService (enforcement), API routes (guards),
 * UI (gating/upgrade prompts), landing page (pricing table).
 *
 * ## The positioning, as of 2026-08-14
 *
 *   Free  = core workforce management + deterministic eligibility + MANUAL
 *           allocation.
 *   Pro+  = smart ranking + AI + automation + Projects + advanced tools.
 *
 * This REVERSES the rule this file used to state, which was that every "smart"
 * feature is available on all tiers and only scale limits and business tools
 * are gated. That rule gave the Free plan the entire product minus a member
 * cap: AI ranking, auto-allocation, the weekly auto-schedule and
 * natural-language task creation were all free, each one a paid provider call
 * against no revenue, and there was correspondingly little reason to buy Pro.
 *
 * What Free keeps is a complete and honest workforce manager — organisations,
 * departments, members, tasks and recurrences, availability, leave,
 * certifications, working-hour and overlap checks, the DETERMINISTIC
 * eligibility engine with its reasons, manual and multi-staff assignment,
 * reassignment, overrides with a reason, withdrawals and their approval,
 * clock in/out, history, notifications, the calendar and the basic dashboard.
 * Nothing in that list costs a provider call or runs unattended.
 *
 * What moves above Free is everything that RANKS, DECIDES or SPENDS on the
 * organisation's behalf, plus Projects, reporting export, integrations and the
 * premium analytics/audit surfaces.
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
   * The AI assistant. Was the ONE gated AI feature back when every other smart
   * feature was free, on the argument that a chat box costs a provider call
   * every time anybody types while the others cost one at a moment the
   * organisation chooses. The argument was sound and is now moot: the whole
   * ranking/automation family joined it below.
   */
  'assistant',
  /*
   * ── The smart/automation family, gated from 2026-08-14 ──────────────────
   *
   * Split into six rather than one `ai` flag, because they are six separate
   * decisions and a single flag cannot express a plan that sells one without
   * the others. It also keeps each refusal specific: "Weekly auto-schedule is
   * not available on Free" is actionable where "AI is not available" is not.
   */

  /**
   * Ranked staff suggestions — the `/suggest` endpoint, the ranked cover
   * preview behind a withdrawal decision, and the named best-fit line in a
   * backfill notification.
   *
   * Covers the ALGORITHMIC ranker as well as the AI providers, deliberately.
   * The two are one feature wearing two implementations — `FallbackRanker` is
   * what answers when a provider is down — so gating only the provider calls
   * would leave Free with the same product and a worse engine, which is not
   * what "manual allocation" means.
   */
  'smart_suggestions',
  /**
   * Automatic allocation: `allocationMode: "auto"`, the per-task auto-allocate
   * action, the auto branch of recurring-task generation, the unfilled-shift
   * sweep, and automatic backfill of a released shift.
   *
   * This is the one that runs UNATTENDED, which is why it is gated at the
   * setting as well as at the action — see `SettingsService.updateSettings`.
   * A Free
   * organisation cannot select the mode, and a previously-Pro organisation
   * still holding `auto` in its settings row does not get the behaviour.
   */
  'auto_allocation',
  /** Natural-language task creation — `POST /tasks/parse`. */
  'ai_task_create',
  /** The whole-week draft schedule: generate and confirm. */
  'auto_schedule',
  /**
   * Premium analytics — the smart-engine report panels (allocation mix,
   * eligibility overrides, response times, satisfaction) and the dashboard's
   * priority call.
   *
   * NOT the basic dashboard, task-coverage counts or `GET /reports`, which
   * Free keeps. The line is between counting what happened and analysing it.
   */
  'advanced_analytics',
  /**
   * Projects — creating one, editing one, staffing its team, and buying extra
   * project quota.
   *
   * The UI hides Projects outright on a plan without them — no link, no list,
   * an upsell in place of the page — because a Free organisation cannot have
   * projects and showing it a read-only set it can never use would be
   * offering half a feature.
   *
   * `ProjectService.list` and `.get` are nonetheless left ungated, and that is
   * not an oversight. The rows survive a downgrade untouched and come back
   * intact on upgrade, so the SERVICE has no reason to refuse a read; gating
   * it would mean the data could not be exported, audited or migrated by any
   * path at all. What Free does not get is the feature, which is a decision
   * about what to render, not about what may be read.
   */
  'projects',
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
    /*
     * Empty, and it is the ONLY tier for which that is the whole story: Free
     * is defined by what it does not include, so every entry in
     * `GATED_FEATURES` is refused here. The limits above are the other half —
     * `custom_roles: 0` and `projects: 0` mean the two features that also have
     * a count are refused twice over, by flag and by cap.
     */
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
      /*
       * The smart/automation family, gated from 2026-08-14. Pro is where the
       * product starts ranking, deciding and spending on the organisation's
       * behalf — see the positioning note at the top of this file.
       */
      'smart_suggestions',
      'auto_allocation',
      'ai_task_create',
      'auto_schedule',
      'advanced_analytics',
      'projects',
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
    /*
     * Everything, spread from the catalogue rather than listed.
     *
     * Enterprise is "the whole product" by definition, and the hand-written
     * list was a standing bug waiting for the next feature: six were added to
     * Pro in one pass, and an Enterprise list that had to be updated in the
     * same breath would eventually not be — leaving the most expensive plan
     * quietly missing something the cheaper one had. Spreading makes that
     * impossible instead of merely unlikely.
     */
    gatedFeatures: [...GATED_FEATURES],
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

/**
 * What each feature is called when a refusal is read by a human.
 *
 * `feature.replace('_', ' ')` replaced only the FIRST underscore, so the
 * message for `ai_task_create` read "ai task_create is not available" — and
 * even fixed to replace all of them it would say "ai task create", which is a
 * flag name with spaces in it rather than the name of anything in the product.
 * These are the words the pricing table and the UI use.
 */
export const FEATURE_LABELS: Record<GatedFeature, string> = {
  custom_roles: 'Custom roles',
  pdf_export: 'PDF report export',
  mass_import: 'Mass import',
  audit_log: 'The audit log',
  priority_support: 'Priority support',
  assistant: 'The AI assistant',
  smart_suggestions: 'Smart ranked suggestions',
  auto_allocation: 'Automatic allocation',
  ai_task_create: 'Natural language task creation',
  auto_schedule: 'The weekly auto-schedule',
  advanced_analytics: 'Advanced analytics',
  projects: 'Projects',
  calendar_sync: 'Calendar sync',
};

export class FeatureNotAvailableError extends Error {
  public readonly feature: GatedFeature;
  public readonly currentTier: SubscriptionTier;
  public readonly requiredTier: SubscriptionTier;

  constructor(feature: GatedFeature, currentTier: SubscriptionTier) {
    const requiredTier = getMinimumTierForFeature(feature);
    const label = FEATURE_LABELS[feature] ?? feature.replaceAll('_', ' ');
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

/*
 * Every row here is 'tools' or 'scale', because those are the only two
 * categories anything renders — the billing page and the landing page both
 * filter to `category === "tools"`, and 'scale' is read from the limits above.
 * The 'ai' category is retained on the type for compatibility and is
 * deliberately unused: a row in it is data nothing displays, which is how six
 * AI rows came to advertise "free: true" for features that are no longer free.
 */
export const PRICING_FEATURES: PricingFeatureRow[] = [
  // Scale limits — must match TIER_CONFIG.limits above.
  { name: 'Team members', free: 'Up to 10', pro: 'Up to 50', enterprise: 'Unlimited', category: 'scale' },
  { name: 'Active tasks', free: 'Up to 20', pro: 'Up to 200', enterprise: 'Unlimited', category: 'scale' },
  // Three since 2026-08-14; this row still said two. See the note on the Free
  // tier's `departments` limit.
  { name: 'Departments', free: 'Up to 3', pro: 'Up to 10', enterprise: 'Unlimited', category: 'scale' },
  { name: 'Work rules', free: 'Up to 3', pro: 'Up to 20', enterprise: 'Unlimited', category: 'scale' },
  // Ten since the project allowance became a lifetime quota; this row still
  // advertised the one it replaced.
  { name: 'Projects', free: '—', pro: '10 included', enterprise: 'Unlimited', category: 'scale' },
  { name: 'Custom roles', free: '—', pro: 'Up to 10', enterprise: 'Unlimited', category: 'scale' },

  // ── Core workforce management: every plan, including Free ────────────────
  { name: 'Departments, members & roles', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Tasks & recurring shifts', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Availability & leave management', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Certifications & verification', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Eligibility checks & reasons', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Manual & multi-staff assignment', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Clock in/out & shift history', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Calendar + heatmap', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Notifications', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Dashboard & coverage view', free: true, pro: true, enterprise: true, category: 'tools' },
  { name: 'Dark mode', free: true, pro: true, enterprise: true, category: 'tools' },

  // ── Smart, AI & automation: Pro and above ────────────────────────────────
  { name: 'Smart ranked suggestions', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Automatic allocation', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Weekly auto-schedule', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Natural language task creation', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'AI assistant', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Advanced analytics', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Projects', free: false, pro: true, enterprise: true, category: 'tools' },

  // ── Business tools: Pro and above ────────────────────────────────────────
  { name: 'Custom roles (RBAC)', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'PDF report export', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Mass import (Excel)', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Calendar sync', free: false, pro: true, enterprise: true, category: 'tools' },
  /*
   * Pro since 2026-08-11 — see the note beside `audit_log` in the Pro tier
   * above. This row still said Enterprise-only, which put an ✗ on the pricing
   * page against a feature every Pro organisation already had.
   */
  { name: 'Audit log', free: false, pro: true, enterprise: true, category: 'tools' },
  { name: 'Priority support', free: false, pro: false, enterprise: true, category: 'tools' },
];
