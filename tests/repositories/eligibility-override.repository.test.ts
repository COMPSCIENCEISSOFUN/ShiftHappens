/**
 * Tests for EligibilityOverride Repository (Entity Layer)
 * Verifies override CRUD and existence checking.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EligibilityOverrideRepository } from "@/repositories/eligibility-override.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const overrideRepo = new EligibilityOverrideRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();
const taskRepo = new TaskRepository();

let membershipId: string;
let adminUserId: string;
let taskId: string;

beforeEach(async () => {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create(
    { name: "Acme Corp", slug: "acme-corp" },
    admin.id
  );

  const staff = await userRepo.create({
    name: "Staff User",
    email: "staff@example.com",
    hashedPassword: "hash",
  });

  const staffMembership = await prisma.membership.create({
    data: {
      userId: staff.id,
      organizationId: org.id,
      role: "staff",
      status: "active",
    },
  });
  membershipId = staffMembership.id;

  const task = await taskRepo.create({
    title: "Test task",
    organizationId: org.id,
    createdById: admin.id,
  });
  taskId = task.id;
});

describe("EligibilityOverrideRepository", () => {
  describe("create", () => {
    it("creates an override with details", async () => {
      const override = await overrideRepo.create({
        taskId,
        membershipId,
        overriddenById: adminUserId,
        reason: "Staff has equivalent experience",
        ruleOverridden: "certification",
      });

      expect(override.id).toBeDefined();
      expect(override.ruleOverridden).toBe("certification");
      expect(override.reason).toBe("Staff has equivalent experience");
    });
  });

  describe("findByTaskId", () => {
    it("returns all overrides for a task", async () => {
      await overrideRepo.create({
        taskId,
        membershipId,
        overriddenById: adminUserId,
        reason: "Reason 1",
        ruleOverridden: "certification",
      });
      await overrideRepo.create({
        taskId,
        membershipId,
        overriddenById: adminUserId,
        reason: "Reason 2",
        ruleOverridden: "hours_limit",
      });

      const overrides = await overrideRepo.findByTaskId(taskId);
      expect(overrides).toHaveLength(2);
    });
  });

  describe("findByMembershipId", () => {
    it("returns all overrides for a member", async () => {
      await overrideRepo.create({
        taskId,
        membershipId,
        overriddenById: adminUserId,
        reason: "Approved",
        ruleOverridden: "availability",
      });

      const overrides = await overrideRepo.findByMembershipId(membershipId);
      expect(overrides).toHaveLength(1);
      expect(overrides[0].task.title).toBe("Test task");
    });
  });

  describe("hasOverride", () => {
    it("returns true when override exists", async () => {
      await overrideRepo.create({
        taskId,
        membershipId,
        overriddenById: adminUserId,
        reason: "Approved",
        ruleOverridden: "certification",
      });

      const has = await overrideRepo.hasOverride(taskId, membershipId, "certification");
      expect(has).toBe(true);
    });

    it("returns false when no override", async () => {
      const has = await overrideRepo.hasOverride(taskId, membershipId, "certification");
      expect(has).toBe(false);
    });

    it("returns false for different rule", async () => {
      await overrideRepo.create({
        taskId,
        membershipId,
        overriddenById: adminUserId,
        reason: "Approved",
        ruleOverridden: "certification",
      });

      const has = await overrideRepo.hasOverride(taskId, membershipId, "hours_limit");
      expect(has).toBe(false);
    });
  });
});
