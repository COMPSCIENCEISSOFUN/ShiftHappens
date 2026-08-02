/**
 * Tests for Platform Repository (Entity Layer)
 * Verifies cross-organization queries for platform admin.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PlatformRepository } from "@/repositories/platform.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const platformRepo = new PlatformRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let userId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  userId = user.id;
});

describe("PlatformRepository", () => {
  describe("findAllOrganizations", () => {
    it("returns all organizations with counts", async () => {
      await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);
      await orgRepo.create({ name: "Org B", slug: "org-b" }, userId);

      const orgs = await platformRepo.findAllOrganizations();
      expect(orgs).toHaveLength(2);
      expect(orgs[0]._count).toBeDefined();
      expect(orgs[0]._count.memberships).toBeGreaterThanOrEqual(0);
      expect(orgs[0]._count.tasks).toBeGreaterThanOrEqual(0);
    });

    it("returns empty array when no organizations exist", async () => {
      const orgs = await platformRepo.findAllOrganizations();
      expect(orgs).toHaveLength(0);
    });

    it("supports pagination", async () => {
      await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);
      await orgRepo.create({ name: "Org B", slug: "org-b" }, userId);
      await orgRepo.create({ name: "Org C", slug: "org-c" }, userId);

      const page1 = await platformRepo.findAllOrganizations(2, 0);
      expect(page1).toHaveLength(2);

      const page2 = await platformRepo.findAllOrganizations(2, 2);
      expect(page2).toHaveLength(1);
    });
  });

  describe("countOrganizations", () => {
    it("returns the total count", async () => {
      await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);
      await orgRepo.create({ name: "Org B", slug: "org-b" }, userId);

      const count = await platformRepo.countOrganizations();
      expect(count).toBe(2);
    });
  });

  describe("findOrganizationById", () => {
    it("returns organization with counts", async () => {
      const org = await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);

      const found = await platformRepo.findOrganizationById(org.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Org A");
      expect(found!._count.departments).toBeDefined();
    });

    it("returns null for non-existent org", async () => {
      const found = await platformRepo.findOrganizationById("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("updateOrganizationStatus", () => {
    it("updates status to suspended", async () => {
      const org = await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);

      const updated = await platformRepo.updateOrganizationStatus(org.id, "suspended");
      expect(updated.status).toBe("suspended");
    });

    it("updates status back to active", async () => {
      const org = await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);
      await platformRepo.updateOrganizationStatus(org.id, "suspended");

      const updated = await platformRepo.updateOrganizationStatus(org.id, "active");
      expect(updated.status).toBe("active");
    });
  });

  describe("getStats", () => {
    it("returns platform-wide statistics", async () => {
      await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);
      await orgRepo.create({ name: "Org B", slug: "org-b" }, userId);

      const stats = await platformRepo.getStats();
      expect(stats.totalOrganizations).toBe(2);
      expect(stats.activeOrganizations).toBe(2);
      expect(stats.totalUsers).toBeGreaterThanOrEqual(1);
      expect(stats.totalTasks).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getStats — tier counts", () => {
    /** orgRepo.create() has no tier argument, so it is set after the fact. */
    async function orgOnTier(slug: string, tier: string) {
      const org = await orgRepo.create({ name: slug, slug }, userId);
      await prisma.organization.update({
        where: { id: org.id },
        data: { subscriptionTier: tier },
      });
      return org;
    }

    it("groups organisations by tier", async () => {
      await orgOnTier("a", "free");
      await orgOnTier("b", "pro");
      await orgOnTier("c", "pro");

      const { tierCounts } = await platformRepo.getStats();
      expect(tierCounts).toEqual({ free: 1, pro: 2 });
    });

    it("omits a tier nobody is on", async () => {
      // The dashboard reads `tierCounts[tier] ?? 0`, so absent and zero mean
      // the same thing there. Pinned so a rewrite to `tierCounts[tier]` alone
      // does not start printing undefined.
      await orgOnTier("a", "free");

      const { tierCounts } = await platformRepo.getStats();
      expect(tierCounts.enterprise).toBeUndefined();
    });

    it("reports a tier the UI does not know about", async () => {
      // The old dashboard iterated a hardcoded list of three and dropped
      // anything else, so the bar silently failed to add up to 100%.
      await orgOnTier("a", "trial");

      const { tierCounts } = await platformRepo.getStats();
      expect(tierCounts.trial).toBe(1);
    });

    it("counts suspended organisations too", async () => {
      // A suspended tenant is still a customer on a plan. If it were excluded,
      // the tier counts would not sum to totalOrganizations and the percentages
      // would be wrong.
      const org = await orgOnTier("a", "pro");
      await prisma.organization.update({
        where: { id: org.id },
        data: { status: "suspended" },
      });

      const stats = await platformRepo.getStats();
      expect(stats.tierCounts.pro).toBe(1);
      expect(
        Object.values(stats.tierCounts).reduce((a, b) => a + b, 0)
      ).toBe(stats.totalOrganizations);
    });

    it("is an empty map when there are no organisations", async () => {
      const { tierCounts } = await platformRepo.getStats();
      expect(tierCounts).toEqual({});
    });
  });
});