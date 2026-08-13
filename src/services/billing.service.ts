/**
 * Billing Service (Control Layer)
 *
 * Owns the Stripe checkout lifecycle for paid-plan subscriptions:
 *   1. createCheckoutSession — builds a Stripe Checkout Session for an org
 *      and returns the hosted-payment URL to redirect the user to.
 *   2. constructEvent — verifies a raw webhook payload against the signing
 *      secret (rejects forged calls).
 *   3. handleEvent — applies verified subscription events to the org's tier.
 *
 * Tier changes are ONLY ever driven by what Stripe says, never by the client —
 * the client can start a checkout, but the upgrade is not granted until Stripe
 * confirms payment. This prevents a user from self-upgrading by calling an
 * endpoint.
 *
 * Two paths carry that confirmation: `handleEvent`, from the webhook, and
 * `reconcileCheckout`, from the redirect back. The second exists because the
 * first is delivered out of band and can silently not arrive — see the note on
 * that method. Both end at the same handler, so neither can drift from the
 * other, and whichever runs second is a no-op.
 */
import Stripe from "stripe";
import {
  getStripe,
  paidPlanLineItem,
  createPlanPrice,
  isBillingInterval,
  type BillingInterval,
  type PaidPlan,
} from "@/lib/stripe";
import { BillingRepository } from "@/repositories/billing.repository";
import { SubscriptionRepository } from "@/repositories/subscription.repository";
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
 * Since success always returns to the billing page, this now only decides where
 * CANCELLING lands you.
 *
 * `"settings"` is kept although nothing starts checkout there any more: the
 * upgrade card moved to the billing page, and a URL Stripe was given BEFORE
 * that move can still be walked by somebody who left the tab open. Removing the
 * branch would send those people to `/org/{id}/undefined`.
 */
export type CheckoutSource = "onboarding" | "settings" | "billing";

interface CreateCheckoutParams {
  organizationId: string;
  userId: string;
  userEmail: string;
  interval: BillingInterval;
  plan?: PaidPlan;
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
  private subscriptionRepo = new SubscriptionRepository();
  private auditService = new AuditLogService();
  private subscriptionService = new SubscriptionService();

  /**
   * Create a Stripe Checkout Session for the chosen paid plan and return its URL.
   * Reuses an existing Stripe customer for the org when one exists, otherwise
   * creates one and stores its id.
   */
  async createCheckoutSession(params: CreateCheckoutParams): Promise<string> {
    const {
      organizationId,
      userId,
      userEmail,
      interval,
      plan = "pro",
      source,
      origin,
    } = params;
    const stripe = getStripe();

    const org = await this.billingRepo.getByOrgId(organizationId);
    if (!org) throw new Error("Organization not found");
    if (org.stripeSubscriptionId) {
      throw new Error(
        "This organisation already has a Stripe subscription. Manage it in the billing portal."
      );
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

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [paidPlanLineItem(plan, interval)],
      client_reference_id: organizationId,
      // Metadata on the session (read in checkout.session.completed) and on the
      // resulting subscription (read in customer.subscription.* events).
      metadata: { organizationId, userId, tier: plan, interval },
      subscription_data: {
        metadata: { organizationId, tier: plan },
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
      details: { interval, source, plan },
    });

    return session.url;
  }

  /** Build success/cancel URLs based on where checkout was launched. */
  private returnUrls(source: CheckoutSource, origin: string, orgId: string) {
    /*
     * Success always lands on the billing page, whatever launched the checkout.
     *
     * It used to land back on the source page, and the rule that made that safe
     * was "every return URL must point at a page that reads `?checkout=`". Only
     * the billing page ever had that handler. Onboarding therefore sent buyers
     * to `/dashboard?checkout=success`, where nothing read it and nothing
     * acknowledged the payment — and because the dashboard route redirects into
     * the org, the parameter did not even survive the trip. Somebody paid for
     * Pro and watched their new workspace say Free.
     *
     * Pointing every success at the one page that handles it removes the rule
     * rather than restating it, and it is the page a person actually wants
     * after paying: it says what they now have.
     *
     * `{CHECKOUT_SESSION_ID}` is substituted by Stripe, not by us. The billing
     * page hands it back to `reconcileCheckout`, which is what makes the upgrade
     * appear even when the webhook is slow, misconfigured, or — on localhost —
     * cannot reach the application at all.
     */
    const successUrl =
      `${origin}/org/${orgId}/billing` +
      `?checkout=success&session_id={CHECKOUT_SESSION_ID}`;

    /*
     * Cancelling returns you where you started, because nothing has changed and
     * there is nothing to confirm. Onboarding is the one source whose starting
     * point is not an org page.
     */
    const cancelBase =
      source === "onboarding"
        ? `${origin}/dashboard`
        : `${origin}/org/${orgId}/${source}`;

    return { successUrl, cancelUrl: `${cancelBase}?checkout=canceled` };
  }

