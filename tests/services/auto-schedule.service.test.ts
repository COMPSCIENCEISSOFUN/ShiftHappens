/**
 * Tests for Auto-Schedule Service (Control Layer)
 *
 * Covers the algorithmic schedule generation (deterministic fallback),
 * schedule confirmation, and edge cases. AI path is not tested
 * since it requires external API keys — the algorithmic fallback
 * is the safety net and must be rock-solid.
 */
import { describe, it, expect, beforeEach } from "vitest";
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
    it("only includes tasks in the manager's authorized departments", async () => {
      const secondDepartment = await prisma.department.create({
        data: { name: "Bar", organizationId: orgId },
      });
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);
      await prisma.task.createMany({
        data: [
          { title: "Kitchen task", organizationId: orgId, departmentId: deptId, requiredHeadcount: 1, scheduledStart: setHour(taskDate, 8), scheduledEnd: setHour(taskDate, 12), createdById: adminUserId },
          { title: "Bar task", organizationId: orgId, departmentId: secondDepartment.id, requiredHeadcount: 1, scheduledStart: setHour(taskDate, 13), scheduledEnd: setHour(taskDate, 17), createdById: adminUserId },
        ],
      });

      const draft = await new AutoScheduleService().generateSchedule(orgId, weekStart, [deptId]);

      expect(draft.summary.totalTasks).toBe(1);
      expect(draft.assignments.every((assignment) => assignment.taskTitle === "Kitchen task")).toBe(true);
    });

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

    it("does not draft a staff member into an already committed overlapping task", async () => {
      const weekStart = getNextMonday();
      const taskDate = new Date(weekStart);
      taskDate.setDate(taskDate.getDate() + 1);
      const occupied = await prisma.task.create({
        data: { title: "Committed work", organizationId: orgId, departmentId: deptId, requiredHeadcount: 1, scheduledStart: setHour(taskDate, 8), scheduledEnd: setHour(taskDate, 12), createdById: adminUserId },
      });
      await prisma.taskAssignment.create({ data: { taskId: occupied.id, membershipId: staffMembershipIds[0], assignedById: adminUserId } });
      await prisma.task.create({
        data: { title: "Open overlapping work", organizationId: orgId, departmentId: deptId, requiredHeadcount: 1, scheduledStart: setHour(taskDate, 9), scheduledEnd: setHour(taskDate, 13), createdById: adminUserId },
      });

      const draft = await new AutoScheduleService().generateSchedule(orgId, weekStart);

      expect(draft.assignments.find((assignment) => assignment.taskTitle === "Open overlapping work")?.membershipId).not.toBe(staffMembershipIds[0]);
    });

    it("applies weekly availability only to temporary or part-time staff", async () => {
      await prisma.membership.update({
        where: { id: staffMembershipIds[0] },
        data: { employmentType: "temporary_part_time" },
      });
      await prisma.membership.update({
        where: { id: staffMembershipIds[1] },
        data: { employmentType: "casual" },
      });
      await prisma.membership.update({
        where: { id: staffMembershipIds[2] },
        data: { status: "inactive" },
      });
      await prisma.availability.deleteMany({
        where: { membershipId: { in: staffMembershipIds.slice(0, 2) } },
      });

      const taskDate = new Date(getNextMonday());
      taskDate.setDate(taskDate.getDate() + 1);
      await prisma.task.create({
        data: {
          title: "Employment availability task",
          organizationId: orgId,
          departmentId: deptId,
          requiredHeadcount: 2,
          scheduledStart: setHour(taskDate, 9),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      const draft = await new AutoScheduleService().generateSchedule(
        orgId,
        getNextMonday()
      );
      const selectedIds = draft.assignments.map(
        (assignment) => assignment.membershipId
      );

      expect(selectedIds).toContain(staffMembershipIds[1]);
      expect(selectedIds).not.toContain(staffMembershipIds[0]);
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
        { taskId: task.id, membershipId: staffMembershipIds[0] },
        { taskId: task.id, membershipId: staffMembershipIds[1] },
      ], adminUserId);

      expect(result.created).toBe(2);
      expect(result.failed).toBe(0);
      expect(
        await prisma.notification.count({
          where: {
            organizationId: orgId,
            type: "task_assigned",
            message: { contains: task.title },
          },
        })
      ).toBe(2);
    });

    /** Any stale or tampered reference rejects the complete confirmation. */
    it("rejects an unknown task without creating anything", async () => {
      const service = new AutoScheduleService();

      await expect(
        service.confirmSchedule(
          orgId,
          [{ taskId: "nonexistent", membershipId: staffMembershipIds[0] }],
          adminUserId
        )
      ).rejects.toThrow("Task not found");

      expect(await prisma.taskAssignment.count()).toBe(0);
    });

    it("rolls back every task when one schedule reference is invalid", async () => {
      const service = new AutoScheduleService();
      const firstDate = new Date(getNextMonday());
      firstDate.setDate(firstDate.getDate() + 1);
      const secondDate = new Date(getNextMonday());
      secondDate.setDate(secondDate.getDate() + 2);
      const firstTask = await prisma.task.create({
        data: {
          title: "Valid schedule task",
          organizationId: orgId,
          departmentId: deptId,
          requiredHeadcount: 1,
          scheduledStart: setHour(firstDate, 9),
          scheduledEnd: setHour(firstDate, 12),
          createdById: adminUserId,
        },
      });
      const secondTask = await prisma.task.create({
        data: {
          title: "Tampered schedule task",
          organizationId: orgId,
          departmentId: deptId,
          requiredHeadcount: 1,
          scheduledStart: setHour(secondDate, 9),
          scheduledEnd: setHour(secondDate, 12),
          createdById: adminUserId,
        },
      });

      await expect(
        service.confirmSchedule(
          orgId,
          [
            { taskId: firstTask.id, membershipId: staffMembershipIds[0] },
            { taskId: secondTask.id, membershipId: "tampered-membership-id" },
          ],
          adminUserId
        )
      ).rejects.toThrow();

      expect(await prisma.taskAssignment.count()).toBe(0);
      expect(await prisma.notification.count()).toBe(0);
    });

    it("rejects a task ID belonging to another organization", async () => {
      const service = new AutoScheduleService();
      const otherOrganization = await prisma.organization.create({
        data: { name: "Other Organization", slug: "other-schedule-org" },
      });
      const taskDate = new Date(getNextMonday());
      taskDate.setDate(taskDate.getDate() + 1);
      const otherTask = await prisma.task.create({
        data: {
          title: "Other tenant task",
          organizationId: otherOrganization.id,
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, 9),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      await expect(
        service.confirmSchedule(
          orgId,
          [{ taskId: otherTask.id, membershipId: staffMembershipIds[0] }],
          adminUserId
        )
      ).rejects.toThrow("Task not found");

      expect(await prisma.taskAssignment.count()).toBe(0);
      expect(await prisma.notification.count()).toBe(0);
    });

    it("rejects tasks outside the caller's department scope", async () => {
      const service = new AutoScheduleService();
      const otherDepartment = await prisma.department.create({
        data: { name: "Front Desk", organizationId: orgId },
      });
      await prisma.departmentMembership.create({
        data: {
          membershipId: staffMembershipIds[0],
          departmentId: otherDepartment.id,
        },
      });
      const taskDate = new Date(getNextMonday());
      taskDate.setDate(taskDate.getDate() + 1);
      const task = await prisma.task.create({
        data: {
          title: "Out of scope",
          organizationId: orgId,
          departmentId: otherDepartment.id,
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, 9),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });

      await expect(
        service.confirmSchedule(
          orgId,
          [{ taskId: task.id, membershipId: staffMembershipIds[0] }],
          adminUserId,
          [deptId]
        )
      ).rejects.toThrow("Task not found");

      expect(await prisma.taskAssignment.count()).toBe(0);
    });

    it("rejects overlapping tasks for the same staff as one atomic schedule", async () => {
      const service = new AutoScheduleService();
      const taskDate = new Date(getNextMonday());
      taskDate.setDate(taskDate.getDate() + 1);
      const firstTask = await prisma.task.create({
        data: {
          title: "Overlap one",
          organizationId: orgId,
          departmentId: deptId,
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, 9),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });
      const secondTask = await prisma.task.create({
        data: {
          title: "Overlap two",
          organizationId: orgId,
          departmentId: deptId,
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, 10),
          scheduledEnd: setHour(taskDate, 13),
          createdById: adminUserId,
        },
      });

      await expect(
        service.confirmSchedule(
          orgId,
          [
            { taskId: firstTask.id, membershipId: staffMembershipIds[0] },
            { taskId: secondTask.id, membershipId: staffMembershipIds[0] },
          ],
          adminUserId
        )
      ).rejects.toThrow("overlapping tasks");

      expect(await prisma.taskAssignment.count()).toBe(0);
    });

    it("allows only one concurrent confirmation for overlapping tasks", async () => {
      const taskDate = new Date(getNextMonday());
      taskDate.setDate(taskDate.getDate() + 1);
      const firstTask = await prisma.task.create({
        data: {
          title: "Concurrent overlap one",
          organizationId: orgId,
          departmentId: deptId,
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, 9),
          scheduledEnd: setHour(taskDate, 12),
          createdById: adminUserId,
        },
      });
      const secondTask = await prisma.task.create({
        data: {
          title: "Concurrent overlap two",
          organizationId: orgId,
          departmentId: deptId,
          requiredHeadcount: 1,
          scheduledStart: setHour(taskDate, 10),
          scheduledEnd: setHour(taskDate, 13),
          createdById: adminUserId,
        },
      });

      const results = await Promise.allSettled([
        new AutoScheduleService().confirmSchedule(
          orgId,
          [{ taskId: firstTask.id, membershipId: staffMembershipIds[0] }],
          adminUserId
        ),
        new AutoScheduleService().confirmSchedule(
          orgId,
          [{ taskId: secondTask.id, membershipId: staffMembershipIds[0] }],
          adminUserId
        ),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await prisma.taskAssignment.count()).toBe(1);
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
