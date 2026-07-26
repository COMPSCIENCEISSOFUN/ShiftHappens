/**
 * Tests for User Repository (Entity Layer)
 * Verifies CRUD operations against a real PostgreSQL database.
 * Each test starts with a clean database via beforeEach cleanup.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const userRepo = new UserRepository();

beforeEach(async () => {
  await cleanDatabase();
});

describe("UserRepository", () => {
  describe("create", () => {
    it("creates a new user", async () => {
      const user = await userRepo.create({
        name: "John Doe",
        email: "john@example.com",
        hashedPassword: "hashed_password_123",
      });

      expect(user.id).toBeDefined();
      expect(user.name).toBe("John Doe");
      expect(user.email).toBe("john@example.com");
      expect(user.emailVerified).toBeNull();
    });
  });

  describe("findByEmail", () => {
    it("finds an existing user by email", async () => {
      await userRepo.create({
        name: "John Doe",
        email: "john@example.com",
        hashedPassword: "hashed_password_123",
      });

      const found = await userRepo.findByEmail("john@example.com");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("John Doe");
    });

    it("returns null for non-existent email", async () => {
      const found = await userRepo.findByEmail("nobody@example.com");
      expect(found).toBeNull();
    });
  });

  describe("findById", () => {
    it("finds an existing user by id", async () => {
      const created = await userRepo.create({
        name: "John Doe",
        email: "john@example.com",
        hashedPassword: "hashed_password_123",
      });

      const found = await userRepo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found!.email).toBe("john@example.com");
    });
  });

  describe("updateProfile", () => {
    it("updates user name", async () => {
      const user = await userRepo.create({
        name: "John Doe",
        email: "john@example.com",
        hashedPassword: "hashed_password_123",
      });

      const updated = await userRepo.updateProfile(user.id, {
        name: "Jane Doe",
      });
      expect(updated.name).toBe("Jane Doe");
    });

    it("updates user password", async () => {
      const user = await userRepo.create({
        name: "John Doe",
        email: "john@example.com",
        hashedPassword: "old_hash",
      });

      const updated = await userRepo.updateProfile(user.id, {
        hashedPassword: "new_hash",
      });
      expect(updated.hashedPassword).toBe("new_hash");
    });
  });

  describe("verifyEmail", () => {
    it("sets emailVerified timestamp", async () => {
      const user = await userRepo.create({
        name: "John Doe",
        email: "john@example.com",
        hashedPassword: "hashed_password_123",
      });

      const verified = await userRepo.verifyEmail(user.id);
      expect(verified.emailVerified).not.toBeNull();
    });
  });

  describe("findByIdWithMemberships", () => {
    it("returns user with empty memberships when not in any org", async () => {
      const user = await userRepo.create({
        name: "Solo User",
        email: "solo@example.com",
        hashedPassword: "hash",
      });

      const result = await userRepo.findByIdWithMemberships(user.id);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Solo User");
      expect(result!.email).toBe("solo@example.com");
      expect(result!.memberships).toHaveLength(0);
    });

    it("returns user with org membership data", async () => {
      const user = await userRepo.create({
        name: "Org User",
        email: "orguser@example.com",
        hashedPassword: "hash",
      });

      const org = await prisma.organization.create({
        data: { name: "Test Org", slug: "test-org" },
      });

      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          role: "company_admin",
          status: "active",
        },
      });

      const result = await userRepo.findByIdWithMemberships(user.id);
      expect(result).not.toBeNull();
      expect(result!.memberships).toHaveLength(1);
      expect(result!.memberships[0].role).toBe("company_admin");
      expect(result!.memberships[0].status).toBe("active");
      expect(result!.memberships[0].organization.name).toBe("Test Org");
      expect(result!.memberships[0].organization.slug).toBe("test-org");
      expect(result!.memberships[0].customRole).toBeNull();
    });

    it("includes custom role data when assigned", async () => {
      const user = await userRepo.create({
        name: "Custom Role User",
        email: "customrole@example.com",
        hashedPassword: "hash",
      });

      const org = await prisma.organization.create({
        data: { name: "Role Org", slug: "role-org" },
      });

      const customRole = await prisma.role.create({
        data: {
          name: "shift_lead",
          displayLabel: "Shift Lead",
          organizationId: org.id,
          isSystemRole: false,
        },
      });

      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          role: "staff",
          customRoleId: customRole.id,
        },
      });

      const result = await userRepo.findByIdWithMemberships(user.id);
      expect(result!.memberships).toHaveLength(1);
      expect(result!.memberships[0].customRole).not.toBeNull();
      expect(result!.memberships[0].customRole!.displayLabel).toBe("Shift Lead");
    });

    it("returns null for non-existent user", async () => {
      const result = await userRepo.findByIdWithMemberships("non-existent-id");
      expect(result).toBeNull();
    });
  });
});