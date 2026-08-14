/**
 * Stripe Client (Infrastructure)
 *
 * Singleton Stripe SDK instance plus helpers for building Checkout line items
 * from our tier config. We use inline `price_data` rather than pre-created
 * Stripe Price IDs so the sandbox works with just a secret key — no products
 * need to be set up in the Stripe dashboard first.
 *
 * Paid plans are purchasable via Checkout. Free needs no payment.
 */
import Stripe from "stripe";
import { TIER_CONFIG } from "@/lib/subscription-tiers";

/** Lazily-constructed singleton so a missing key only errors when billing is actually used. */
let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error(
        "STRIPE_SECRET_KEY is not set. Add your Stripe test key to .env.local."
      );
    }
    // apiVersion is intentionally omitted — the SDK uses its bundled pinned version.
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

export const BILLING_CURRENCY = "usd";

export type BillingInterval = "month" | "year";

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "month" || value === "year";
}

/**
 * Build the Checkout line item for the Pro plan at the given interval.
 * Amount is derived from TIER_CONFIG (single source of truth) and converted to cents.
 */
export type PaidPlan = "pro" | "enterprise";

export function paidPlanLineItem(
  plan: PaidPlan,
  interval: BillingInterval
): Stripe.Checkout.SessionCreateParams.LineItem {
  const tier = TIER_CONFIG[plan];
  const dollars = interval === "year" ? tier.yearlyPrice : tier.monthlyPrice;

  if (dollars == null) {
    throw new Error(`${tier.displayName} plan pricing is not configured.`);
  }

  return {
    quantity: 1,
    price_data: {
      currency: BILLING_CURRENCY,
      product_data: {
        name: `ShiftHappens ${tier.displayName}`,
        description: tier.tagline,
      },
      unit_amount: Math.round(dollars * 100),
      recurring: { interval },
    },
  };
}

/**
 * One extra permanent project slot.
 *
 * Priced in cents as an integer so the money never goes through a float:
 * `3.99 * 100` is 398.99999999999994 in IEEE 754, and `Math.round` would save
 * this particular number while quietly mis-charging some other one later.
 */
export const PROJECT_SLOT_PRICE_CENTS = 399;

/** The same figure as a string, for anything that has to say it out loud. */
export const PROJECT_SLOT_PRICE_LABEL = "$3.99";

/** How many slots may be bought in one go — a sanity bound, not a policy. */
export const MAX_SLOTS_PER_PURCHASE = 50;

/**
 * A one-off charge for project slots.
 *
 * `recurring` is deliberately absent, which is what makes the whole checkout
 * `mode: "payment"` rather than `"subscription"`. The thing being bought is
 * permanent — a project cannot be archived and only an empty one can be
 * deleted — so billing for it every month would be a charge that never ends for
 * something that was finished long ago, on a bill that only ever goes up.
 *
 * That mode is also what keeps this away from the tier: `onCheckoutCompleted`
 * returns early on anything that is not a subscription, so buying slots cannot
 * accidentally rewrite the plan.
 */
export function projectSlotLineItem(
  quantity: number
): Stripe.Checkout.SessionCreateParams.LineItem {
  return {
    quantity,
    price_data: {
      currency: BILLING_CURRENCY,
      product_data: {
        name: "ShiftHappens project slot",
        description:
          "One additional project, kept permanently. Projects are not deleted once work has been added to them.",
      },
      unit_amount: PROJECT_SLOT_PRICE_CENTS,
    },
  };
}

/** Backwards-compatible convenience for the existing Pro checkout callers. */
export function proPlanLineItem(interval: BillingInterval) {
  return paidPlanLineItem("pro", interval);
}

/**
 * A Price id for a plan, created on demand.
 *
 * Changing the plan on an EXISTING subscription cannot use the inline
 * `price_data` above: a subscription item's price_data requires `product` — an
 * id that must already exist — whereas Checkout accepts `product_data` and
 * makes the product for you. The two shapes look alike and are not
 * interchangeable, which is why this is a separate function rather than a
 * cast.
 *
 * `prices.create` does accept `product_data`, so a price and its product are
 * still made in one call and nothing has to be set up in the Stripe dashboard
 * first — the property the inline line items were chosen for is kept.
 *
 * Amounts come from TIER_CONFIG, so a price change in one file moves checkout
 * and plan changes together.
 */
export async function createPlanPrice(
  plan: PaidPlan,
  interval: BillingInterval
): Promise<string> {
  const tier = TIER_CONFIG[plan];
  const dollars = interval === "year" ? tier.yearlyPrice : tier.monthlyPrice;

  if (dollars == null) {
    throw new Error(`${tier.displayName} plan pricing is not configured.`);
  }

  const price = await getStripe().prices.create({
    currency: BILLING_CURRENCY,
    unit_amount: Math.round(dollars * 100),
    recurring: { interval },
    product_data: { name: `ShiftHappens ${tier.displayName}` },
  });

  return price.id;
}
