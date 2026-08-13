/**
 * Platform Service (Control Layer)
 *
 * Business logic for platform administration.
 * Manages organization tenants across the entire platform.
 * Only accessible to users with isPlatformAdmin flag.
 */
import { PlatformRepository } from "@/repositories/platform.repository";
import { SubscriptionRepository } from "@/repositories/subscription.repository";
import { UserRepository } from "@/repositories/user.repository";
import {
  SUBSCRIPTION_TIERS,
  type SubscriptionTier,
  getTierConfig,
} from "@/lib/subscription-tiers";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";

export class PlatformService {
  private platformRepo = new PlatformRepository();
  private auditService = new AuditLogService();
  private subscriptionRepo = new SubscriptionRepository();
  private userRepo = new UserRepository();

  /**
   * Whether a user is a platform administrator.
   *
   * Deliberately re-checked against the database rather than trusted from the
   * session: the flag is what separates a tenant from the operator of every
   * tenant, and a JWT minted before the flag was revoked would otherwise stay
   * valid until it expired.
   *
   * `src/lib/platform-guard.ts` reads the same flag off the session for
   * page-level redirects, where the cost of a stale claim is a redirect rather
   * than access. Routes that mutate platform-wide data use this.
   */
  async isPlatformAdmin(userId: string): Promise<boolean> {
    return this.userRepo.isPlatformAdmin(userId);
  }

  /** Lists all organizations with member and task counts */
  async getOrganizations(limit = 50, offset = 0) {
    const [organizations, total] = await Promise.all([
      this.platformRepo.findAllOrganizations(limit, offset),
      this.platformRepo.countOrganizations(),
    ]);

    return { organizations, total, limit, offset };
  }

  /** Gets a single organization by ID */
  async getOrganizationById(orgId: string) {
    const org = await this.platformRepo.findOrganizationById(orgId);
    if (!org) {
      throw new Error("Organization not found");
    }
    return org;
  }

  /**
   * Toggles an organization's status between active and suspended.
   *
   * Audited against the AFFECTED tenant rather than anywhere platform-side.
   * Suspension stops everyone in that organisation from doing anything, and the
   * people it happens to are the ones who need a record of when and by whom —
   * a platform-side log would put the account of the event out of reach of
   * everybody affected by it.
   *
   * `actedById` is threaded from the route rather than inferred. There is no
   * ambient "current user" in a service, and an audit row whose actor is a
   * guess is worth less than no row.
   */
  async toggleOrganizationStatus(orgId: string, actedById: string) {
    const org = await this.platformRepo.findOrganizationById(orgId);
    if (!org) {
      throw new Error("Organization not found");
    }

    const newStatus = org.status === "active" ? "suspended" : "active";
    const updated = await this.platformRepo.updateOrganizationStatus(
      orgId,
      newStatus
    );

    void this.auditService.log({
      organizationId: orgId,
      userId: actedById,
      action:
        newStatus === "suspended"
          ? ACTIONS.ORGANIZATION_SUSPENDED
          : ACTIONS.ORGANIZATION_REACTIVATED,
      entityType: "organization",
      entityId: orgId,
      details: { from: org.status, to: newStatus, by: "platform_admin" },
    });

    return updated;
  }

  /**
   * Updates an organization's subscription tier.
   * Validates the tier value against allowed tiers.
   * Used by platform admin to set/override tiers for demos or upgrades.
   */
  async updateOrganizationTier(orgId: string, tier: string, actedById: string) {
    if (!SUBSCRIPTION_TIERS.includes(tier as SubscriptionTier)) {
      throw new Error(
        `Invalid subscription tier: ${tier}. Must be one of: ${SUBSCRIPTION_TIERS.join(", ")}`
      );
    }

    const org = await this.platformRepo.findOrganizationById(orgId);
    if (!org) {
      throw new Error("Organization not found");
    }

    const updated = await this.subscriptionRepo.updateOrganizationTier(
      orgId,
      tier
    );

    /*
     * A tier change moves what the organisation can DO — audit log access,
     * custom roles, PDF export are all gated on it. An admin finding a feature
     * gone should be able to see that it was a plan change rather than a fault.
     */
    void this.auditService.log({
      organizationId: orgId,
      userId: actedById,
      action: ACTIONS.ORGANIZATION_TIER_CHANGED,
      entityType: "organization",
      entityId: orgId,
      details: { from: org.subscriptionTier ?? null, to: tier, by: "platform_admin" },
    });

    return updated;
  }

  /** Gets platform-wide statistics */
  /**
   * Platform totals, plus the figures derived from them.
   *
   * The derivations live here rather than in the page for the reason the
   * billing page gives about `needsAttention`: what counts as revenue, and what
   * counts as a paying customer, are business judgements. Deciding them in a
   * component puts them beyond the reach of a test and out of sight of the next
   * person who adds a tier.
   */
  async getStats() {
    const stats = await this.platformRepo.getStats();

    /*
     * MRR — monthly RECURRING revenue, so an annual plan contributes a twelfth
     * of its price rather than the whole thing.
     *
     * Reporting an annual customer's full £590 as this month's revenue is the
     * classic way a SaaS dashboard flatters itself: the number leaps when
     * somebody renews and collapses the month after, and it describes cash
     * received rather than the run rate the figure is supposed to mean.
     *
     * A null interval is treated as monthly. Every paid organisation should
     * carry one — the webhook writes it — but a tier applied by hand does not,
     * and the monthly price is the conservative reading of an unknown.
     */
    let mrr = 0;
    for (const row of stats.billingBreakdown) {
      if (!SUBSCRIPTION_TIERS.includes(row.tier as SubscriptionTier)) continue;
      const config = getTierConfig(row.tier as SubscriptionTier);
      const monthly =
        row.interval === "year"
          ? (config.yearlyPrice ?? 0) / 12
          : (config.monthlyPrice ?? 0);
      mrr += monthly * row.count;
    }

    // Any tier priced above zero. Derived from the config rather than from a
    // hardcoded list, so a fourth plan is counted the day it is added.
    const paidOrganizations = SUBSCRIPTION_TIERS.filter(
      (tier) => (getTierConfig(tier).monthlyPrice ?? 0) > 0
    ).reduce((total, tier) => total + (stats.tierCounts[tier] ?? 0), 0);

    /** Percentage change, or null when there is no prior figure to divide by. */
    const changeAgainst = (current: number, previous: number): number | null =>
      previous === 0 ? null : Math.round(((current - previous) / previous) * 100);

    return {
      ...stats,
      mrr: Math.round(mrr),
      // Stated as well as implied. `mrr * 12` is the run rate, not the sum of
      // what will actually be invoiced, and naming it ARR says which is meant.
      arr: Math.round(mrr * 12),
      paidOrganizations,
      conversionRate:
        stats.totalOrganizations === 0
          ? 0
          : Math.round((paidOrganizations / stats.totalOrganizations) * 100),
      completionRate:
        stats.totalTasks === 0
          ? 0
          : Math.round((stats.completedTasks / stats.totalTasks) * 100),
      organizationGrowth: changeAgainst(
        stats.newOrganizations,
        stats.previousNewOrganizations
      ),
      userGrowth: changeAgainst(stats.newUsers, stats.previousNewUsers),
      averageUsersPerOrganization:
        stats.totalOrganizations === 0
          ? 0
          : stats.totalUsers / stats.totalOrganizations,
      averageTasksPerOrganization:
        stats.totalOrganizations === 0
          ? 0
          : stats.totalTasks / stats.totalOrganizations,
    };
  }
}