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
  async getStats() {
    return this.platformRepo.getStats();
  }
}