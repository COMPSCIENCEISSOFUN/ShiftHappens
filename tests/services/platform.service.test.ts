/**
 * Tests for Platform Service (Control Layer)
 * Verifies platform administration business logic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PlatformService } from "@/services/platform.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const platformService = new PlatformService();
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

describe("PlatformService", () => {
  describe("getOrganizations", () => {
    it("returns organizations with total count", async () => {
      await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);
      await orgRepo.create({ name: "Org B", slug: "org-b" }, userId);

      const result = await platformService.getOrganizations();
      expect(result.organizations).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("returns empty list when no organizations", async () => {
      const result = await platformService.getOrganizations();
      expect(result.organizations).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe("getOrganizationById", () => {
    it("returns the organization", async () => {
      const org = await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);

      const found = await platformService.getOrganizationById(org.id);
      expect(found.name).toBe("Org A");
    });

    it("throws for non-existent org", async () => {
      await expect(
        platformService.getOrganizationById("nonexistent")
      ).rejects.toThrow("Organization not found");
    });
  });

  describe("toggleOrganizationStatus", () => {
    it("suspends an active organization", async () => {
      const org = await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);

      const updated = await platformService.toggleOrganizationStatus(org.id, userId);
      expect(updated.status).toBe("suspended");
    });

    it("activates a suspended organization", async () => {
      const org = await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);
      await platformService.toggleOrganizationStatus(org.id, userId);

      const updated = await platformService.toggleOrganizationStatus(org.id, userId);
      expect(updated.status).toBe("active");
    });

    it("throws for non-existent org", async () => {
      await expect(
        platformService.toggleOrganizationStatus("nonexistent", userId)
      ).rejects.toThrow("Organization not found");
    });
  });

  describe("getStats", () => {
    it("returns platform statistics", async () => {
      await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);

      const stats = await platformService.getStats();
      expect(stats.totalOrganizations).toBe(1);
      expect(stats.activeOrganizations).toBe(1);
      expect(stats.totalUsers).toBeGreaterThanOrEqual(1);
      expect(stats.totalTasks).toBeGreaterThanOrEqual(0);
    });

    it("distinguishes active from suspended orgs in stats", async () => {
      const org1 = await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);
      await orgRepo.create({ name: "Org B", slug: "org-b" }, userId);

      // Suspend one org
      await prisma.organization.update({
        where: { id: org1.id },
        data: { status: "suspended" },
      });

      const stats = await platformService.getStats();
      expect(stats.totalOrganizations).toBe(2);
      expect(stats.activeOrganizations).toBe(1);
    });
  });

  describe("suspension enforcement", () => {
    it("suspended org status persists after toggle", async () => {
      const org = await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);

      const suspended = await platformService.toggleOrganizationStatus(org.id, userId);
      expect(suspended.status).toBe("suspended");

      // Verify it's actually suspended in DB
      const found = await platformService.getOrganizationById(org.id);
      expect(found.status).toBe("suspended");
    });

    it("org members count is preserved after suspension", async () => {
      const org = await orgRepo.create({ name: "Org A", slug: "org-a" }, userId);

      await platformService.toggleOrganizationStatus(org.id, userId);

      const found = await platformService.getOrganizationById(org.id);
      expect(found.status).toBe("suspended");
      expect(found._count.memberships).toBeGreaterThanOrEqual(1);
    });
  });
});