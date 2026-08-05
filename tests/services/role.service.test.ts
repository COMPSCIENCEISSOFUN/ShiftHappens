/**
 * Tests for Role Service (Control Layer)
 * Verifies role CRUD business logic including duplicate
 * name prevention and system role protection.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RoleService } from "@/services/role.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const roleService = new RoleService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let permissionIds: string[];

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  const org = await orgRepo.create(
    { name: "Acme Corp", slug: "acme-corp" },
    user.id
  );
  orgId = org.id;

  // Custom roles require Pro tier — set it explicitly
  await prisma.organization.update({
    where: { id: orgId },
    data: { subscriptionTier: "pro" },
  });

  const permissions = await prisma.permission.findMany({ take: 5 });
  permissionIds = permissions.map((p) => p.id);
});

describe("RoleService", () => {
  describe("create", () => {
    it("creates a custom role", async () => {
      const role = await roleService.create(
        {
          displayLabel: "Shift Lead",
          description: "Leads a shift",
          permissionIds: permissionIds.slice(0, 3),
        },
        orgId
      );

      expect(role.name).toBe("shift_lead");
      expect(role.displayLabel).toBe("Shift Lead");
      expect(role.isSystemRole).toBe(false);
      expect(role.rolePermissions).toHaveLength(3);
    });

    /*
     * This used to pass two DIFFERENT labels with the same internal name and
     * assert the name collision. The form no longer asks for a name — it is
     * derived — so the rule it was protecting moved onto the label, which is
     * the field a duplicate is actually visible in. `role-naming.test.ts`
     * covers the case-insensitive and whitespace variants.
     */
    it("throws if a role with the same label already exists in org", async () => {
      await roleService.create(
        {
          displayLabel: "Shift Lead",
          permissionIds: [permissionIds[0]],
        },
        orgId
      );

      await expect(
        roleService.create(
          {
            displayLabel: "Shift Lead",
            permissionIds: [permissionIds[1]],
          },
          orgId
        )
      ).rejects.toThrow(/already exists/);
    });

    it("blocks custom role creation on free tier", async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { subscriptionTier: "free" },
      });

      await expect(
        roleService.create(
          {
            displayLabel: "Shift Lead",
            permissionIds: [permissionIds[0]],
          },
          orgId
        )
      ).rejects.toThrow("not available on the Free plan");
    });

    it("blocks custom role creation when pro tier limit reached", async () => {
      // Pro tier allows 10 custom roles — create 10
      for (let i = 0; i < 10; i++) {
        await roleService.create(
          {
            displayLabel: `Role ${i}`,
            permissionIds: [permissionIds[0]],
          },
          orgId
        );
      }

      await expect(
        roleService.create(
          {
            displayLabel: "Role 11",
            permissionIds: [permissionIds[0]],
          },
          orgId
        )
      ).rejects.toThrow("limit reached");
    });
  });

  describe("getByOrganization", () => {
    it("returns all roles for an org", async () => {
      await roleService.create(
        {
          displayLabel: "Shift Lead",
          permissionIds: [permissionIds[0]],
        },
        orgId
      );
      await roleService.create(
        {
          displayLabel: "Senior Staff",
          permissionIds: [permissionIds[1]],
        },
        orgId
      );

      const roles = await roleService.getByOrganization(orgId);
      expect(roles).toHaveLength(2);
    });
  });

  describe("getById", () => {
    it("returns a role with permissions", async () => {
      const created = await roleService.create(
        {
          displayLabel: "Shift Lead",
          permissionIds: permissionIds.slice(0, 3),
        },
        orgId
      );

      const found = await roleService.getById(created.id, orgId);
      expect(found).not.toBeNull();
      expect(found!.rolePermissions).toHaveLength(3);
    });
  });

  describe("update", () => {
    it("updates display label", async () => {
      const role = await roleService.create(
        {
          displayLabel: "Shift Lead",
          permissionIds: [permissionIds[0]],
        },
        orgId
      );

      const updated = await roleService.update(role.id, orgId, {
        displayLabel: "Senior Shift Lead",
      });
      expect(updated.displayLabel).toBe("Senior Shift Lead");
    });

    it("updates permissions", async () => {
      const role = await roleService.create(
        {
          displayLabel: "Shift Lead",
          permissionIds: permissionIds.slice(0, 2),
        },
        orgId
      );

      const updated = await roleService.update(role.id, orgId, {
        permissionIds: permissionIds.slice(2, 5),
      });
      expect(updated.rolePermissions).toHaveLength(3);
    });

    it("throws if system role", async () => {
      const systemRole = await prisma.role.create({
        data: {
          name: "company_admin",
          displayLabel: "Company Admin",
          organizationId: orgId,
          isSystemRole: true,
        },
      });

      await expect(
        roleService.update(systemRole.id, orgId, {
          displayLabel: "Super Admin",
        })
      ).rejects.toThrow("Cannot modify system roles");
    });
  });

  describe("delete", () => {
    it("deletes a custom role", async () => {
      const role = await roleService.create(
        {
          displayLabel: "Shift Lead",
          permissionIds: [permissionIds[0]],
        },
        orgId
      );

      await roleService.delete(role.id, orgId);

      const found = await roleService.getById(role.id, orgId);
      expect(found).toBeNull();
    });

    it("throws if system role", async () => {
      const systemRole = await prisma.role.create({
        data: {
          name: "company_admin",
          displayLabel: "Company Admin",
          organizationId: orgId,
          isSystemRole: true,
        },
      });

      await expect(
        roleService.delete(systemRole.id, orgId)
      ).rejects.toThrow("Cannot delete system roles");
    });
  });

  describe("getAllPermissions", () => {
    it("returns all seeded permissions", async () => {
      const permissions = await roleService.getAllPermissions();
      expect(permissions.length).toBeGreaterThanOrEqual(28);
    });

    it("permissions are grouped by category", async () => {
      const permissions = await roleService.getAllPermissions();
      const categories = [...new Set(permissions.map((p) => p.category))];
      expect(categories.length).toBeGreaterThanOrEqual(10);
    });
  });
});