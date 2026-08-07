/**
 * Tests for Billing Repository (Entity Layer)
 *
 * Verifies the org↔Stripe linkage data access:
 * - reading a billing snapshot by org id and by Stripe customer id
 * - persisting the Stripe customer id
 * - applying subscription state (tier/status/ids/interval)
 *
 * Runs against the real test database.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { BillingRepository } from "@/repositories/billing.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { cleanDatabase } from "../helpers/cleanup";

const billingRepo = new BillingRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  const org = await orgRepo.create(
    { name: "Test Org", slug: "test-org" },
    user.id
  );
  orgId = org.id;
});

describe("BillingRepository", () => {
  describe("getByOrgId", () => {
    it("returns a billing snapshot for a new org (free, no stripe ids)", async () => {
      const billing = await billingRepo.getByOrgId(orgId);

      expect(billing).not.toBeNull();
      expect(billing!.id).toBe(orgId);
      expect(billing!.subscriptionTier).toBe("free");
      expect(billing!.stripeCustomerId).toBeNull();
      expect(billing!.stripeSubscriptionId).toBeNull();
      expect(billing!.subscriptionStatus).toBeNull();
      expect(billing!.billingInterval).toBeNull();
    });

    it("returns null for an unknown org id", async () => {
      const billing = await billingRepo.getByOrgId("nonexistent");
      expect(billing).toBeNull();
    });
  });

  describe("setStripeCustomerId", () => {
    it("persists the Stripe customer id", async () => {
      await billingRepo.setStripeCustomerId(orgId, "cus_ABC123");

      const billing = await billingRepo.getByOrgId(orgId);
      expect(billing!.stripeCustomerId).toBe("cus_ABC123");
    });
  });

  describe("getByStripeCustomerId", () => {
    it("resolves the org from its Stripe customer id", async () => {
      await billingRepo.setStripeCustomerId(orgId, "cus_LOOKUP");

      const billing = await billingRepo.getByStripeCustomerId("cus_LOOKUP");
      expect(billing).not.toBeNull();
      expect(billing!.id).toBe(orgId);
    });

    it("returns null when no org matches the customer id", async () => {
      const billing = await billingRepo.getByStripeCustomerId("cus_MISSING");
      expect(billing).toBeNull();
    });
  });

  describe("applySubscriptionState", () => {
    it("writes tier, status, subscription id and interval", async () => {
      const updated = await billingRepo.applySubscriptionState(orgId, {
        subscriptionTier: "pro",
        subscriptionStatus: "active",
        stripeSubscriptionId: "sub_123",
        billingInterval: "year",
      });

      expect(updated.subscriptionTier).toBe("pro");
      expect(updated.subscriptionStatus).toBe("active");
      expect(updated.stripeSubscriptionId).toBe("sub_123");
      expect(updated.billingInterval).toBe("year");

      // Persisted, not just returned.
      const reread = await billingRepo.getByOrgId(orgId);
      expect(reread!.subscriptionTier).toBe("pro");
      expect(reread!.billingInterval).toBe("year");
    });

    it("only writes the fields provided (partial update)", async () => {
      await billingRepo.applySubscriptionState(orgId, {
        subscriptionTier: "pro",
        billingInterval: "month",
      });

      // Now downgrade tier only; interval should remain untouched.
      await billingRepo.applySubscriptionState(orgId, {
        subscriptionTier: "free",
      });

      const billing = await billingRepo.getByOrgId(orgId);
      expect(billing!.subscriptionTier).toBe("free");
      expect(billing!.billingInterval).toBe("month");
    });

    it("can clear the subscription id and interval (cancellation)", async () => {
      await billingRepo.applySubscriptionState(orgId, {
        subscriptionTier: "pro",
        stripeSubscriptionId: "sub_x",
        billingInterval: "month",
      });

      await billingRepo.applySubscriptionState(orgId, {
        subscriptionTier: "free",
        subscriptionStatus: "canceled",
        stripeSubscriptionId: null,
        billingInterval: null,
      });

      const billing = await billingRepo.getByOrgId(orgId);
      expect(billing!.stripeSubscriptionId).toBeNull();
      expect(billing!.billingInterval).toBeNull();
      expect(billing!.subscriptionStatus).toBe("canceled");
    });
  });
});
