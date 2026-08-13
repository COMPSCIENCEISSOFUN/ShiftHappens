/**
 * Tests for Subscription Service (Control Layer)
 *
 * Verifies tier detection, resource limit enforcement,
 * feature gating, usage reporting, and org isolation.
 * Tests all three tiers: free, pro, enterprise.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SubscriptionService } from "@/services/subscription.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import {
  SubscriptionLimitError,
  FeatureNotAvailableError,
  getResourceLimit,
} from "@/lib/subscription-tiers";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const subscriptionService = new SubscriptionService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

/*
 * Read from the config rather than written here.
 *
 * These tests hardcoded 2, which is what Free's department cap happened to be
 * — so raising it to 3 broke five of them for a reason that had nothing to do
 * with what any of them was testing. The behaviour under test is "refuses at
 * the limit", not "the limit is two"; the number belongs to pricing, and
 * pricing is allowed to change without a test suite objecting.
 *
 * `subscription-tiers.test.ts` is where the VALUES are asserted, which is the
 * one place a deliberate pricing change should have to be restated.
 */
const FREE_DEPARTMENTS = getResourceLimit("free", "departments") as number;

/** Fills the organisation exactly to its department cap. */
async function fillDepartments() {
  await prisma.department.createMany({
    data: Array.from({ length: FREE_DEPARTMENTS }, (_, i) => ({
      name: `Dept ${i + 1}`,
      organizationId: orgId,
    })),
  });
}

let orgId: string;
let userId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  userId = user.id;

  const org = await orgRepo.create(
    { name: "Test Org", slug: "test-org" },
    user.id
  );
  orgId = org.id;
});

