/**
 * Stripe Client (Infrastructure)
 *
 * Singleton Stripe SDK instance plus helpers for building Checkout line items
 * from our tier config. We use inline `price_data` rather than pre-created
 * Stripe Price IDs so the sandbox works with just a secret key — no products
 * need to be set up in the Stripe dashboard first.
 *
 * Only the Pro plan is purchasable via Checkout. Free needs no payment and
 * Enterprise is "contact us" (custom pricing).
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
 * Checkout redirects must use the configured application origin in deployed
 * environments, never a user-controlled Host header. Local development keeps
 * the request origin as a practical fallback.
 */
export function getTrustedAppOrigin(requestOrigin: string): string {
  const configured = process.env.NEXTAUTH_URL;
  if (configured) return new URL(configured).origin;

  const parsed = new URL(requestOrigin);
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    return parsed.origin;
  }
  throw new Error("NEXTAUTH_URL must be configured for Stripe billing.");
}

/**
 * Build the Checkout line item for the Pro plan at the given interval.
 * Amount is derived from TIER_CONFIG (single source of truth) and converted to cents.
 */
export function proPlanLineItem(
  interval: BillingInterval
): Stripe.Checkout.SessionCreateParams.LineItem {
  const pro = TIER_CONFIG.pro;
  const dollars = interval === "year" ? pro.yearlyPrice : pro.monthlyPrice;

  if (dollars == null) {
    // Pro always has concrete prices; this guards against future config changes.
    throw new Error("Pro plan pricing is not configured.");
  }

  return {
    quantity: 1,
    price_data: {
      currency: BILLING_CURRENCY,
      product_data: {
        name: "ShiftHappens Pro",
        description: pro.tagline,
      },
      unit_amount: Math.round(dollars * 100),
      recurring: { interval },
    },
  };
}
