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
  billingInterval: string | null;
  stripeLastEventAt: Date | null;
}

const BILLING_SELECT = {
  id: true,
  name: true,
  subscriptionTier: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  subscriptionStatus: true,
  billingInterval: true,
  stripeLastEventAt: true,
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
    }
  ): Promise<OrgBilling> {
    return prisma.organization.update({
      where: { id: organizationId },
      data,
      select: BILLING_SELECT,
    });
  }

  /**
   * Applies a verified Stripe event once. A stale event is recorded for audit
   * purposes but cannot overwrite a newer subscription state.
   */
  async applyStripeEvent(input: {
    eventId: string;
    eventType: string;
    eventCreatedAt: Date;
    organizationId: string;
    state: {
      subscriptionTier?: string;
      subscriptionStatus?: string | null;
      stripeSubscriptionId?: string | null;
      stripeCustomerId?: string | null;
      billingInterval?: string | null;
    };
  }): Promise<"applied" | "duplicate" | "stale"> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.stripeWebhookEvent.findUnique({
        where: { id: input.eventId },
        select: { id: true },
      });
      if (existing) return "duplicate";

      const organization = await tx.organization.findUnique({
        where: { id: input.organizationId },
        select: { stripeLastEventAt: true },
      });
      if (!organization) throw new Error("Organization not found");

      const stale =
        organization.stripeLastEventAt !== null &&
        organization.stripeLastEventAt > input.eventCreatedAt;

      await tx.stripeWebhookEvent.create({
        data: {
          id: input.eventId,
          organizationId: input.organizationId,
          type: input.eventType,
          eventCreatedAt: input.eventCreatedAt,
          outcome: stale ? "stale" : "applied",
        },
      });

      if (stale) return "stale";

      await tx.organization.update({
        where: { id: input.organizationId },
        data: { ...input.state, stripeLastEventAt: input.eventCreatedAt },
      });
      return "applied";
    });
  }
}