  /**
   * Grant the tier for a checkout the browser has just returned from.
   *
   * ## Why this exists when the webhook already does it
   *
   * The webhook is the source of truth and stays that way. But it is delivered
   * out of band, to a public URL, and every one of those conditions has failed
   * on this project: it cannot reach `localhost` at all during development, and
   * in production it is one misconfigured endpoint secret away from silence.
   * The failure is invisible and expensive — the charge succeeds, the tier does
   * not move, and the person who just paid is looking at the plan they were
   * trying to leave.
   *
   * So this is a SECOND path to the same write, taken on the redirect back.
   * Whichever arrives first wins and the other becomes a no-op.
   *
   * ## This does not let a client grant itself a tier
   *
   * The class contract is that tier changes come only from Stripe, never from
   * the caller, and that still holds. The client supplies an id; everything
   * decided from there is read back FROM Stripe. A session that was not paid
   * grants nothing, and a session belonging to another organisation grants
   * nothing — the id is a lookup key, not an assertion to be trusted.
   *
   * @returns the tier now in force, or null if the session granted nothing.
   */
  async reconcileCheckout(
    sessionId: string,
    organizationId: string
  ): Promise<string | null> {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);

    /*
     * The session must belong to the organisation being claimed for.
     *
     * Without this, an admin of their own free org could paste somebody else's
     * session id and be upgraded on a stranger's payment. Checked against the
     * same fields `onCheckoutCompleted` resolves the org from, so the two
     * cannot disagree about whose session this is.
     */
    const owner =
      session.metadata?.organizationId ?? session.client_reference_id ?? null;
    if (owner !== organizationId) return null;

    // `paid` is the only status that bought anything. `unpaid` covers a
    // checkout that was opened and abandoned, which is the common case for a
    // success URL being walked a second time from history.
    if (session.payment_status !== "paid") return null;

    /*
     * Already applied — almost always by the webhook, occasionally by an
     * earlier visit to this same URL. Returning the tier without rewriting it
     * keeps the audit log honest: an upgrade happened once, and the log should
     * say so once, however many times the page is refreshed.
     */
    const current = await this.billingRepo.getByOrgId(organizationId);
    const subscriptionId = toId(session.subscription);
    if (
      current?.stripeSubscriptionId &&
      current.stripeSubscriptionId === subscriptionId
    ) {
      return current.subscriptionTier;
    }

    // Deliberately the webhook's own handler rather than a copy of it. Two
    // routes to the same outcome are worth having; two implementations of it
    // are not.
    await this.onCheckoutCompleted(session);

    const updated = await this.billingRepo.getByOrgId(organizationId);
    return updated?.subscriptionTier ?? null;
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
      /*
       * Turns `currentPeriodEnd` from a renewal date into an expiry date. The
       * page shows one or the other from this flag; without it a cancelled
       * subscription still advertised its next charge.
       */
      cancelAtPeriodEnd: billing?.cancelAtPeriodEnd ?? false,
      /** True once Stripe knows this organisation — the portal needs it. */
      hasStripeCustomer: Boolean(billing?.stripeCustomerId),
      // Checkout creates a customer before a payment succeeds. This is kept
      // separate so an abandoned checkout cannot look cancellable.
      hasStripeSubscription: Boolean(billing?.stripeSubscriptionId),
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

