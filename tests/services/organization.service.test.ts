/**
 * Tests for Organization Service (Control Layer)
 * Verifies org creation with slug generation, retrieval,
 * and detail updates with slug regeneration and audit logging.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OrganizationService } from "@/services/organization.service";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { eventuallyAtLeast, pauseForAbsence } from "../helpers/settle";

const orgService = new OrganizationService();
const userRepo = new UserRepository();

let testUser: { id: string };

beforeEach(async () => {
  await cleanDatabase();
  testUser = await userRepo.create({
    name: "John Doe",
    email: "john@example.com",
    hashedPassword: "hash",
  });
});

describe("OrganizationService", () => {
  describe("create", () => {
    it("creates an organization with a slug", async () => {
      const org = await orgService.create(
        { name: "Acme Corp", industry: "Technology" },
        testUser.id
      );

      expect(org.name).toBe("Acme Corp");
      expect(org.slug).toBe("acme-corp");
      expect(org.industry).toBe("Technology");
    });

    it("generates unique slugs for duplicate names", async () => {
      const org1 = await orgService.create({ name: "Acme Corp" }, testUser.id);
      const org2 = await orgService.create({ name: "Acme Corp" }, testUser.id);

      expect(org1.slug).toBe("acme-corp");
      expect(org2.slug).toMatch(/^acme-corp-/);
      expect(org2.slug).not.toBe(org1.slug);
    });

    it("makes the creator a company_admin", async () => {
      const org = await orgService.create({ name: "Acme Corp" }, testUser.id);

      expect(org.memberships[0].role).toBe("company_admin");
      expect(org.memberships[0].userId).toBe(testUser.id);
    });
  });

  describe("getOrganization", () => {
    it("returns an organization by ID", async () => {
      const created = await orgService.create({ name: "Acme Corp" }, testUser.id);

      const org = await orgService.getOrganization(created.id);

      expect(org).not.toBeNull();
      expect(org!.name).toBe("Acme Corp");
      expect(org!.slug).toBe("acme-corp");
    });

    it("returns null for non-existent ID", async () => {
      const org = await orgService.getOrganization("non-existent-id");

      expect(org).toBeNull();
    });
  });

  describe("getUserOrganizations", () => {
    it("returns all organizations for a user", async () => {
      await orgService.create({ name: "Org A" }, testUser.id);
      await orgService.create({ name: "Org B" }, testUser.id);

      const orgs = await orgService.getUserOrganizations(testUser.id);
      expect(orgs).toHaveLength(2);
    });
  });

  describe("updateOrganization", () => {
    it("updates name and regenerates slug", async () => {
      const org = await orgService.create({ name: "Old Name" }, testUser.id);

      const updated = await orgService.updateOrganization(
        org.id,
        { name: "New Name" },
        testUser.id
      );

      expect(updated.name).toBe("New Name");
      expect(updated.slug).toBe("new-name");
    });

    it("does not regenerate slug when name is unchanged", async () => {
      const org = await orgService.create({ name: "Acme Corp" }, testUser.id);

      const updated = await orgService.updateOrganization(
        org.id,
        { name: "Acme Corp", description: "Updated desc" },
        testUser.id
      );

      expect(updated.slug).toBe("acme-corp");
      expect(updated.description).toBe("Updated desc");
    });

    it("handles slug collision on name change", async () => {
      await orgService.create({ name: "Target Name" }, testUser.id);
      const org2 = await orgService.create({ name: "Other Name" }, testUser.id);

      const updated = await orgService.updateOrganization(
        org2.id,
        { name: "Target Name" },
        testUser.id
      );

      expect(updated.name).toBe("Target Name");
      expect(updated.slug).toMatch(/^target-name-/);
      expect(updated.slug).not.toBe("target-name");
    });

    it("updates industry and description", async () => {
      const org = await orgService.create({ name: "Acme Corp" }, testUser.id);

      const updated = await orgService.updateOrganization(
        org.id,
        { industry: "Healthcare", description: "A health company" },
        testUser.id
      );

      expect(updated.industry).toBe("Healthcare");
      expect(updated.description).toBe("A health company");
    });

    it("clears optional fields with empty string to null", async () => {
      const org = await orgService.create(
        { name: "Acme Corp", industry: "Tech", description: "Some desc" },
        testUser.id
      );

      const updated = await orgService.updateOrganization(
        org.id,
        { industry: "", description: "" },
        testUser.id
      );

      expect(updated.industry).toBeNull();
      expect(updated.description).toBeNull();
    });

    it("trims whitespace from name", async () => {
      const org = await orgService.create({ name: "Acme Corp" }, testUser.id);

      const updated = await orgService.updateOrganization(
        org.id,
        { name: "  Trimmed Name  " },
        testUser.id
      );

      expect(updated.name).toBe("Trimmed Name");
      expect(updated.slug).toBe("trimmed-name");
    });

    it("throws for whitespace-only name", async () => {
      const org = await orgService.create({ name: "Acme Corp" }, testUser.id);

      await expect(
        orgService.updateOrganization(org.id, { name: "   " }, testUser.id)
      ).rejects.toThrow("Organization name cannot be empty");
    });

    it("throws for non-existent organization", async () => {
      await expect(
        orgService.updateOrganization(
          "non-existent-id",
          { name: "New Name" },
          testUser.id
        )
      ).rejects.toThrow("Organization not found");
    });

    it("returns current org without DB write when no fields provided", async () => {
      const org = await orgService.create(
        { name: "Acme Corp", industry: "Tech" },
        testUser.id
      );

      const result = await orgService.updateOrganization(
        org.id,
        {},
        testUser.id
      );

      expect(result.name).toBe("Acme Corp");
      expect(result.industry).toBe("Tech");
    });

    it("creates an audit log entry on update", async () => {
      const org = await orgService.create({ name: "Acme Corp" }, testUser.id);

      await orgService.updateOrganization(
        org.id,
        { name: "New Name" },
        testUser.id
      );

      // Polled, not slept: the audit write is fire-and-forget, so there is
      // nothing to await and a fixed sleep is a guess about the machine.
      const logs = await eventuallyAtLeast(() =>
        prisma.auditLog.findMany({
          where: { organizationId: org.id, action: "organization.updated" },
        })
      );

      expect(logs).toHaveLength(1);
      expect(logs[0].userId).toBe(testUser.id);
      expect(logs[0].entityType).toBe("organization");
      const details = logs[0].details as Record<string, unknown>;
      expect(details.newName).toBe("New Name");
      expect(details.newSlug).toBe("new-name");
    });

    it("does not create audit log when no fields changed", async () => {
      const org = await orgService.create({ name: "Acme Corp" }, testUser.id);

      await orgService.updateOrganization(org.id, {}, testUser.id);

      // Absence, so this has to be a pause — see helpers/settle.
      await pauseForAbsence();

      const logs = await prisma.auditLog.findMany({
        where: {
          organizationId: org.id,
          action: "organization.updated",
        },
      });

      expect(logs).toHaveLength(0);
    });

    it("updates only provided fields without affecting others", async () => {
      const org = await orgService.create(
        { name: "Acme Corp", industry: "Tech", description: "Original" },
        testUser.id
      );

      const updated = await orgService.updateOrganization(
        org.id,
        { description: "Changed" },
        testUser.id
      );

      expect(updated.name).toBe("Acme Corp");
      expect(updated.industry).toBe("Tech");
      expect(updated.description).toBe("Changed");
    });
  });
});