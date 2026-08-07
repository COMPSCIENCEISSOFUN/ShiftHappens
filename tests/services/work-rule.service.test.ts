/**
 * Tests for Work Rule Service (Control Layer)
 * Verifies business logic: type-specific field validation,
 * name uniqueness, CRUD operations, and applicable rules lookup.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { WorkRuleService } from "@/services/work-rule.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { cleanDatabase } from "../helpers/cleanup";

const workRuleService = new WorkRuleService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let userId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin",
    email: "admin@test.com",
    hashedPassword: "hash",
  });
  userId = user.id;

  const org = await orgRepo.create(
    { name: "Test Org", slug: "test-org" },
    user.id
  );
  orgId = org.id;
});

describe("WorkRuleService", () => {
  describe("create", () => {
    it("creates a break interval rule with required fields", async () => {
      const rule = await workRuleService.create(
        {
          name: "Standard break",
          type: "break_interval",
          hoursThreshold: 6,
          breakHours: 1,
        },
        orgId,
        userId
      );

      expect(rule.name).toBe("Standard break");
      expect(rule.type).toBe("break_interval");
      expect(rule.hoursThreshold).toBe(6);
      expect(rule.breakHours).toBe(1);
    });

    it("creates a max hours daily rule", async () => {
      const rule = await workRuleService.create(
        { name: "Daily cap", type: "max_hours_daily", maxHours: 10 },
        orgId,
        userId
      );

      expect(rule.maxHours).toBe(10);
    });

    it("creates a max hours weekly rule", async () => {
      const rule = await workRuleService.create(
        { name: "Weekly cap", type: "max_hours_weekly", maxHours: 48 },
        orgId,
        userId
      );

      expect(rule.maxHours).toBe(48);
    });

    it("rejects break_interval without hoursThreshold", async () => {
      await expect(
        workRuleService.create(
          { name: "Bad rule", type: "break_interval", breakHours: 1 },
          orgId,
          userId
        )
      ).rejects.toThrow("Hours threshold is required");
    });

    it("rejects break_interval without breakHours", async () => {
      await expect(
        workRuleService.create(
          { name: "Bad rule", type: "break_interval", hoursThreshold: 6 },
          orgId,
          userId
        )
      ).rejects.toThrow("Break hours is required");
    });

    it("rejects max_hours_daily without maxHours", async () => {
      await expect(
        workRuleService.create(
          { name: "Bad rule", type: "max_hours_daily" },
          orgId,
          userId
        )
      ).rejects.toThrow("Max hours is required");
    });

    it("rejects duplicate name in same org", async () => {
      await workRuleService.create(
        { name: "My rule", type: "max_hours_weekly", maxHours: 48 },
        orgId,
        userId
      );

      await expect(
        workRuleService.create(
          { name: "My rule", type: "max_hours_daily", maxHours: 10 },
          orgId,
          userId
        )
      ).rejects.toThrow("already exists");
    });

    it("allows same name in different orgs", async () => {
      const otherUser = await userRepo.create({
        name: "Other",
        email: "other@test.com",
        hashedPassword: "hash",
      });
      const otherOrg = await orgRepo.create(
        { name: "Other Org", slug: "other-org" },
        otherUser.id
      );

      await workRuleService.create(
        { name: "Weekly cap", type: "max_hours_weekly", maxHours: 48 },
        orgId,
        userId
      );

      const rule = await workRuleService.create(
        { name: "Weekly cap", type: "max_hours_weekly", maxHours: 40 },
        otherOrg.id,
        otherUser.id
      );

      expect(rule.name).toBe("Weekly cap");
    });
  });

  describe("update", () => {
    it("updates rule fields", async () => {
      const rule = await workRuleService.create(
        { name: "Old name", type: "max_hours_daily", maxHours: 8 },
        orgId,
        userId
      );

      const updated = await workRuleService.update(
        rule.id,
        orgId,
        { name: "New name", maxHours: 10 },
        userId
      );

      expect(updated.name).toBe("New name");
      expect(updated.maxHours).toBe(10);
    });

    it("rejects update with missing required fields for type", async () => {
      const rule = await workRuleService.create(
        { name: "Break rule", type: "break_interval", hoursThreshold: 6, breakHours: 1 },
        orgId,
        userId
      );

      await expect(
        workRuleService.update(
          rule.id,
          orgId,
          { hoursThreshold: null },
          userId
        )
      ).rejects.toThrow("Hours threshold is required");
    });

    it("rejects update to duplicate name", async () => {
      await workRuleService.create(
        { name: "Rule A", type: "max_hours_daily", maxHours: 8 },
        orgId,
        userId
      );
      const ruleB = await workRuleService.create(
        { name: "Rule B", type: "max_hours_weekly", maxHours: 48 },
        orgId,
        userId
      );

      await expect(
        workRuleService.update(ruleB.id, orgId, { name: "Rule A" }, userId)
      ).rejects.toThrow("already exists");
    });

    it("throws for non-existent rule", async () => {
      await expect(
        workRuleService.update("nonexistent", orgId, { name: "X" }, userId)
      ).rejects.toThrow("not found");
    });

    it("throws for rule from different org", async () => {
      const otherUser = await userRepo.create({
        name: "Other",
        email: "other@test.com",
        hashedPassword: "hash",
      });
      const otherOrg = await orgRepo.create(
        { name: "Other Org", slug: "other-org" },
        otherUser.id
      );

      const rule = await workRuleService.create(
        { name: "Other rule", type: "max_hours_daily", maxHours: 8 },
        otherOrg.id,
        otherUser.id
      );

      await expect(
        workRuleService.update(rule.id, orgId, { name: "Stolen" }, userId)
      ).rejects.toThrow("not found");
    });
  });

  describe("delete", () => {
    it("deletes a rule", async () => {
      const rule = await workRuleService.create(
        { name: "Delete me", type: "max_hours_daily", maxHours: 10 },
        orgId,
        userId
      );

      await workRuleService.delete(rule.id, orgId, userId);

      const found = await workRuleService.getById(rule.id);
      expect(found).toBeNull();
    });

    it("throws for non-existent rule", async () => {
      await expect(
        workRuleService.delete("nonexistent", orgId, userId)
      ).rejects.toThrow("not found");
    });
  });

  describe("getApplicableRules", () => {
    it("returns active global rules", async () => {
      await workRuleService.create(
        { name: "Global", type: "max_hours_weekly", maxHours: 48 },
        orgId,
        userId
      );
      await workRuleService.create(
        { name: "Disabled", type: "max_hours_daily", maxHours: 10, isActive: false },
        orgId,
        userId
      );

      const rules = await workRuleService.getApplicableRules(orgId);
      expect(rules).toHaveLength(1);
      expect(rules[0].name).toBe("Global");
    });
  });
});
