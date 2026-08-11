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
import {
  isBillingInterval,
  paidPlanLineItem,
  proPlanLineItem,
  BILLING_CURRENCY,
} from "@/lib/stripe";
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

describe("paidPlanLineItem", () => {
  it("builds the Enterprise monthly price from the tier configuration", () => {
    const item = paidPlanLineItem("enterprise", "month").price_data!;

    expect(item.unit_amount).toBe(
      Math.round((TIER_CONFIG.enterprise.monthlyPrice as number) * 100)
    );
    expect(item.product_data?.name).toBe("ShiftHappens Enterprise");
  });
});
