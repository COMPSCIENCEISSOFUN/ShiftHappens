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
import { SubscriptionService } from "@/services/subscription.service";

/**
 * When the current paid period ends.
 *
 * Read from the subscription ITEM, not the subscription. `current_period_end`
 * used to sit on `Stripe.Subscription` and moved down to the item in the 2025
 * API versions — which is a change that compiles either way if you write it
 * from memory, because the property simply is not there and the value is
 * `undefined`. The renewal date would then have been permanently blank, on a
 * screen whose whole job is to say when you are next charged.
 *
 * Seconds to milliseconds: Stripe sends Unix seconds, and `new Date(seconds)`
 * lands in January 1970 rather than failing.
 */
/**
 * Statuses that mean somebody has to do something.
 *
 * `past_due` and `unpaid` are payment failures at different stages;
 * `incomplete` is a checkout that never finished authorising. `canceled` is
 * deliberately absent — it is a finished state, not an outstanding task, and
 * flagging it would leave a warning on screen forever for an organisation that
 * chose to leave.
 */
const ATTENTION_STATUSES = ["past_due", "unpaid", "incomplete"];

function periodEndOf(sub: Stripe.Subscription): Date | null {
  const seconds = sub.items.data[0]?.current_period_end;
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}

/** Where the checkout was launched from — controls the return URLs. */
/**
 * Where checkout was started from, which decides where Stripe sends the person
 * back to.
 *
 * `"settings"` is kept although nothing starts checkout there any more: the
 * upgrade card moved to the billing page, and a URL Stripe was given BEFORE
 * that move can still be walked by somebody who left the tab open. Removing the
 * branch would land those people on a page with no `?checkout=` handler — they
 * would pay and see nothing acknowledge it, which is the failure mode worth
 * paying one dead branch to avoid.
 */
export type CheckoutSource = "onboarding" | "settings" | "billing";