describe("SubscriptionService", () => {
  // ─── getOrganizationTier ────────────────────────────────

  describe("getOrganizationTier", () => {
    it("returns free tier for new organization", async () => {
      const tier = await subscriptionService.getOrganizationTier(orgId);
      expect(tier).toBe("free");
    });

    it("returns pro tier when set", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "pro" },
      });

      const tier = await subscriptionService.getOrganizationTier(orgId);
      expect(tier).toBe("pro");
    });

    it("returns enterprise tier when set", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "enterprise" },
      });

      const tier = await subscriptionService.getOrganizationTier(orgId);
      expect(tier).toBe("enterprise");
    });

    it("falls back to free for invalid tier value", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "invalid_tier" },
      });

      const tier = await subscriptionService.getOrganizationTier(orgId);
      expect(tier).toBe("free");
    });
  });

  // ─── checkResourceLimit ─────────────────────────────────

  describe("checkResourceLimit", () => {
    it("returns allowed when under limit", async () => {
      const result = await subscriptionService.checkResourceLimit(
        orgId,
        "departments"
      );

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(0);
      expect(result.limit).toBe(FREE_DEPARTMENTS);
      expect(result.tier).toBe("free");
    });

    it("returns not allowed when at limit", async () => {
      await fillDepartments();

      const result = await subscriptionService.checkResourceLimit(
        orgId,
        "departments"
      );

      expect(result.allowed).toBe(false);
      expect(result.current).toBe(FREE_DEPARTMENTS);
      expect(result.limit).toBe(FREE_DEPARTMENTS);
    });

    it("returns allowed for unlimited resources on enterprise", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "enterprise" },
      });

      const result = await subscriptionService.checkResourceLimit(
        orgId,
        "departments"
      );

      expect(result.allowed).toBe(true);
      expect(result.limit).toBeNull();
    });

    it("counts only resources for the specified org", async () => {
      const otherUser = await userRepo.create({
        name: "Other",
        email: "other@example.com",
        hashedPassword: "hash",
      });
      const otherOrg = await orgRepo.create(
        { name: "Other Org", slug: "other-org" },
        otherUser.id
      );
      await prisma.department.create({
        data: { name: "Other Dept", organizationId: otherOrg.id },
      });

      const result = await subscriptionService.checkResourceLimit(
        orgId,
        "departments"
      );

      expect(result.current).toBe(0);
    });

    it("returns higher limits for pro tier", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "pro" },
      });

      const result = await subscriptionService.checkResourceLimit(
        orgId,
        "departments"
      );

      expect(result.limit).toBe(10);
    });
  });

  // ─── enforceResourceLimit ───────────────────────────────

  describe("enforceResourceLimit", () => {
    it("does not throw when under limit", async () => {
      await expect(
        subscriptionService.enforceResourceLimit(orgId, "departments")
      ).resolves.toBeUndefined();
    });

    it("throws SubscriptionLimitError when at limit", async () => {
      await fillDepartments();

      await expect(
        subscriptionService.enforceResourceLimit(orgId, "departments")
      ).rejects.toThrow(SubscriptionLimitError);
    });

    it("includes resource and tier info in error", async () => {
      await fillDepartments();

      try {
        await subscriptionService.enforceResourceLimit(orgId, "departments");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SubscriptionLimitError);
      }
    });

    it("does not throw on enterprise with many resources", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "enterprise" },
      });

      await prisma.department.createMany({
        data: Array.from({ length: 5 }, (_, i) => ({
          name: `Dept ${i}`,
          organizationId: orgId,
        })),
      });

      await expect(
        subscriptionService.enforceResourceLimit(orgId, "departments")
      ).resolves.toBeUndefined();
    });
  });

  // ─── canUseFeature ──────────────────────────────────────

  describe("canUseFeature", () => {
    it("returns false for all gated features on free tier", async () => {
      expect(
        await subscriptionService.canUseFeature(orgId, "custom_roles")
      ).toBe(false);
      expect(
        await subscriptionService.canUseFeature(orgId, "pdf_export")
      ).toBe(false);
      expect(
        await subscriptionService.canUseFeature(orgId, "audit_log")
      ).toBe(false);
    });

    it("returns true for pro features on pro tier", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "pro" },
      });

      expect(
        await subscriptionService.canUseFeature(orgId, "custom_roles")
      ).toBe(true);
      expect(
        await subscriptionService.canUseFeature(orgId, "pdf_export")
      ).toBe(true);
      expect(
        await subscriptionService.canUseFeature(orgId, "mass_import")
      ).toBe(true);
      // Moved down from Enterprise on 2026-08-11. Inverted rather than
      // deleted: the assertion still earns its place, it just says the
      // opposite now.
      expect(
        await subscriptionService.canUseFeature(orgId, "audit_log")
      ).toBe(true);
    });

    it("returns false for enterprise-only features on pro tier", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "pro" },
      });

      // `priority_support` is what is left above Pro. This case must keep a
      // subject or the suite stops checking that the top tier means anything.
      expect(
        await subscriptionService.canUseFeature(orgId, "priority_support")
      ).toBe(false);
    });

    it("returns true for all features on enterprise tier", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "enterprise" },
      });

      expect(
        await subscriptionService.canUseFeature(orgId, "custom_roles")
      ).toBe(true);
      expect(
        await subscriptionService.canUseFeature(orgId, "audit_log")
      ).toBe(true);
      expect(
        await subscriptionService.canUseFeature(orgId, "priority_support")
      ).toBe(true);
    });
  });

  // ─── enforceFeatureAccess ───────────────────────────────

  describe("enforceFeatureAccess", () => {
    it("throws FeatureNotAvailableError on free tier", async () => {
      await expect(
        subscriptionService.enforceFeatureAccess(orgId, "pdf_export")
      ).rejects.toThrow(FeatureNotAvailableError);
    });

    it("does not throw for pro features on pro tier", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "pro" },
      });

      await expect(
        subscriptionService.enforceFeatureAccess(orgId, "pdf_export")
      ).resolves.toBeUndefined();
    });

    it("throws for enterprise-only features on pro tier", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "pro" },
      });

      await expect(
        subscriptionService.enforceFeatureAccess(orgId, "priority_support")
      ).rejects.toThrow(FeatureNotAvailableError);
    });

    it("no longer throws for the audit log on pro tier", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "pro" },
      });

      await expect(
        subscriptionService.enforceFeatureAccess(orgId, "audit_log")
      ).resolves.toBeUndefined();
    });

    it("does not throw for any feature on enterprise tier", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "enterprise" },
      });

      await expect(
        subscriptionService.enforceFeatureAccess(orgId, "audit_log")
      ).resolves.toBeUndefined();
    });
  });

  // ─── getUsage ───────────────────────────────────────────

  describe("getUsage", () => {
    it("returns correct tier info", async () => {
      const usage = await subscriptionService.getUsage(orgId);

      expect(usage.tier).toBe("free");
      expect(usage.displayName).toBeDefined();
    });

    it("returns resource counts with percentages", async () => {
      await prisma.department.create({
        data: { name: "Kitchen", organizationId: orgId },
      });

      const usage = await subscriptionService.getUsage(orgId);

      expect(usage.resources.departments.current).toBe(1);
      expect(usage.resources.departments.limit).toBe(FREE_DEPARTMENTS);
      expect(usage.resources.departments.percentage).toBe(
        Math.round((1 / FREE_DEPARTMENTS) * 100)
      );
    });

    it("returns null limits and percentages for enterprise", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "enterprise" },
      });

      const usage = await subscriptionService.getUsage(orgId);

      expect(usage.resources.departments.limit).toBeNull();
      expect(usage.resources.departments.percentage).toBeNull();
    });

    it("returns feature availability flags for free tier", async () => {
      const usage = await subscriptionService.getUsage(orgId);

      expect(usage.features.custom_roles).toBe(false);
      expect(usage.features.pdf_export).toBe(false);
      expect(usage.features.audit_log).toBe(false);
    });

    it("returns correct feature flags for pro tier", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "pro" },
      });

      const usage = await subscriptionService.getUsage(orgId);

      expect(usage.features.custom_roles).toBe(true);
      expect(usage.features.pdf_export).toBe(true);
      expect(usage.features.audit_log).toBe(true);
      expect(usage.features.priority_support).toBe(false);
    });

    it("includes member count from org creation", async () => {
      const usage = await subscriptionService.getUsage(orgId);

      expect(usage.resources.members.current).toBe(1);
    });
  });
});