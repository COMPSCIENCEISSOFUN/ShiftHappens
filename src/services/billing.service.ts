/**
 * Billing Service (Control Layer)
 *
 * Owns the Stripe checkout lifecycle for paid-plan (Pro) subscriptions:
 *   1. createCheckoutSession — builds a Stripe Checkout Session for an org
 *      and returns the hosted-payment URL to redirect the user to.
 *   2. constructEvent — verifies a raw webhook payload against the signing
 *      secret (rejects forged calls).
 *   3. handleEvent — applies verified subscription events to the org's tier.
 *
 * Tier changes are ONLY ever driven by verified Stripe events, never by the
 * client — the client can start a checkout, but the upgrade is not granted
 * until Stripe confirms payment via webhook. This prevents a user from
 * self-upgrading by calling an endpoint.
 */
import Stripe from "stripe";
import {
  getStripe,
  proPlanLineItem,
  isBillingInterval,
  type BillingInterval,
} from "@/lib/stripe";
import { BillingRepository } from "@/repositories/billing.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";

/** Where the checkout was launched from — controls the return URLs. */
export type CheckoutSource = "onboarding" | "settings";

interface CreateCheckoutParams {
  organizationId: string;
  userId: string;
  userEmail: string;
  interval: BillingInterval;
  source: CheckoutSource;
  /** Absolute origin of the current request, e.g. "http://localhost:3000". */
  origin: string;
}

interface CreatePortalParams {
  organizationId: string;
  origin: string;
}

/** Coerce a Stripe expandable field (string id | object | null) to its id string. */
function toId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

export class BillingService {
  private billingRepo = new BillingRepository();
  private auditService = new AuditLogService();

