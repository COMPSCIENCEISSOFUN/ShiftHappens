/**
 * Tests for Organization Repository (Entity Layer)
 * Verifies org creation with membership, slug lookups,
 * and user-org queries against a real PostgreSQL database.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { cleanDatabase } from "../helpers/cleanup";

const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

beforeEach(async () => {
  await cleanDatabase();
});

describe("OrganizationRepository", () => {
  describe("create", () => {
    it("creates an organization with a membership for the creator", async () => {
      const user = await userRepo.create({
        name: "John Doe",
        email: "john@example.com",
        hashedPassword: "hash",
      });

      const org = await orgRepo.create(
        {
          name: "Acme Corp",
          slug: "acme-corp",
          industry: "Technology",
          description: "A tech company",
        },
        user.id
      );

      expect(org.id).toBeDefined();
      expect(org.name).toBe("Acme Corp");
      expect(org.slug).toBe("acme-corp");
      expect(org.memberships).toHaveLength(1);
      expect(org.memberships[0].role).toBe("company_admin");
      expect(org.memberships[0].userId).toBe(user.id);
    });
  });

  describe("findBySlug", () => {
    it("finds an organization by slug", async () => {
      const user = await userRepo.create({
        name: "John Doe",
        email: "john@example.com",
        hashedPassword: "hash",
      });

      await orgRepo.create(
        { name: "Acme Corp", slug: "acme-corp" },
        user.id
      );

      const found = await orgRepo.findBySlug("acme-corp");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Acme Corp");
    });

    it("returns null for non-existent slug", async () => {
      const found = await orgRepo.findBySlug("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("findByUserId", () => {
    it("returns all organizations for a user", async () => {
      const user = await userRepo.create({
        name: "John Doe",
        email: "john@example.com",
        hashedPassword: "hash",
      });

      await orgRepo.create({ name: "Org A", slug: "org-a" }, user.id);
      await orgRepo.create({ name: "Org B", slug: "org-b" }, user.id);

      const orgs = await orgRepo.findByUserId(user.id);
      expect(orgs).toHaveLength(2);
    });
  });

  describe("slugExists", () => {
    it("returns true for existing slug", async () => {
      const user = await userRepo.create({
        name: "John Doe",
        email: "john@example.com",
        hashedPassword: "hash",
      });

      await orgRepo.create({ name: "Acme", slug: "acme" }, user.id);

      const exists = await orgRepo.slugExists("acme");
      expect(exists).toBe(true);
    });

    it("returns false for non-existent slug", async () => {
      const exists = await orgRepo.slugExists("nonexistent");
      expect(exists).toBe(false);
    });
  });
});
