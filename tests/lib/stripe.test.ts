/**
 * Tests for the Stripe client helpers (Infrastructure).
 *
 * Covers the pure, side-effect-free helpers:
 * - isBillingInterval type guard
 * - proPlanLineItem builder (amounts derived from TIER_CONFIG, in cents)
 *
 * The Stripe SDK singleton (getStripe) is not exercised here — it requires a
 * secret key and is covered indirectly through the billing service tests.
 */
import { describe, it, expect } from "vitest";
import { isBillingInterval, proPlanLineItem, BILLING_CURRENCY, getTrustedAppOrigin } from "@/lib/stripe";
import { TIER_CONFIG } from "@/lib/subscription-tiers";

describe("isBillingInterval", () => {
  it("accepts 'month' and 'year'", () => {
    expect(isBillingInterval("month")).toBe(true);
    expect(isBillingInterval("year")).toBe(true);
  });

  it("rejects any other value", () => {
    expect(isBillingInterval("week")).toBe(false);
    expect(isBillingInterval("")).toBe(false);
    expect(isBillingInterval(null)).toBe(false);
    expect(isBillingInterval(undefined)).toBe(false);
    expect(isBillingInterval(12)).toBe(false);
  });
});

describe("getTrustedAppOrigin", () => {
  it("uses NEXTAUTH_URL instead of the request host", () => {
    const previous = process.env.NEXTAUTH_URL;
    process.env.NEXTAUTH_URL = "https://app.shifthappens.example/path";
    try {
      expect(getTrustedAppOrigin("https://untrusted.example")).toBe("https://app.shifthappens.example");
    } finally {
      if (previous === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = previous;
    }
  });

  it("allows a localhost fallback for development only", () => {
    const previous = process.env.NEXTAUTH_URL;
    delete process.env.NEXTAUTH_URL;
    try {
      expect(getTrustedAppOrigin("http://localhost:3000")).toBe("http://localhost:3000");
      expect(() => getTrustedAppOrigin("https://untrusted.example")).toThrow(/NEXTAUTH_URL/);
    } finally {
      if (previous !== undefined) process.env.NEXTAUTH_URL = previous;
    }
  });
});

describe("proPlanLineItem", () => {
  it("builds a monthly line item priced from TIER_CONFIG in cents", () => {
    const item = proPlanLineItem("month");

    expect(item.quantity).toBe(1);
    // price_data is present because we use inline pricing (no pre-created Price IDs).
    const priceData = item.price_data!;
    expect(priceData.currency).toBe(BILLING_CURRENCY);
    expect(priceData.unit_amount).toBe(
      Math.round((TIER_CONFIG.pro.monthlyPrice as number) * 100)
    );
    expect(priceData.recurring?.interval).toBe("month");
    expect(priceData.product_data?.name).toBe("ShiftHappens Pro");
  });

  it("builds a yearly line item priced from TIER_CONFIG in cents", () => {
    const item = proPlanLineItem("year");

    const priceData = item.price_data!;
    expect(priceData.unit_amount).toBe(
      Math.round((TIER_CONFIG.pro.yearlyPrice as number) * 100)
    );
    expect(priceData.recurring?.interval).toBe("year");
  });

  it("uses different amounts for monthly vs yearly", () => {
    const monthly = proPlanLineItem("month").price_data!.unit_amount;
    const yearly = proPlanLineItem("year").price_data!.unit_amount;
    expect(monthly).not.toBe(yearly);
  });
});
