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

/** Backwards-compatible convenience for the existing Pro checkout callers. */
export function proPlanLineItem(interval: BillingInterval) {
  return paidPlanLineItem("pro", interval);
}
