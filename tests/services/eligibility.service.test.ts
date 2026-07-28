/**
 * Tests for Eligibility Service (Control Layer)
 *
 * Verifies the four-dimensional eligibility engine:
 * 1. Hours limit (24h rolling window)
 * 2. Availability (weekly schedule + overrides)
 *    - Casual staff: availability is a hard constraint
 *    - Full-time staff: availability check skipped (always available)
 * 3. Scheduling conflicts (overlapping assignments)
 * 4. Work rules (break_interval, max_hours_daily, max_hours_weekly)
 *
 * Also covers eligibility overrides and employment type behavior.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EligibilityService } from "@/services/eligibility.service";
import { TaskRepository } from "@/repositories/task.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { sgt } from "../helpers/time";

const eligibilityService = new EligibilityService();
const taskRepo = new TaskRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();
const availRepo = new AvailabilityRepository();

let orgId: string;
let adminUserId: string;
let staffMembershipId: string;

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
  orgId = org.id;

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
  staffMembershipId = staffMembership.id;

  await prisma.companySettings.create({
    data: {
      organizationId: org.id,
      breakRuleHoursWorked: 8,
    },
  });
});

describe("EligibilityService", () => {
  describe("checkEligibilityForTask", () => {
    it("returns eligible staff when no constraints", async () => {
      const task = await taskRepo.create({
        title: "Simple task",
        organizationId: orgId,
        createdById: adminUserId,
      });

      const results = await eligibilityService.checkEligibilityForTask(
        task.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult).toBeDefined();
      expect(staffResult!.eligible).toBe(true);

      const adminResult = results.find(
        (r) => r.memberName === "Admin User"
      );
      expect(adminResult).toBeUndefined();
    });

    it("marks staff ineligible when unavailable", async () => {
      const task = await taskRepo.create({
        title: "Scheduled task",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T09:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T12:00:00.000Z"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        task.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(false);
      expect(staffResult!.checks.availability.eligible).toBe(false);
    });

    it("marks staff eligible when available", async () => {
      await availRepo.setDayAvailability({
        membershipId: staffMembershipId,
        dayOfWeek: 1,
        startTime: "08:00",
        endTime: "18:00",
        isAvailable: true,
      });

      const task = await taskRepo.create({
        title: "Monday task",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: sgt("2026-06-15T09:00"),
        scheduledEnd: sgt("2026-06-15T12:00"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        task.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(true);
      expect(staffResult!.checks.availability.eligible).toBe(true);
    });

    it("marks staff ineligible with scheduling conflict", async () => {
      const task1 = await taskRepo.create({
        title: "Morning shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T09:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T12:00:00.000Z"),
      });

      await prisma.taskAssignment.create({
        data: {
          taskId: task1.id,
          membershipId: staffMembershipId,
          assignedById: adminUserId,
          status: "accepted",
        },
      });

      const task2 = await taskRepo.create({
        title: "Overlapping task",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T10:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T14:00:00.000Z"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        task2.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(false);
      expect(staffResult!.checks.scheduling.eligible).toBe(false);
    });

    it("throws if task not found", async () => {
      await expect(
        eligibilityService.checkEligibilityForTask("nonexistent", orgId)
      ).rejects.toThrow("Task not found");
    });
  });

  describe("checkHoursLimit", () => {
    it("returns eligible when under limit", async () => {
      const result = await eligibilityService.checkHoursLimit(
        staffMembershipId,
        8
      );
      expect(result.eligible).toBe(true);
    });

    it("returns ineligible when over limit", async () => {
      const task = await taskRepo.create({
        title: "Long shift",
        organizationId: orgId,
        createdById: adminUserId,
      });

      const now = new Date();
      const nineHoursAgo = new Date(now.getTime() - 9 * 60 * 60 * 1000);

      await prisma.taskAssignment.create({
        data: {
          taskId: task.id,
          membershipId: staffMembershipId,
          assignedById: adminUserId,
          status: "completed",
          clockInTime: nineHoursAgo,
          clockOutTime: now,
        },
      });

      const result = await eligibilityService.checkHoursLimit(
        staffMembershipId,
        8
      );
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("limit");
    });
  });

  describe("work rules integration", () => {
    it("staff passes when no work rules exist in org", async () => {
      const task = await taskRepo.create({
        title: "No rules task",
        organizationId: orgId,
        createdById: adminUserId,
      });

      const results = await eligibilityService.checkEligibilityForTask(
        task.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(true);
    });

    it("marks staff ineligible when max_hours_daily exceeded", async () => {
      // Monday availability so staff passes availability check
      await availRepo.setDayAvailability({
        membershipId: staffMembershipId,
        dayOfWeek: 1,
        startTime: "06:00",
        endTime: "23:00",
        isAvailable: true,
      });

      // Work rule: max 8 hours per day
      await prisma.workRule.create({
        data: {
          organizationId: orgId,
          name: "Daily limit",
          type: "max_hours_daily",
          maxHours: 8,
          isActive: true,
        },
      });

      // Completed assignment on Monday 2026-06-15 with 9 hours clocked
      const pastTask = await taskRepo.create({
        title: "Morning shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T08:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T17:00:00.000Z"),
      });
      await prisma.taskAssignment.create({
        data: {
          taskId: pastTask.id,
          membershipId: staffMembershipId,
          assignedById: adminUserId,
          status: "completed",
          clockInTime: new Date("2026-06-15T08:00:00.000Z"),
          clockOutTime: new Date("2026-06-15T17:00:00.000Z"),
        },
      });

      // New task on the same day (Monday)
      const newTask = await taskRepo.create({
        title: "Evening shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T18:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T21:00:00.000Z"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        newTask.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(false);
    });

    it("staff passes max_hours_daily when under the limit", async () => {
      await availRepo.setDayAvailability({
        membershipId: staffMembershipId,
        dayOfWeek: 1,
        startTime: "06:00",
        endTime: "23:00",
        isAvailable: true,
      });

      await prisma.workRule.create({
        data: {
          organizationId: orgId,
          name: "Daily limit",
          type: "max_hours_daily",
          maxHours: 10,
          isActive: true,
        },
      });

      // Only 4 hours clocked on Monday
      const pastTask = await taskRepo.create({
        title: "Short shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T08:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T12:00:00.000Z"),
      });
      await prisma.taskAssignment.create({
        data: {
          taskId: pastTask.id,
          membershipId: staffMembershipId,
          assignedById: adminUserId,
          status: "completed",
          clockInTime: new Date("2026-06-15T08:00:00.000Z"),
          clockOutTime: new Date("2026-06-15T12:00:00.000Z"),
        },
      });

      const newTask = await taskRepo.create({
        title: "Afternoon shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T14:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T17:00:00.000Z"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        newTask.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(true);
    });

    it("inactive work rules are ignored", async () => {
      await availRepo.setDayAvailability({
        membershipId: staffMembershipId,
        dayOfWeek: 1,
        startTime: "06:00",
        endTime: "23:00",
        isAvailable: true,
      });

      // Inactive rule with very low limit
      await prisma.workRule.create({
        data: {
          organizationId: orgId,
          name: "Strict daily limit",
          type: "max_hours_daily",
          maxHours: 1,
          isActive: false,
        },
      });

      // 4 hours clocked — would exceed the rule if active
      const pastTask = await taskRepo.create({
        title: "Shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T08:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T12:00:00.000Z"),
      });
      await prisma.taskAssignment.create({
        data: {
          taskId: pastTask.id,
          membershipId: staffMembershipId,
          assignedById: adminUserId,
          status: "completed",
          clockInTime: new Date("2026-06-15T08:00:00.000Z"),
          clockOutTime: new Date("2026-06-15T12:00:00.000Z"),
        },
      });

      const newTask = await taskRepo.create({
        title: "Next shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T14:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T17:00:00.000Z"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        newTask.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      // Rule is inactive so staff should pass
      expect(staffResult!.eligible).toBe(true);
    });

    it("staff with zero hours passes all work rules", async () => {
      await availRepo.setDayAvailability({
        membershipId: staffMembershipId,
        dayOfWeek: 1,
        startTime: "06:00",
        endTime: "23:00",
        isAvailable: true,
      });

      // Strict rules — but staff has zero hours
      await prisma.workRule.create({
        data: {
          organizationId: orgId,
          name: "Daily limit",
          type: "max_hours_daily",
          maxHours: 4,
          isActive: true,
        },
      });

      const task = await taskRepo.create({
        title: "First shift ever",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T09:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T12:00:00.000Z"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        task.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(true);
    });

    it("marks staff ineligible when max_hours_weekly exceeded", async () => {
      await availRepo.setDayAvailability({
        membershipId: staffMembershipId,
        dayOfWeek: 1,
        startTime: "06:00",
        endTime: "23:00",
        isAvailable: true,
      });

      // Weekly limit of 20 hours
      await prisma.workRule.create({
        data: {
          organizationId: orgId,
          name: "Weekly limit",
          type: "max_hours_weekly",
          maxHours: 20,
          isActive: true,
        },
      });

      // 22 hours already clocked earlier in the same week (Mon-Fri = same week)
      // Monday 10h
      const task1 = await taskRepo.create({
        title: "Mon shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T08:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T18:00:00.000Z"),
      });
      await prisma.taskAssignment.create({
        data: {
          taskId: task1.id,
          membershipId: staffMembershipId,
          assignedById: adminUserId,
          status: "completed",
          clockInTime: new Date("2026-06-15T08:00:00.000Z"),
          clockOutTime: new Date("2026-06-15T18:00:00.000Z"),
        },
      });

      // Tuesday 12h
      await availRepo.setDayAvailability({
        membershipId: staffMembershipId,
        dayOfWeek: 2,
        startTime: "06:00",
        endTime: "23:00",
        isAvailable: true,
      });
      const task2 = await taskRepo.create({
        title: "Tue shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-16T07:00:00.000Z"),
        scheduledEnd: new Date("2026-06-16T19:00:00.000Z"),
      });
      await prisma.taskAssignment.create({
        data: {
          taskId: task2.id,
          membershipId: staffMembershipId,
          assignedById: adminUserId,
          status: "completed",
          clockInTime: new Date("2026-06-16T07:00:00.000Z"),
          clockOutTime: new Date("2026-06-16T19:00:00.000Z"),
        },
      });

      // New task on Wednesday in the same week — should be blocked (22h > 20h)
      await availRepo.setDayAvailability({
        membershipId: staffMembershipId,
        dayOfWeek: 3,
        startTime: "06:00",
        endTime: "23:00",
        isAvailable: true,
      });
      const newTask = await taskRepo.create({
        title: "Wed shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-17T09:00:00.000Z"),
        scheduledEnd: new Date("2026-06-17T17:00:00.000Z"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        newTask.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(false);
    });
  });

  describe("employment type", () => {
    it("full-time staff is eligible without any availability set", async () => {
      await prisma.membership.update({
        where: { id: staffMembershipId },
        data: { employmentType: "full_time" },
      });

      const task = await taskRepo.create({
        title: "Scheduled task",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: sgt("2026-06-15T09:00"),
        scheduledEnd: sgt("2026-06-15T12:00"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        task.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(true);
      expect(staffResult!.checks.availability.eligible).toBe(true);
      expect(staffResult!.employmentType).toBe("full_time");
    });

    it("casual staff is still ineligible without availability", async () => {
      const task = await taskRepo.create({
        title: "Scheduled task",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: sgt("2026-06-15T09:00"),
        scheduledEnd: sgt("2026-06-15T12:00"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        task.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(false);
      expect(staffResult!.checks.availability.eligible).toBe(false);
      expect(staffResult!.employmentType).toBe("casual");
    });

    it("full-time staff is still blocked by scheduling conflicts", async () => {
      await prisma.membership.update({
        where: { id: staffMembershipId },
        data: { employmentType: "full_time" },
      });

      const task1 = await taskRepo.create({
        title: "Morning shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: sgt("2026-06-15T09:00"),
        scheduledEnd: sgt("2026-06-15T12:00"),
      });
      await prisma.taskAssignment.create({
        data: {
          taskId: task1.id,
          membershipId: staffMembershipId,
          assignedById: adminUserId,
          status: "accepted",
        },
      });

      const task2 = await taskRepo.create({
        title: "Overlapping task",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: sgt("2026-06-15T10:00"),
        scheduledEnd: sgt("2026-06-15T14:00"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        task2.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(false);
      expect(staffResult!.checks.scheduling.eligible).toBe(false);
      expect(staffResult!.checks.availability.eligible).toBe(true);
    });

    it("full-time staff is still blocked by work rules", async () => {
      await prisma.membership.update({
        where: { id: staffMembershipId },
        data: { employmentType: "full_time" },
      });

      await prisma.workRule.create({
        data: {
          organizationId: orgId,
          name: "Daily limit",
          type: "max_hours_daily",
          maxHours: 8,
          isActive: true,
        },
      });

      // 9 hours already worked — local dates to match getHoursOnDate's setHours(0,0,0,0)
      const pastTask = await taskRepo.create({
        title: "Long shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: sgt("2026-06-15T08:00"),
        scheduledEnd: sgt("2026-06-15T17:00"),
      });
      await prisma.taskAssignment.create({
        data: {
          taskId: pastTask.id,
          membershipId: staffMembershipId,
          assignedById: adminUserId,
          status: "completed",
          clockInTime: sgt("2026-06-15T08:00"),
          clockOutTime: sgt("2026-06-15T17:00"),
        },
      });

      const newTask = await taskRepo.create({
        title: "Evening shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: sgt("2026-06-15T18:00"),
        scheduledEnd: sgt("2026-06-15T21:00"),
      });

      const results = await eligibilityService.checkEligibilityForTask(
        newTask.id,
        orgId
      );

      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.eligible).toBe(false);
      expect(staffResult!.checks.workRules.eligible).toBe(false);
      expect(staffResult!.checks.availability.eligible).toBe(true);
    });

    it("returns employmentType in results for all staff", async () => {
      const ftUser = await userRepo.create({
        name: "Full Timer",
        email: "fulltime@example.com",
        hashedPassword: "hash",
      });
      await prisma.membership.create({
        data: {
          userId: ftUser.id,
          organizationId: orgId,
          role: "staff",
          status: "active",
          employmentType: "full_time",
        },
      });

      const task = await taskRepo.create({
        title: "Simple task",
        organizationId: orgId,
        createdById: adminUserId,
      });

      const results = await eligibilityService.checkEligibilityForTask(
        task.id,
        orgId
      );

      const casualResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      const ftResult = results.find((r) => r.memberName === "Full Timer");

      expect(casualResult!.employmentType).toBe("casual");
      expect(ftResult!.employmentType).toBe("full_time");
    });
  });

  describe("createOverride", () => {
    it("creates an eligibility override", async () => {
      const task = await taskRepo.create({
        title: "Test task",
        organizationId: orgId,
        createdById: adminUserId,
      });

      const override = await eligibilityService.createOverride(
        task.id,
        staffMembershipId,
        adminUserId,
        "Staff has equivalent experience",
        "certification",
        orgId
      );

      expect(override.ruleOverridden).toBe("certification");
      expect(override.reason).toBe("Staff has equivalent experience");
    });

    it("override makes staff eligible for blocked rule", async () => {
      const task = await taskRepo.create({
        title: "Test task",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T09:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T12:00:00.000Z"),
      });

      let results = await eligibilityService.checkEligibilityForTask(
        task.id,
        orgId
      );
      let staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.checks.availability.eligible).toBe(false);

      await eligibilityService.createOverride(
        task.id,
        staffMembershipId,
        adminUserId,
        "Manager approved",
        "availability",
        orgId
      );

      results = await eligibilityService.checkEligibilityForTask(
        task.id,
        orgId
      );
      staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.checks.availability.eligible).toBe(true);
      expect(staffResult!.overrides).toContain("availability");
    });

    it("an 'all' override waives a scheduling conflict", async () => {
      const task1 = await taskRepo.create({
        title: "Morning shift",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T09:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T12:00:00.000Z"),
      });
      await prisma.taskAssignment.create({
        data: {
          taskId: task1.id,
          membershipId: staffMembershipId,
          assignedById: adminUserId,
          status: "accepted",
        },
      });
      const task2 = await taskRepo.create({
        title: "Overlapping task",
        organizationId: orgId,
        createdById: adminUserId,
        scheduledStart: new Date("2026-06-15T10:00:00.000Z"),
        scheduledEnd: new Date("2026-06-15T14:00:00.000Z"),
      });

      // Blanket "all" override waives every warning for this member on the task.
      await eligibilityService.createOverride(
        task2.id,
        staffMembershipId,
        adminUserId,
        "Short-staffed — manager approved",
        "all",
        orgId
      );

      const results = await eligibilityService.checkEligibilityForTask(
        task2.id,
        orgId
      );
      const staffResult = results.find(
        (r) => r.membershipId === staffMembershipId
      );
      expect(staffResult!.checks.scheduling.eligible).toBe(true);
      expect(staffResult!.eligible).toBe(true);
      expect(staffResult!.overrides).toContain("all");
    });
  });
});