  /**
   * Create a Stripe Checkout Session for the Pro plan and return its URL.
   * Reuses an existing Stripe customer for the org when one exists, otherwise
   * creates one and stores its id.
   */
  async createCheckoutSession(params: CreateCheckoutParams): Promise<string> {
    const { organizationId, userId, userEmail, interval, source, origin } = params;
    const stripe = getStripe();

    const org = await this.billingRepo.getByOrgId(organizationId);
    if (!org) throw new Error("Organization not found");
    if (org.subscriptionTier === "pro" && ["active", "trialing", "past_due"].includes(org.subscriptionStatus ?? "")) {
      throw new Error("This organization already has an active Pro subscription.");
    }

    // Ensure a Stripe customer exists for this org (one customer per org).
    let customerId = org.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        name: org.name,
        metadata: { organizationId },
      });
      customerId = customer.id;
      await this.billingRepo.setStripeCustomerId(organizationId, customerId);
    }

    const { successUrl, cancelUrl } = this.returnUrls(source, origin, organizationId);
    // Collapse accidental double-clicks, but do not reuse a completed session
    // forever or across entry points with different return URLs.
    const checkoutWindow = Math.floor(Date.now() / (10 * 60 * 1000));

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [proPlanLineItem(interval)],
      client_reference_id: organizationId,
      // Metadata on the session (read in checkout.session.completed) and on the
      // resulting subscription (read in customer.subscription.* events).
      metadata: { organizationId, userId, tier: "pro", interval },
      subscription_data: {
        metadata: { organizationId, tier: "pro" },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
    }, {
      idempotencyKey: `checkout:${organizationId}:${interval}:${source}:${checkoutWindow}`,
    });

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL");
    }

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.CHECKOUT_STARTED,
      entityType: "subscription",
      entityId: session.id,
      details: { interval, source, plan: "pro" },
    });

    return session.url;
  }

  /** Create a Stripe-hosted self-service billing portal for an existing customer. */
  async createPortalSession({ organizationId, origin }: CreatePortalParams): Promise<string> {
    const organization = await this.billingRepo.getByOrgId(organizationId);
    if (!organization?.stripeCustomerId) {
      throw new Error("No Stripe billing profile exists for this organization.");
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: organization.stripeCustomerId,
      return_url: `${origin}/org/${organizationId}/settings`,
    });
    return session.url;
  }

  /** Build success/cancel URLs based on where checkout was launched. */
  private returnUrls(source: CheckoutSource, origin: string, orgId: string) {
    if (source === "settings") {
      const base = `${origin}/org/${orgId}/settings`;
      return {
        successUrl: `${base}?checkout=success`,
        cancelUrl: `${base}?checkout=canceled`,
      };
    }
    // onboarding — org already exists on the free tier; land on the dashboard.
    return {
      successUrl: `${origin}/dashboard?checkout=success`,
      cancelUrl: `${origin}/dashboard?checkout=canceled`,
    };
  }

  /**
   * Verify a raw webhook body against the signing secret.
   * Throws if the signature is invalid or the secret is missing.
   */
  async constructEvent(rawBody: string, signature: string): Promise<Stripe.Event> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error("STRIPE_WEBHOOK_SECRET is not set.");
    }
    // Async variant works across all runtimes.
    return getStripe().webhooks.constructEventAsync(rawBody, signature, secret);
  }

  /** Dispatch a verified Stripe event to the right handler. */
  async handleEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case "checkout.session.completed":
        await this.onCheckoutCompleted(event, event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.updated":
        await this.onSubscriptionChanged(event, event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await this.onSubscriptionDeleted(event, event.data.object as Stripe.Subscription);
        break;
      default:
        // Unhandled event types are acknowledged (200) but ignored.
        break;
    }
  }

  /** Payment completed — grant the Pro tier. */
  private async onCheckoutCompleted(event: Stripe.Event, session: Stripe.Checkout.Session): Promise<void> {
    const organizationId =
      session.metadata?.organizationId ?? session.client_reference_id ?? null;
    if (!organizationId) {
      console.error("[Billing] checkout.session.completed missing organizationId");
      return;
    }

    const interval = session.metadata?.interval;
    const paymentConfirmed =
      !session.payment_status ||
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required";
    const outcome = await this.billingRepo.applyStripeEvent({
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt: new Date(event.created * 1000),
      organizationId,
      state: {
        subscriptionTier: paymentConfirmed ? "pro" : "free",
        subscriptionStatus: paymentConfirmed ? "active" : "incomplete",
      stripeCustomerId: toId(session.customer),
      stripeSubscriptionId: toId(session.subscription),
      billingInterval: isBillingInterval(interval) ? interval : null,
      },
    });
    if (outcome !== "applied") return;

    await this.auditService.log({
      organizationId,
      userId: session.metadata?.userId,
      action: ACTIONS.SUBSCRIPTION_UPGRADED,
      entityType: "subscription",
      entityId: toId(session.subscription) ?? session.id,
      details: { tier: paymentConfirmed ? "pro" : "free", interval, paymentConfirmed },
    });
  }

  /**
   * Subscription changed (renewal, payment issue, plan change).
   * Maps Stripe status → our tier: active/trialing keep Pro; terminal states
   * drop to free. past_due/incomplete keep Pro but record the status so the UI
   * can warn.
   */
  private async onSubscriptionChanged(event: Stripe.Event, sub: Stripe.Subscription): Promise<void> {
    const organizationId = await this.resolveOrgId(sub);
    if (!organizationId) return;

    const paidOrGrace = ["active", "trialing", "past_due"];
    const tier = paidOrGrace.includes(sub.status) ? "pro" : "free";
    const interval = sub.items.data[0]?.price.recurring?.interval;

    const outcome = await this.billingRepo.applyStripeEvent({
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt: new Date(event.created * 1000),
      organizationId,
      state: {
      subscriptionTier: tier,
      subscriptionStatus: sub.status,
      stripeSubscriptionId: sub.id,
      billingInterval: isBillingInterval(interval) ? interval : null,
      },
    });
    if (outcome !== "applied") return;

    await this.auditService.log({
      organizationId,
      action: ACTIONS.SUBSCRIPTION_UPDATED,
      entityType: "subscription",
      entityId: sub.id,
      details: { status: sub.status, tier },
    });
  }

  /** Subscription fully deleted — revert to free. */
  private async onSubscriptionDeleted(event: Stripe.Event, sub: Stripe.Subscription): Promise<void> {
    const organizationId = await this.resolveOrgId(sub);
    if (!organizationId) return;

    const outcome = await this.billingRepo.applyStripeEvent({
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt: new Date(event.created * 1000),
      organizationId,
      state: {
      subscriptionTier: "free",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: null,
      billingInterval: null,
      },
    });
    if (outcome !== "applied") return;

    await this.auditService.log({
      organizationId,
      action: ACTIONS.SUBSCRIPTION_CANCELED,
      entityType: "subscription",
      entityId: sub.id,
      details: { tier: "free" },
    });
  }

  /** Resolve the owning org from a subscription's metadata, falling back to its customer id. */
  private async resolveOrgId(sub: Stripe.Subscription): Promise<string | null> {
    if (sub.metadata?.organizationId) return sub.metadata.organizationId;
    const customerId = toId(sub.customer);
    if (!customerId) return null;
    const org = await this.billingRepo.getByStripeCustomerId(customerId);
    return org?.id ?? null;
  }
}
