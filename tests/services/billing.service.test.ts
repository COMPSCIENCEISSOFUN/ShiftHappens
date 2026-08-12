/**
 * Tests for Billing Service (Control Layer)
 *
 * The Stripe SDK is mocked (via @/lib/stripe.getStripe) so no network calls
 * are made. The pure helpers (proPlanLineItem, isBillingInterval) remain real.
 * Repository writes hit the real test database so we can assert the org's tier
 * actually changes in response to (verified) Stripe events.
 *
 * Key invariant under test: tier changes are ONLY ever driven by webhook
 * events (handleEvent), never by createCheckoutSession.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";

// Hoisted mock stripe client shared with the module mock below.
const mockStripe = vi.hoisted(() => ({
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  webhooks: { constructEventAsync: vi.fn() },
}));

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    ...actual,
    getStripe: () => mockStripe as unknown as Stripe,
  };
});

import { BillingService } from "@/services/billing.service";
import { BillingRepository } from "@/repositories/billing.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const billingService = new BillingService();
const billingRepo = new BillingRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let userId: string;

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();

  const user = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  userId = user.id;

  const org = await orgRepo.create(
    { name: "Ocean Grill", slug: "ocean-grill" },
    user.id
  );
  orgId = org.id;
});

/** Build a minimal Stripe.Event of the given type wrapping `object`. */
function event(type: string, object: unknown): Stripe.Event {
  return { type, data: { object } } as unknown as Stripe.Event;
}

describe("BillingService.createCheckoutSession", () => {
  beforeEach(() => {
    mockStripe.customers.create.mockResolvedValue({ id: "cus_NEW" });
    mockStripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_test_1",
      url: "https://checkout.stripe.com/pay/cs_test_1",
    });
  });

  it("creates a Stripe customer, stores its id, and returns the checkout URL", async () => {
    const url = await billingService.createCheckoutSession({
      organizationId: orgId,
      userId,
      userEmail: "admin@example.com",
      interval: "month",
      source: "settings",
      origin: "http://localhost:3000",
    });

    expect(url).toBe("https://checkout.stripe.com/pay/cs_test_1");
    expect(mockStripe.customers.create).toHaveBeenCalledOnce();
    expect(mockStripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "admin@example.com",
        name: "Ocean Grill",
        metadata: { organizationId: orgId },
      })
    );

    // Customer id was persisted.
    const billing = await billingRepo.getByOrgId(orgId);
    expect(billing!.stripeCustomerId).toBe("cus_NEW");
  });

  it("does NOT upgrade the org tier (upgrade only happens on webhook)", async () => {
    await billingService.createCheckoutSession({
      organizationId: orgId,
      userId,
      userEmail: "admin@example.com",
      interval: "month",
      source: "settings",
      origin: "http://localhost:3000",
    });

    const billing = await billingRepo.getByOrgId(orgId);
    expect(billing!.subscriptionTier).toBe("free");
  });

  it("reuses an existing Stripe customer instead of creating a new one", async () => {
    await billingRepo.setStripeCustomerId(orgId, "cus_EXISTING");

    await billingService.createCheckoutSession({
      organizationId: orgId,
      userId,
      userEmail: "admin@example.com",
      interval: "year",
      source: "settings",
      origin: "http://localhost:3000",
    });

    expect(mockStripe.customers.create).not.toHaveBeenCalled();
    const sessionArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(sessionArgs.customer).toBe("cus_EXISTING");
  });

  it("builds settings return URLs pointing back at the settings page", async () => {
    await billingService.createCheckoutSession({
      organizationId: orgId,
      userId,
      userEmail: "admin@example.com",
      interval: "month",
      source: "settings",
      origin: "http://localhost:3000",
    });

    const args = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(args.mode).toBe("subscription");
    expect(args.success_url).toBe(
      `http://localhost:3000/org/${orgId}/settings?checkout=success`
    );
    expect(args.cancel_url).toBe(
      `http://localhost:3000/org/${orgId}/settings?checkout=canceled`
    );
  });

  it("builds onboarding return URLs pointing at the dashboard", async () => {
    await billingService.createCheckoutSession({
      organizationId: orgId,
      userId,
      userEmail: "admin@example.com",
      interval: "month",
      source: "onboarding",
      origin: "http://localhost:3000",
    });

    const args = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(args.success_url).toBe(
      "http://localhost:3000/dashboard?checkout=success"
    );
  });

  it("throws when the org does not exist", async () => {
    await expect(
      billingService.createCheckoutSession({
        organizationId: "nope",
        userId,
        userEmail: "admin@example.com",
        interval: "month",
        source: "settings",
        origin: "http://localhost:3000",
      })
    ).rejects.toThrow(/not found/i);
  });

  it("throws when Stripe returns no checkout URL", async () => {
    mockStripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_no_url",
      url: null,
    });

    await expect(
      billingService.createCheckoutSession({
        organizationId: orgId,
        userId,
        userEmail: "admin@example.com",
        interval: "month",
        source: "settings",
        origin: "http://localhost:3000",
      })
    ).rejects.toThrow(/checkout URL/i);
  });
});

