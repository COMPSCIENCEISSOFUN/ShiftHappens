/**
 * Billing Repository (Entity Layer)
 *
 * Data access for the Stripe billing fields on Organization.
 * Kept separate from SubscriptionRepository (which counts usage against
 * tier limits) — this one owns the org↔Stripe linkage and tier writes
 * driven by payment events.
 *
 * All writes here are triggered by trusted server code (checkout endpoint
 * and verified Stripe webhooks), never directly by user input.
 */
import { prisma } from "@/lib/prisma";

export interface OrgBilling {
  id: string;
  name: string;
  subscriptionTier: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  billingInterval: string | null;
}

const BILLING_SELECT = {
  id: true,
  name: true,
  subscriptionTier: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  subscriptionStatus: true,
  currentPeriodEnd: true,
  billingInterval: true,
} as const;

export class BillingRepository {
  /** Read an org's billing snapshot by id. */
  async getByOrgId(organizationId: string): Promise<OrgBilling | null> {
    return prisma.organization.findUnique({
      where: { id: organizationId },
      select: BILLING_SELECT,
    });
  }

  /** Resolve an org from its Stripe customer id (used by webhooks). */
  async getByStripeCustomerId(customerId: string): Promise<OrgBilling | null> {
    return prisma.organization.findUnique({
      where: { stripeCustomerId: customerId },
      select: BILLING_SELECT,
    });
  }

  /** Persist the Stripe customer id once created during checkout. */
  async setStripeCustomerId(
    organizationId: string,
    customerId: string
  ): Promise<void> {
    await prisma.organization.update({
      where: { id: organizationId },
      data: { stripeCustomerId: customerId },
    });
  }

  /**
   * Apply the outcome of a subscription event: tier, status, Stripe ids
   * and billing interval. Only defined fields are written.
   */
  async applySubscriptionState(
    organizationId: string,
    data: {
      subscriptionTier?: string;
      subscriptionStatus?: string | null;
      stripeSubscriptionId?: string | null;
      stripeCustomerId?: string | null;
      billingInterval?: string | null;
      currentPeriodEnd?: Date | null;
    }
  ): Promise<OrgBilling> {
    return prisma.organization.update({
      where: { id: organizationId },
      data,
      select: BILLING_SELECT,
    });
  }
}
