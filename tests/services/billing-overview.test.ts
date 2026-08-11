/**
 * The billing overview — the first reader `subscriptionStatus` has ever had.
 *
 * The Stripe webhook has written that column since billing was wired up and
 * nothing read it, so an organisation whose card failed sat at `past_due` with
 * nobody told: not the admin, not the platform console. They kept full access
 * until Stripe gave up, at which point the tier dropped to Free with no
 * explanation anywhere.
 *
 * A status something writes and nothing reads is the same defect as a column
 * nothing writes, seen from the other side — and neither can fail a test that
 * does not exist. These are that test.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { BillingService } from "@/services/billing.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new BillingService();
let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("billing");
});

const setBilling = (data: Record<string, unknown>) =>
  prisma.organization.update({ where: { id: tenant.orgId }, data });

describe("what the page is told", () => {
  it("reports a healthy subscription as needing nothing", async () => {
    await setBilling({ subscriptionTier: "pro", subscriptionStatus: "active" });

    const overview = await service.getOverview(tenant.orgId);

    expect(overview.status).toBe("active");
    expect(overview.needsAttention).toBe(false);
  });

  /*
   * The case the whole feature exists for. A failed card must reach a human.
   */
  it("flags a failed payment", async () => {
    await setBilling({ subscriptionTier: "pro", subscriptionStatus: "past_due" });

    expect((await service.getOverview(tenant.orgId)).needsAttention).toBe(true);
  });

  it("flags one that has stopped being retried", async () => {
    await setBilling({ subscriptionTier: "pro", subscriptionStatus: "unpaid" });

    expect((await service.getOverview(tenant.orgId)).needsAttention).toBe(true);
  });

  it("flags a checkout that never finished authorising", async () => {
    await setBilling({ subscriptionStatus: "incomplete" });

    expect((await service.getOverview(tenant.orgId)).needsAttention).toBe(true);
  });

  /*
   * Cancelled is NOT an outstanding task. Flagging it would leave a warning on
   * screen forever for an organisation that chose to leave — which is how a
   * warning stops meaning anything.
   */
  it("does not nag an organisation that chose to cancel", async () => {
    await setBilling({ subscriptionTier: "free", subscriptionStatus: "canceled" });

    expect((await service.getOverview(tenant.orgId)).needsAttention).toBe(false);
  });

  it("says nothing is wrong when there is no subscription at all", async () => {
    // A Free organisation that never started checkout has a null status, and
    // `null` must not read as a problem.
    await setBilling({ subscriptionTier: "free", subscriptionStatus: null });

    const overview = await service.getOverview(tenant.orgId);

    expect(overview.status).toBeNull();
    expect(overview.needsAttention).toBe(false);
  });

  it("carries the interval and the renewal date through", async () => {
    const ends = new Date("2026-12-01T00:00:00Z");
    await setBilling({
      subscriptionTier: "pro",
      subscriptionStatus: "active",
      billingInterval: "year",
      currentPeriodEnd: ends,
    });

    const overview = await service.getOverview(tenant.orgId);

    expect(overview.interval).toBe("year");
    expect(overview.currentPeriodEnd).toEqual(ends);
  });

  /*
   * The portal button hangs off this. There is no Stripe portal for a customer
   * Stripe has never met, and a button that silently fails is worse than one
   * that is not offered.
   */
  it("says whether Stripe knows this organisation", async () => {
    expect((await service.getOverview(tenant.orgId)).hasStripeCustomer).toBe(false);

    await setBilling({ stripeCustomerId: "cus_test_123" });

    expect((await service.getOverview(tenant.orgId)).hasStripeCustomer).toBe(true);
  });

  it("includes usage, so the page needs one call and not two", async () => {
    const overview = await service.getOverview(tenant.orgId);

    expect(overview.usage.resources.members.current).toBeGreaterThan(0);
  });
});

describe("the billing portal", () => {
  it("refuses when the organisation has never been charged", async () => {
    // Reaches Stripe only when there is a customer to reach it about, so this
    // is a real refusal rather than a network error dressed as one.
    await expect(
      service.createPortalSession(tenant.orgId, "https://example.test/back")
    ).rejects.toThrow(/no billing account/i);
  });
});
