/**
 * Tests for Auto-Schedule Service (Control Layer)
 *
 * Covers the algorithmic schedule generation (deterministic fallback),
 * schedule confirmation, and edge cases. AI path is not tested
 * since it requires external API keys — the algorithmic fallback
 * is the safety net and must be rock-solid.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import bcrypt from "bcryptjs";
import { atHourSgt, nextMondaySgt } from "../helpers/time";

let orgId: string;
let adminUserId: string;
let staffMembershipIds: string[];
let deptId: string;

beforeEach(async () => {
  await cleanDatabase();

  const hashedPassword = await bcrypt.hash("TestPass1!", 12);

  const admin = await prisma.user.create({
    data: { name: "Admin", email: "admin@test.com", hashedPassword, emailVerified: new Date() },
  });
  adminUserId = admin.id;

  const org = await prisma.organization.create({
    data: { name: "Test Org", slug: "test-org" },
  });
  orgId = org.id;

  await prisma.membership.create({
    data: { userId: admin.id, organizationId: orgId, role: "company_admin", status: "active" },
  });

  await prisma.companySettings.create({
    data: { organizationId: orgId, allocationMode: "auto" },
  });

  const dept = await prisma.department.create({
    data: { name: "Kitchen", organizationId: orgId, color: "#EF4444" },
  });
  deptId = dept.id;

  // Create 3 staff with availability
  staffMembershipIds = [];
  const staffData = [
    { name: "Staff A", email: "a@test.com" },
    { name: "Staff B", email: "b@test.com" },
    { name: "Staff C", email: "c@test.com" },
  ];

  for (const s of staffData) {
    const user = await prisma.user.create({
      data: { name: s.name, email: s.email, hashedPassword, emailVerified: new Date() },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId: orgId, role: "staff", status: "active" },
    });
    staffMembershipIds.push(membership.id);

    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: deptId },
    });

    // Available Mon-Fri 6am-6pm
    for (let d = 1; d <= 5; d++) {
      await prisma.availability.create({
        data: { membershipId: membership.id, dayOfWeek: d, startTime: "06:00", endTime: "18:00", isAvailable: true },
      });
    }
  }
});

describe("AutoScheduleService", () => {
  describe("generateSchedule", () => {
    it("returns empty when no tasks need staffing", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();

      const draft = await service.generateSchedule(orgId, weekStart);

      expect(draft.assignments).toEqual([]);
      expect(draft.unfilledTasks).toEqual([]);
      expect(draft.summary.totalTasks).toBe(0);
    });

    it("assigns staff to open tasks for the week", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1); // Tuesday

      await prisma.task.create({
        data: {
          title: "Test Task",
          organizationId: orgId,
          departmentId: deptId,
          priority: "high",
          requiredHeadcount: 2,
          scheduledStart: setHour(taskDate, 8),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      const draft = await service.generateSchedule(orgId, weekStart);

      // Should have assignments (AI or algorithmic)
      expect(draft.assignments.length).toBeGreaterThanOrEqual(1);
      expect(draft.summary.totalTasks).toBe(1);
    });

    it("skips fully staffed tasks", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);

      const task = await prisma.task.create({
        data: {
          title: "Full Task",
          organizationId: orgId,
          departmentId: deptId,
          priority: "medium",
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, 9),
          scheduledEnd: setHour(taskDate, 11),
          createdById: adminUserId,
        },
      });

      // Already assigned
      await prisma.taskAssignment.create({
        data: { taskId: task.id, membershipId: staffMembershipIds[0], assignedById: adminUserId, status: "assigned" },
      });

      const draft = await service.generateSchedule(orgId, weekStart);
      expect(draft.summary.totalTasks).toBe(0);
    });

    it("skips tasks outside the selected week", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();

      // Task 2 weeks from now
      const futureDate = new Date(weekStart);
      futureDate.setDate(futureDate.getDate() + 14);

      await prisma.task.create({
        data: {
          title: "Future Task",
          organizationId: orgId,
          priority: "medium",
          requiredHeadcount: 1,
          scheduledStart: setHour(futureDate, 9),
          scheduledEnd: setHour(futureDate, 12),
          createdById: adminUserId,
        },
      });

      const draft = await service.generateSchedule(orgId, weekStart);
      expect(draft.summary.totalTasks).toBe(0);
    });

    it("reports unfilled tasks when not enough staff", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);

      await prisma.task.create({
        data: {
          title: "Big Task",
          organizationId: orgId,
          departmentId: deptId,
          priority: "high",
          requiredHeadcount: 10,
          scheduledStart: setHour(taskDate, 8),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      const draft = await service.generateSchedule(orgId, weekStart);

      expect(draft.unfilledTasks.length).toBe(1);
      expect(draft.unfilledTasks[0].taskTitle).toBe("Big Task");
    });

    it("does not double-book staff across overlapping tasks", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);

      // Two overlapping tasks, each needing 3 staff (only 3 available)
      await prisma.task.create({
        data: {
          title: "Task A",
          organizationId: orgId,
          departmentId: deptId,
          priority: "high",
          requiredHeadcount: 3,
          scheduledStart: setHour(taskDate, 8),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      await prisma.task.create({
        data: {
          title: "Task B",
          organizationId: orgId,
          departmentId: deptId,
          priority: "medium",
          requiredHeadcount: 3,
          scheduledStart: setHour(taskDate, 10),
          scheduledEnd: setHour(taskDate, 14),
          createdById: adminUserId,
        },
      });

      const draft = await service.generateSchedule(orgId, weekStart);

      // All 3 staff should go to Task A (higher priority)
      // Task B should be unfilled or partially filled
      const taskAAssignments = draft.assignments.filter((a) => a.taskTitle === "Task A");
      const taskBAssignments = draft.assignments.filter((a) => a.taskTitle === "Task B");

      expect(taskAAssignments.length).toBe(3);
      expect(taskBAssignments.length).toBe(0);
      expect(draft.unfilledTasks.length).toBe(1);
    });

    it("distributes hours fairly across staff", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();

      // Create 3 non-overlapping tasks, each needing 1 staff
      for (let i = 0; i < 3; i++) {
        const taskDate = new Date(weekStart);
        taskDate.setDate(taskDate.getDate() + 1 + i); // Tue, Wed, Thu

        await prisma.task.create({
          data: {
            title: `Task ${i + 1}`,
            organizationId: orgId,
            departmentId: deptId,
            priority: "medium",
            requiredHeadcount: 1,
            scheduledStart: setHour(taskDate, 9),
            scheduledEnd: setHour(taskDate, 12),
            createdById: adminUserId,
          },
        });
      }

      const draft = await service.generateSchedule(orgId, weekStart);

      expect(draft.assignments.length).toBe(3);

      // Each staff member should get 1 task (fairness)
      const staffNames = draft.assignments.map((a) => a.staffName);
      const unique = new Set(staffNames);
      expect(unique.size).toBe(3);
    });
  });

  describe("confirmSchedule", () => {
    it("creates assignments in batch", async () => {
      const service = new AutoScheduleService();
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);

      const task = await prisma.task.create({
        data: {
          title: "Confirm Test",
          organizationId: orgId,
          departmentId: deptId,
          priority: "medium",
          requiredHeadcount: 2,
          scheduledStart: setHour(taskDate, 9),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      const result = await service.confirmSchedule(orgId, [
        { taskId: task.id, taskTitle: task.title, membershipId: staffMembershipIds[0], staffName: "Staff A", reasoning: "test" },
        { taskId: task.id, taskTitle: task.title, membershipId: staffMembershipIds[1], staffName: "Staff B", reasoning: "test" },
      ], adminUserId);

      expect(result.created).toBe(2);
      expect(result.failed).toBe(0);
    });

    /**
     * A draft referencing a task that does not exist must be counted as failed
     * rather than aborting the whole confirmation — one bad row should not cost
     * the user the other nineteen.
     *
     * The console.error spy asserts the second half of that contract: the
     * failure is reported, not silently absorbed into a count. It also keeps the
     * deliberate Prisma error out of the suite's stderr.
     */
    it("handles failures gracefully", async () => {
      const service = new AutoScheduleService();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const result = await service.confirmSchedule(orgId, [
          { taskId: "nonexistent", taskTitle: "Bad", membershipId: staffMembershipIds[0], staffName: "Staff A", reasoning: "test" },
        ], adminUserId);

        expect(result.created).toBe(0);
        expect(result.failed).toBe(1);

        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining("[Auto-Schedule] Failed"),
          expect.anything()
        );
      } finally {
        logged.mockRestore();
      }
    });
  });
});

// Helpers
// Weekday and midnight resolved in the organisation's timezone. The runner's
// clock would place these fixtures on a different day, and the scheduler now
// matches availability using Singapore time — so nothing matched at all.
function getNextMonday(): Date {
  return nextMondaySgt();
}

function setHour(date: Date, hour: number): Date {
  return atHourSgt(date, hour);
}