describe("BillingService.handleEvent", () => {
  it("checkout.session.completed grants Pro and records stripe ids + interval", async () => {
    await billingService.handleEvent(
      event("checkout.session.completed", {
        id: "cs_1",
        mode: "subscription",
        client_reference_id: orgId,
        customer: "cus_1",
        subscription: "sub_1",
        metadata: { organizationId: orgId, userId, tier: "pro", interval: "year" },
      })
    );

    const billing = await billingRepo.getByOrgId(orgId);
    expect(billing!.subscriptionTier).toBe("pro");
    expect(billing!.subscriptionStatus).toBe("active");
    expect(billing!.stripeCustomerId).toBe("cus_1");
    expect(billing!.stripeSubscriptionId).toBe("sub_1");
    expect(billing!.billingInterval).toBe("year");
  });

  it("checkout.session.completed resolves org via client_reference_id when metadata is absent", async () => {
    await billingService.handleEvent(
      event("checkout.session.completed", {
        id: "cs_2",
        mode: "subscription",
        client_reference_id: orgId,
        customer: "cus_2",
        subscription: "sub_2",
        metadata: {},
      })
    );

    const billing = await billingRepo.getByOrgId(orgId);
    expect(billing!.subscriptionTier).toBe("pro");
  });

  /*
   * The handler used to run for EVERY completed checkout, and everything it
   * does assumes a plan was bought: the tier falls back to "pro" when metadata
   * is silent, and `session.subscription` — null on a one-off — is written
   * straight through.
   *
   * So the moment anything else is sold (a project-quota pack, a one-time
   * unlock), an Enterprise organisation buying it would have been demoted to
   * Pro and had its subscription id erased, on the SUCCESS path, with no error
   * anywhere. This pins the guard before that second product exists, because
   * the bug only becomes reachable on the day someone adds one.
   */
  it("ignores a non-subscription checkout instead of overwriting the plan", async () => {
    await billingService.handleEvent(
      event("checkout.session.completed", {
        id: "cs_sub",
        mode: "subscription",
        client_reference_id: orgId,
        customer: "cus_ent",
        subscription: "sub_ent",
        metadata: { organizationId: orgId, tier: "enterprise", interval: "year" },
      })
    );
    expect((await billingRepo.getByOrgId(orgId))!.subscriptionTier).toBe(
      "enterprise"
    );

    // A one-off purchase by the same organisation. Carries no subscription,
    // and says nothing about the tier — because it is not about the tier.
    await billingService.handleEvent(
      event("checkout.session.completed", {
        id: "cs_pack",
        mode: "payment",
        client_reference_id: orgId,
        customer: "cus_ent",
        subscription: null,
        metadata: { organizationId: orgId },
      })
    );

    const after = await billingRepo.getByOrgId(orgId);
    expect(after!.subscriptionTier).toBe("enterprise");
    expect(after!.stripeSubscriptionId).toBe("sub_ent");
  });

  it("customer.subscription.updated with an active status keeps Pro", async () => {
    await billingRepo.applySubscriptionState(orgId, { subscriptionTier: "pro" });

    await billingService.handleEvent(
      event("customer.subscription.updated", {
        id: "sub_1",
        status: "active",
        customer: "cus_1",
        metadata: { organizationId: orgId },
        items: { data: [{ price: { recurring: { interval: "month" } } }] },
      })
    );

    const billing = await billingRepo.getByOrgId(orgId);
    expect(billing!.subscriptionTier).toBe("pro");
    expect(billing!.subscriptionStatus).toBe("active");
    expect(billing!.billingInterval).toBe("month");
  });

  it("customer.subscription.updated with a terminal status downgrades to free", async () => {
    await billingRepo.applySubscriptionState(orgId, { subscriptionTier: "pro" });

    await billingService.handleEvent(
      event("customer.subscription.updated", {
        id: "sub_1",
        status: "canceled",
        customer: "cus_1",
        metadata: { organizationId: orgId },
        items: { data: [{ price: { recurring: { interval: "month" } } }] },
      })
    );

    const billing = await billingRepo.getByOrgId(orgId);
    expect(billing!.subscriptionTier).toBe("free");
    expect(billing!.subscriptionStatus).toBe("canceled");
  });

  it("resolves the org via stripe customer id when metadata lacks organizationId", async () => {
    await billingRepo.setStripeCustomerId(orgId, "cus_LINK");
    await billingRepo.applySubscriptionState(orgId, { subscriptionTier: "pro" });

    await billingService.handleEvent(
      event("customer.subscription.updated", {
        id: "sub_1",
        status: "unpaid",
        customer: "cus_LINK",
        metadata: {},
        items: { data: [{ price: { recurring: { interval: "year" } } }] },
      })
    );

    const billing = await billingRepo.getByOrgId(orgId);
    expect(billing!.subscriptionTier).toBe("free"); // unpaid is terminal
  });

  it("customer.subscription.deleted reverts to free and clears the subscription id", async () => {
    await billingRepo.applySubscriptionState(orgId, {
      subscriptionTier: "pro",
      stripeSubscriptionId: "sub_1",
      billingInterval: "month",
    });

    await billingService.handleEvent(
      event("customer.subscription.deleted", {
        id: "sub_1",
        status: "canceled",
        customer: "cus_1",
        metadata: { organizationId: orgId },
      })
    );

    const billing = await billingRepo.getByOrgId(orgId);
    expect(billing!.subscriptionTier).toBe("free");
    expect(billing!.subscriptionStatus).toBe("canceled");
    expect(billing!.stripeSubscriptionId).toBeNull();
    expect(billing!.billingInterval).toBeNull();
  });

  it("ignores unhandled event types without changing tier", async () => {
    await billingRepo.applySubscriptionState(orgId, { subscriptionTier: "pro" });

    await billingService.handleEvent(
      event("invoice.paid", { id: "in_1" })
    );

    const billing = await billingRepo.getByOrgId(orgId);
    expect(billing!.subscriptionTier).toBe("pro");
  });
});

describe("BillingService.constructEvent", () => {
  it("throws when STRIPE_WEBHOOK_SECRET is not set", async () => {
    const prev = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      await expect(
        billingService.constructEvent("{}", "sig")
      ).rejects.toThrow(/STRIPE_WEBHOOK_SECRET/);
    } finally {
      if (prev !== undefined) process.env.STRIPE_WEBHOOK_SECRET = prev;
    }
  });

  it("delegates to the Stripe SDK for signature verification when a secret is set", async () => {
    const prev = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    mockStripe.webhooks.constructEventAsync.mockResolvedValue(
      event("checkout.session.completed", { id: "cs_x" })
    );
    try {
      const result = await billingService.constructEvent("raw-body", "sig-header");
      expect(mockStripe.webhooks.constructEventAsync).toHaveBeenCalledWith(
        "raw-body",
        "sig-header",
        "whsec_test"
      );
      expect(result.type).toBe("checkout.session.completed");
    } finally {
      if (prev !== undefined) process.env.STRIPE_WEBHOOK_SECRET = prev;
      else delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });
});