  /**
   * Stop the subscription at the END of the paid period.
   *
   * Not an immediate cancellation, and the difference is the whole point: the
   * organisation has paid up to `currentPeriodEnd`, and revoking access the
   * instant somebody clicks would take away time already bought. Stripe emits
   * `customer.subscription.deleted` when the period actually expires, and the
   * existing handler drops the tier then — so the downgrade happens once, in
   * the place every other tier change happens, rather than twice from two
   * directions.
   *
   * Returns when access ends, so the caller can say so rather than implying
   * the plan is already gone.
   */
  async cancelSubscription(
    organizationId: string,
    userId: string
  ): Promise<{ accessUntil: Date | null }> {
    const billing = await this.billingRepo.getByOrgId(organizationId);
    if (!billing?.stripeSubscriptionId) {
      throw new Error("This organisation has no subscription to cancel");
    }

    const updated = await getStripe().subscriptions.update(
      billing.stripeSubscriptionId,
      { cancel_at_period_end: true }
    );

    void this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.SUBSCRIPTION_CANCELED,
      entityType: "subscription",
      entityId: billing.stripeSubscriptionId,
      details: { scheduled: true, tier: billing.subscriptionTier },
    });

    return { accessUntil: periodEndOf(updated) };
  }

  /**
   * Undo a scheduled cancellation.
   *
   * The counterpart to `cancelSubscription`, and the reason cancelling is
   * scheduled rather than immediate: between clicking and the period ending
   * there is a window in which somebody can change their mind, and it should
   * cost them one button rather than a new checkout at a price that may have
   * moved.
   */
  async resumeSubscription(
    organizationId: string,
    userId: string
  ): Promise<void> {
    const billing = await this.billingRepo.getByOrgId(organizationId);
    if (!billing?.stripeSubscriptionId) {
      throw new Error("This organisation has no subscription to resume");
    }

    await getStripe().subscriptions.update(billing.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    void this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.SUBSCRIPTION_UPDATED,
      entityType: "subscription",
      entityId: billing.stripeSubscriptionId,
      details: { resumed: true },
    });
  }

  /**
   * Move an existing subscription to a different paid plan.
   *
   * Replaces the price on the subscription's single item rather than creating a
   * second subscription — `createCheckoutSession` refuses outright when one
   * already exists, and two live subscriptions would bill the same organisation
   * twice for the same product.
   *
   * `proration_behavior: "create_prorations"` is what makes a DOWNGRADE fair:
   * the unused remainder of the dearer plan becomes a credit against the
   * cheaper one, so somebody stepping from Enterprise to Pro in week one is not
   * charged twice for the same month. Without it the switch would silently cost
   * them the balance of what they had already paid.
   *
   * The tier is NOT written here. Stripe emits `customer.subscription.updated`,
   * and that handler applies it — the same single path every other tier change
   * takes, so a failed write cannot leave the plan and the billing disagreeing.
   */
  async changePlan(
    organizationId: string,
    plan: PaidPlan,
    userId: string
  ): Promise<void> {
    const billing = await this.billingRepo.getByOrgId(organizationId);
    if (!billing?.stripeSubscriptionId) {
      throw new Error("This organisation has no subscription to change");
    }

    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(
      billing.stripeSubscriptionId
    );
    const item = subscription.items.data[0];
    if (!item) {
      throw new Error("This subscription has no billable item to change");
    }

    // Keep whatever cadence they are already on; this call changes the PLAN,
    // not the billing interval, and silently flipping someone from annual to
    // monthly would change what they pay next without them asking.
    const interval = item.price.recurring?.interval;
    const priceId = await createPlanPrice(
      plan,
      isBillingInterval(interval) ? interval : "month"
    );

    await stripe.subscriptions.update(billing.stripeSubscriptionId, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: "create_prorations",
      metadata: { organizationId, tier: plan },
    });

    void this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.SUBSCRIPTION_UPDATED,
      entityType: "subscription",
      entityId: billing.stripeSubscriptionId,
      details: { from: billing.subscriptionTier, to: plan },
    });
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

  /** Payment completed — grant the tier that was bought. */
  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const organizationId =
      session.metadata?.organizationId ?? session.client_reference_id ?? null;
    if (!organizationId) {
      console.error("[Billing] checkout.session.completed missing organizationId");
      return;
    }

    /*
     * Only a SUBSCRIPTION checkout may write the tier.
     *
     * Everything below assumes this session bought a plan: the tier falls back
     * to "pro" when metadata does not say otherwise, and `session.subscription`
     * is written straight through. Both are wrong for any other kind of
     * checkout — a one-off session carries no subscription, so an Enterprise
     * organisation buying anything at all would have been demoted to Pro and
     * had its subscription id set to null, by the success path, silently.
     *
     * Guarding on the mode rather than on the presence of a subscription id
     * keeps that reasoning visible: this handler is about plans, and a session
     * that did not buy a plan is not its business.
     */
    if (session.mode !== "subscription") {
      return;
    }

    const interval = session.metadata?.interval;
    const tier = session.metadata?.tier === "enterprise" ? "enterprise" : "pro";
    const updated = await this.billingRepo.applySubscriptionState(organizationId, {
      subscriptionTier: tier,
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
    const tier = terminal.includes(sub.status)
      ? "free"
      : sub.metadata?.tier === "enterprise"
        ? "enterprise"
        : "pro";
    const interval = sub.items.data[0]?.price.recurring?.interval;

    await this.billingRepo.applySubscriptionState(organizationId, {
      subscriptionTier: tier,
      subscriptionStatus: sub.status,
      stripeSubscriptionId: sub.id,
      billingInterval: isBillingInterval(interval) ? interval : null,
      currentPeriodEnd: periodEndOf(sub),
      /*
       * Captured here rather than at the moment we call Stripe, so a
       * cancellation scheduled from the Stripe portal — which this application
       * never sees the request for — lands in the database the same way as one
       * scheduled from our own button.
       */
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
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
      // The cancellation has now HAPPENED, so it is no longer scheduled. Left
      // true, the free tier would keep showing "your plan ends on…" about a
      // plan that already ended.
      cancelAtPeriodEnd: false,
    });

    /*
     * Purchased project quota goes with the subscription that carried it.
     * The add-on is a recurring item on that subscription, so once it is gone
     * nothing is being charged for the quota — and quota that outlives its
     * payments is indistinguishable from a free permanent upgrade.
     *
     * Deliberately AFTER the tier reset and not merged into it: this is a
     * different question (what was bought) from the one above (what plan is
     * held), and the free tier allows no projects at all, so leaving a stale
     * addon here would grant an ex-customer exactly the projects they stopped
     * paying for.
     */
    await this.subscriptionRepo.setProjectQuotaAddon(organizationId, 0);

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
