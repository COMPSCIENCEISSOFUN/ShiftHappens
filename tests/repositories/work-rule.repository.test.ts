/**
 * Tests for Work Rule Repository (Entity Layer)
 *
 * Verifies CRUD, name uniqueness, applicable rules lookup,
 * org-scoped isolation, and role deletion cascade behavior.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { WorkRuleRepository } from "@/repositories/work-rule.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const workRuleRepo = new WorkRuleRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin",
    email: "admin@test.com",
    hashedPassword: "hash",
  });

  const org = await orgRepo.create(
    { name: "Test Org", slug: "test-org" },
    user.id
  );
  orgId = org.id;
});

describe("WorkRuleRepository", () => {
  describe("create", () => {
    it("creates a break interval rule", async () => {
      const rule = await workRuleRepo.create({
        organizationId: orgId,
        name: "Standard break",
        type: "break_interval",
        hoursThreshold: 6,
        breakHours: 1,
      });

      expect(rule.id).toBeDefined();
      expect(rule.name).toBe("Standard break");
      expect(rule.type).toBe("break_interval");
      expect(rule.hoursThreshold).toBe(6);
      expect(rule.breakHours).toBe(1);
      expect(rule.isActive).toBe(true);
      expect(rule.roleId).toBeNull();
    });

    it("creates a max hours daily rule", async () => {
      const rule = await workRuleRepo.create({
        organizationId: orgId,
        name: "Daily limit",
        type: "max_hours_daily",
        maxHours: 10,
      });

      expect(rule.type).toBe("max_hours_daily");
      expect(rule.maxHours).toBe(10);
    });

    it("creates a max hours weekly rule", async () => {
      const rule = await workRuleRepo.create({
        organizationId: orgId,
        name: "Weekly cap",
        type: "max_hours_weekly",
        maxHours: 48,
      });

      expect(rule.type).toBe("max_hours_weekly");
      expect(rule.maxHours).toBe(48);
    });

    it("creates a rule with role assignment", async () => {
      const role = await prisma.role.create({
        data: {
          organizationId: orgId,
          name: "chef",
          displayLabel: "Chef",
        },
      });

      const rule = await workRuleRepo.create({
        organizationId: orgId,
        name: "Chef daily limit",
        type: "max_hours_daily",
        maxHours: 10,
        roleId: role.id,
      });

      expect(rule.roleId).toBe(role.id);
      expect(rule.role).toBeDefined();
      expect(rule.role!.displayLabel).toBe("Chef");
    });
  });

  describe("findByOrganizationId", () => {
    it("returns all rules for an org", async () => {
      await workRuleRepo.create({
        organizationId: orgId,
        name: "Rule 1",
        type: "break_interval",
        hoursThreshold: 6,
        breakHours: 1,
      });
      await workRuleRepo.create({
        organizationId: orgId,
        name: "Rule 2",
        type: "max_hours_daily",
        maxHours: 10,
      });

      const rules = await workRuleRepo.findByOrganizationId(orgId);
      expect(rules).toHaveLength(2);
    });

    it("does not return rules from other orgs", async () => {
      const otherUser = await userRepo.create({
        name: "Other",
        email: "other@test.com",
        hashedPassword: "hash",
      });
      const otherOrg = await orgRepo.create(
        { name: "Other Org", slug: "other-org" },
        otherUser.id
      );

      await workRuleRepo.create({
        organizationId: otherOrg.id,
        name: "Other rule",
        type: "max_hours_weekly",
        maxHours: 40,
      });

      const rules = await workRuleRepo.findByOrganizationId(orgId);
      expect(rules).toHaveLength(0);
    });
  });

  describe("findApplicableRules", () => {
    it("returns rules with no roleId (applies to all)", async () => {
      await workRuleRepo.create({
        organizationId: orgId,
        name: "Global rule",
        type: "max_hours_weekly",
        maxHours: 48,
      });

      const rules = await workRuleRepo.findApplicableRules(orgId);
      expect(rules).toHaveLength(1);
      expect(rules[0].name).toBe("Global rule");
    });

    it("returns role-specific rules when roleId matches", async () => {
      const role = await prisma.role.create({
        data: { organizationId: orgId, name: "chef", displayLabel: "Chef" },
      });

      await workRuleRepo.create({
        organizationId: orgId,
        name: "Chef limit",
        type: "max_hours_daily",
        maxHours: 10,
        roleId: role.id,
      });

      const rules = await workRuleRepo.findApplicableRules(orgId, role.id);
      expect(rules).toHaveLength(1);
    });

    it("excludes role-specific rules when roleId does not match", async () => {
      const role = await prisma.role.create({
        data: { organizationId: orgId, name: "chef", displayLabel: "Chef" },
      });

      await workRuleRepo.create({
        organizationId: orgId,
        name: "Chef limit",
        type: "max_hours_daily",
        maxHours: 10,
        roleId: role.id,
      });

      const rules = await workRuleRepo.findApplicableRules(orgId, "other-role-id");
      expect(rules).toHaveLength(0);
    });

    it("excludes inactive rules", async () => {
      await workRuleRepo.create({
        organizationId: orgId,
        name: "Disabled rule",
        type: "max_hours_weekly",
        maxHours: 48,
        isActive: false,
      });

      const rules = await workRuleRepo.findApplicableRules(orgId);
      expect(rules).toHaveLength(0);
    });

    it("returns both global and role-specific rules", async () => {
      const role = await prisma.role.create({
        data: { organizationId: orgId, name: "chef", displayLabel: "Chef" },
      });

      await workRuleRepo.create({
        organizationId: orgId,
        name: "Global weekly",
        type: "max_hours_weekly",
        maxHours: 48,
      });
      await workRuleRepo.create({
        organizationId: orgId,
        name: "Chef daily",
        type: "max_hours_daily",
        maxHours: 10,
        roleId: role.id,
      });

      const rules = await workRuleRepo.findApplicableRules(orgId, role.id);
      expect(rules).toHaveLength(2);
    });
  });

  describe("existsByName", () => {
    it("returns true when name exists", async () => {
      await workRuleRepo.create({
        organizationId: orgId,
        name: "Standard break",
        type: "break_interval",
        hoursThreshold: 6,
        breakHours: 1,
      });

      const exists = await workRuleRepo.existsByName(orgId, "Standard break");
      expect(exists).toBe(true);
    });

    it("returns false when name does not exist", async () => {
      const exists = await workRuleRepo.existsByName(orgId, "Nonexistent");
      expect(exists).toBe(false);
    });

    it("excludes self when excludeId is provided", async () => {
      const rule = await workRuleRepo.create({
        organizationId: orgId,
        name: "Standard break",
        type: "break_interval",
        hoursThreshold: 6,
        breakHours: 1,
      });

      const exists = await workRuleRepo.existsByName(orgId, "Standard break", rule.id);
      expect(exists).toBe(false);
    });
  });

  describe("update", () => {
    it("updates rule fields", async () => {
      const rule = await workRuleRepo.create({
        organizationId: orgId,
        name: "Old name",
        type: "max_hours_daily",
        maxHours: 8,
      });

      const updated = await workRuleRepo.update(rule.id, {
        name: "New name",
        maxHours: 10,
      });

      expect(updated.name).toBe("New name");
      expect(updated.maxHours).toBe(10);
    });

    it("toggles isActive", async () => {
      const rule = await workRuleRepo.create({
        organizationId: orgId,
        name: "Toggle rule",
        type: "max_hours_weekly",
        maxHours: 48,
      });

      const updated = await workRuleRepo.update(rule.id, { isActive: false });
      expect(updated.isActive).toBe(false);
    });
  });

  describe("delete", () => {
    it("deletes a rule", async () => {
      const rule = await workRuleRepo.create({
        organizationId: orgId,
        name: "Delete me",
        type: "max_hours_daily",
        maxHours: 10,
      });

      await workRuleRepo.delete(rule.id);

      const found = await workRuleRepo.findById(rule.id);
      expect(found).toBeNull();
    });
  });

  describe("role deletion cascade", () => {
    it("sets roleId to null when referenced Role is deleted", async () => {
      const role = await prisma.role.create({
        data: { organizationId: orgId, name: "chef", displayLabel: "Chef" },
      });

      const rule = await workRuleRepo.create({
        organizationId: orgId,
        name: "Chef daily limit",
        type: "max_hours_daily",
        maxHours: 10,
        roleId: role.id,
      });
      expect(rule.roleId).toBe(role.id);

      // Delete the role — onDelete: SetNull should null out the reference
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
      await prisma.role.delete({ where: { id: role.id } });

      // Work rule should still exist but with null roleId
      const rules = await workRuleRepo.findByOrganizationId(orgId);
      const updatedRule = rules.find((r) => r.id === rule.id);
      expect(updatedRule).toBeDefined();
      expect(updatedRule!.roleId).toBeNull();
    });

    it("global rules are unaffected by role deletion", async () => {
      const role = await prisma.role.create({
        data: { organizationId: orgId, name: "temp", displayLabel: "Temp" },
      });

      const globalRule = await workRuleRepo.create({
        organizationId: orgId,
        name: "Global daily limit",
        type: "max_hours_daily",
        maxHours: 12,
        isActive: true,
      });

      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
      await prisma.role.delete({ where: { id: role.id } });

      const rules = await workRuleRepo.findByOrganizationId(orgId);
      const found = rules.find((r) => r.id === globalRule.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe("Global daily limit");
      expect(found!.maxHours).toBe(12);
      expect(found!.roleId).toBeNull();
    });
  });
});