interface CreateCheckoutParams {
  organizationId: string;
  userId: string;
  userEmail: string;
  interval: BillingInterval;
  source: CheckoutSource;
  /** Absolute origin of the current request, e.g. "http://localhost:3000". */
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
  private subscriptionService = new SubscriptionService();

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
    });

    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL");
    }

    void this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.CHECKOUT_STARTED,
      entityType: "subscription",
      entityId: session.id,
      details: { interval, source, plan: "pro" },
    });

    return session.url;
  }

  /** Build success/cancel URLs based on where checkout was launched. */
  private returnUrls(source: CheckoutSource, origin: string, orgId: string) {
    /*
     * Both land on a page that reads `?checkout=`. That pairing is the thing to
     * keep true: a return URL pointing at a page without the handler means
     * somebody pays and nothing on screen acknowledges it.
     */
    if (source === "billing" || source === "settings") {
      const base = `${origin}/org/${orgId}/${source}`;
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
  /**
   * Everything the billing page shows, in one call.
   *
   * ## `subscriptionStatus` is the reason this exists
   *
   * The webhook has been writing that column since Stripe was wired up, and
   * until now nothing read it. So an organisation whose card failed was set to
   * `past_due` in the database and NOBODY was told — not the admin, not the
   * platform console — and they kept full access until Stripe gave up, at which
   * point the tier silently dropped to Free. A status something writes and
   * nothing reads is the same defect as a column nothing writes, seen from the
   * other side.
   *
   * ## Why `needsAttention` is derived here and not in the page
   *
   * Which Stripe statuses are somebody's problem is a billing judgement, not a
   * styling one. Deciding it in the component would put it beyond the reach of
   * a test and out of sight of anybody adding a status later.
   */
  async getOverview(organizationId: string) {
    const billing = await this.billingRepo.getByOrgId(organizationId);
    const usage = await this.subscriptionService.getUsage(organizationId);

    const status = billing?.subscriptionStatus ?? null;
    return {
      tier: usage.tier,
      status,
      /*
       * Stripe's own vocabulary, kept rather than translated. `past_due` means
       * a payment failed and it is retrying; `unpaid` means it has stopped
       * trying. Collapsing them into one word would lose the difference between
       * "fix your card" and "your access is about to end".
       */
      needsAttention: status !== null && ATTENTION_STATUSES.includes(status),
      interval: billing?.billingInterval ?? null,
      currentPeriodEnd: billing?.currentPeriodEnd ?? null,
      /** True once Stripe knows this organisation — the portal needs it. */
      hasStripeCustomer: Boolean(billing?.stripeCustomerId),
      usage,
    };
  }

  /**
   * A link into Stripe's hosted billing portal.
   *
   * Invoices, payment methods and cancellation all live there rather than
   * here, deliberately. Building them would mean storing copies of figures we
   * do not own, and every copy is a chance to show somebody an amount that
   * disagrees with what they were charged — while card details would have to
   * pass through this application to be edited.
   *
   * Throws rather than returning null when the organisation has never paid:
   * there is no portal for a customer Stripe has never met, and a button that
   * silently does nothing is worse than one that is not offered.
   */
  async createPortalSession(
    organizationId: string,
    returnUrl: string
  ): Promise<string> {
    const billing = await this.billingRepo.getByOrgId(organizationId);
    if (!billing?.stripeCustomerId) {
      throw new Error("This organisation has no billing account yet");
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: returnUrl,
    });
    return session.url;
  }

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
        await this.onCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.updated":
        await this.onSubscriptionChanged(event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await this.onSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      default:
        // Unhandled event types are acknowledged (200) but ignored.
        break;
    }
  }

  /** Payment completed — grant the Pro tier. */
  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const organizationId =
      session.metadata?.organizationId ?? session.client_reference_id ?? null;
    if (!organizationId) {
      console.error("[Billing] checkout.session.completed missing organizationId");
      return;
    }

    const interval = session.metadata?.interval;
    const updated = await this.billingRepo.applySubscriptionState(organizationId, {
      subscriptionTier: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: toId(session.customer),
      stripeSubscriptionId: toId(session.subscription),
      billingInterval: isBillingInterval(interval) ? interval : null,
    });

    void this.auditService.log({
      organizationId,
      userId: session.metadata?.userId,
      action: ACTIONS.SUBSCRIPTION_UPGRADED,
      entityType: "subscription",
      entityId: toId(session.subscription) ?? session.id,
      details: { tier: updated.subscriptionTier, interval: updated.billingInterval },
    });
  }

  /**
   * Subscription changed (renewal, payment issue, plan change).
   * Maps Stripe status → our tier: active/trialing keep Pro; terminal states
   * drop to free. past_due/incomplete keep Pro but record the status so the UI
   * can warn.
   */
  private async onSubscriptionChanged(sub: Stripe.Subscription): Promise<void> {
    const organizationId = await this.resolveOrgId(sub);
    if (!organizationId) return;

    const terminal = ["canceled", "unpaid", "incomplete_expired"];
    const tier = terminal.includes(sub.status) ? "free" : "pro";
    const interval = sub.items.data[0]?.price.recurring?.interval;

    await this.billingRepo.applySubscriptionState(organizationId, {
      subscriptionTier: tier,
      subscriptionStatus: sub.status,
      stripeSubscriptionId: sub.id,
      billingInterval: isBillingInterval(interval) ? interval : null,
      currentPeriodEnd: periodEndOf(sub),
    });

    void this.auditService.log({
      organizationId,
      action: ACTIONS.SUBSCRIPTION_UPDATED,
      entityType: "subscription",
      entityId: sub.id,
      details: { status: sub.status, tier },
    });
  }

  /** Subscription fully deleted — revert to free. */
  private async onSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
    const organizationId = await this.resolveOrgId(sub);
    if (!organizationId) return;

    await this.billingRepo.applySubscriptionState(organizationId, {
      subscriptionTier: "free",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: null,
      billingInterval: null,
      // Cleared with the rest. A renewal date left behind on a cancelled
      // subscription is a screen promising a charge that will never happen.
      currentPeriodEnd: null,
    });

    void this.auditService.log({
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
