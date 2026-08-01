/**
 * Tests for Reporting Repository (Entity Layer)
 *
 * Integration tests verifying dashboard analytics queries:
 * completion metrics, staff utilization, needs-attention alerts,
 * assignment pipeline, certification review data, and department workload.
 *
 * All queries are verified for org-scoped isolation.
 * Department filtering is verified for manager-scoped views.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ReportingRepository } from "@/repositories/reporting.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { UserRepository } from "@/repositories/user.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const reportingRepo = new ReportingRepository();
const orgRepo = new OrganizationRepository();
const deptRepo = new DepartmentRepository();
const userRepo = new UserRepository();
const taskRepo = new TaskRepository();

let adminUserId: string;
let orgId: string;
let kitchenDeptId: string;
let barDeptId: string;
let alexMembershipId: string;
let jamieMembershipId: string;

/** Helper: create a staff member with department assignment */
async function createStaff(
  name: string,
  email: string,
  deptId: string
): Promise<string> {
  const user = await userRepo.create({
    name,
    email,
    hashedPassword: "hash",
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: orgId,
      role: "staff",
      status: "active",
    },
  });
  await prisma.departmentMembership.create({
    data: { membershipId: membership.id, departmentId: deptId },
  });
  return membership.id;
}

/** Helper: create a task and optional assignment in one call */
async function createTaskAndAssignment(opts: {
  title: string;
  deptId: string;
  membershipId?: string;
  assignmentStatus?: string;
  requiredHeadcount?: number;
  taskStatus?: string;
  scheduledStart?: Date;
  scheduledEnd?: Date;
  clockInTime?: Date;
  clockOutTime?: Date;
}) {
  const task = await taskRepo.create({
    title: opts.title,
    organizationId: orgId,
    departmentId: opts.deptId,
    requiredHeadcount: opts.requiredHeadcount ?? 1,
    scheduledStart: opts.scheduledStart,
    scheduledEnd: opts.scheduledEnd,
    createdById: adminUserId,
  });

  if (opts.taskStatus && opts.taskStatus !== "open") {
    await prisma.task.update({
      where: { id: task.id },
      data: { status: opts.taskStatus },
    });
  }

  let assignment = null;
  if (opts.membershipId) {
    assignment = await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: opts.membershipId,
        status: opts.assignmentStatus ?? "assigned",
        assignedById: adminUserId,
        clockInTime: opts.clockInTime,
        clockOutTime: opts.clockOutTime,
      },
    });
  }

  return { task, assignment };
}

beforeEach(async () => {
  await cleanDatabase();

  // Admin user + org
  const admin = await userRepo.create({
    name: "Admin",
    email: "admin@test.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create(
    { name: "Test Org", slug: "test-org" },
    admin.id
  );
  orgId = org.id;

  // Two departments
  const kitchen = await deptRepo.create({
    name: "Kitchen",
    organizationId: orgId,
    color: "#EF4444",
  });
  kitchenDeptId = kitchen.id;

  const bar = await deptRepo.create({
    name: "Bar",
    organizationId: orgId,
    color: "#3B82F6",
  });
  barDeptId = bar.id;

  // Two staff members
  alexMembershipId = await createStaff("Alex", "alex@test.com", kitchenDeptId);
  jamieMembershipId = await createStaff("Jamie", "jamie@test.com", barDeptId);
});

describe("ReportingRepository", () => {
  // ===========================================================
  // Completion Metrics
  // ===========================================================

  describe("getCompletionTimestamps", () => {
    it("returns timestamps for completed assignments in range", async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(14, 0, 0, 0);

      await createTaskAndAssignment({
        title: "Done task",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "completed",
        clockInTime: new Date(yesterday.getTime() - 3600000),
        clockOutTime: yesterday,
      });

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      sevenDaysAgo.setHours(0, 0, 0, 0);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      const result = await reportingRepo.getCompletionTimestamps(
        orgId,
        sevenDaysAgo,
        tomorrow
      );

      expect(result).toHaveLength(1);
      expect(result[0].completedAt).toBeInstanceOf(Date);
    });

    it("returns empty array when no completions exist", async () => {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const result = await reportingRepo.getCompletionTimestamps(
        orgId,
        sevenDaysAgo,
        tomorrow
      );

      expect(result).toHaveLength(0);
    });

    it("filters by department when departmentIds provided", async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(14, 0, 0, 0);

      // Kitchen completion
      await createTaskAndAssignment({
        title: "Kitchen task",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "completed",
        clockInTime: new Date(yesterday.getTime() - 3600000),
        clockOutTime: yesterday,
      });

      // Bar completion
      await createTaskAndAssignment({
        title: "Bar task",
        deptId: barDeptId,
        membershipId: jamieMembershipId,
        assignmentStatus: "completed",
        clockInTime: new Date(yesterday.getTime() - 3600000),
        clockOutTime: yesterday,
      });

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const kitchenOnly = await reportingRepo.getCompletionTimestamps(
        orgId,
        sevenDaysAgo,
        tomorrow,
        [kitchenDeptId]
      );

      expect(kitchenOnly).toHaveLength(1);
    });

    it("excludes completions outside date range", async () => {
      const tenDaysAgo = new Date();
      tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

      await createTaskAndAssignment({
        title: "Old task",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "completed",
        clockInTime: new Date(tenDaysAgo.getTime() - 3600000),
        clockOutTime: tenDaysAgo,
      });

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const result = await reportingRepo.getCompletionTimestamps(
        orgId,
        sevenDaysAgo,
        tomorrow
      );

      expect(result).toHaveLength(0);
    });
  });

  describe("countCompletions", () => {
    it("counts completions accurately in date range", async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(14, 0, 0, 0);

      // 2 completed assignments
      await createTaskAndAssignment({
        title: "Task 1",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "completed",
        clockInTime: new Date(yesterday.getTime() - 3600000),
        clockOutTime: yesterday,
      });
      await createTaskAndAssignment({
        title: "Task 2",
        deptId: barDeptId,
        membershipId: jamieMembershipId,
        assignmentStatus: "completed",
        clockInTime: new Date(yesterday.getTime() - 3600000),
        clockOutTime: yesterday,
      });

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const count = await reportingRepo.countCompletions(
        orgId,
        sevenDaysAgo,
        tomorrow
      );

      expect(count).toBe(2);
    });

    it("returns 0 when no completions", async () => {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const count = await reportingRepo.countCompletions(
        orgId,
        sevenDaysAgo,
        tomorrow
      );

      expect(count).toBe(0);
    });
  });

  // ===========================================================
  // Staff & Utilization
  // ===========================================================

  describe("getClockData", () => {
    it("returns clock records for completed assignments", async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const clockIn = new Date(yesterday);
      clockIn.setHours(8, 0, 0, 0);
      const clockOut = new Date(yesterday);
      clockOut.setHours(12, 0, 0, 0);

      await createTaskAndAssignment({
        title: "Morning shift",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "completed",
        clockInTime: clockIn,
        clockOutTime: clockOut,
      });

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      sevenDaysAgo.setHours(0, 0, 0, 0);

      const result = await reportingRepo.getClockData(orgId, sevenDaysAgo);

      expect(result).toHaveLength(1);
      expect(result[0].membershipId).toBe(alexMembershipId);
      expect(result[0].staffName).toBe("Alex");
      expect(result[0].clockInTime).toEqual(clockIn);
      expect(result[0].clockOutTime).toEqual(clockOut);
    });

    it("excludes assignments without clock-out time", async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const clockIn = new Date(yesterday);
      clockIn.setHours(8, 0, 0, 0);

      // Accepted but not clocked out
      await createTaskAndAssignment({
        title: "Incomplete shift",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "completed",
        clockInTime: clockIn,
        // no clockOutTime
      });

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      sevenDaysAgo.setHours(0, 0, 0, 0);

      const result = await reportingRepo.getClockData(orgId, sevenDaysAgo);

      expect(result).toHaveLength(0);
    });

    it("filters by department when departmentIds provided", async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const clockIn = new Date(yesterday);
      clockIn.setHours(8, 0, 0, 0);
      const clockOut = new Date(yesterday);
      clockOut.setHours(12, 0, 0, 0);

      await createTaskAndAssignment({
        title: "Kitchen shift",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "completed",
        clockInTime: clockIn,
        clockOutTime: clockOut,
      });
      await createTaskAndAssignment({
        title: "Bar shift",
        deptId: barDeptId,
        membershipId: jamieMembershipId,
        assignmentStatus: "completed",
        clockInTime: clockIn,
        clockOutTime: clockOut,
      });

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      sevenDaysAgo.setHours(0, 0, 0, 0);

      const barOnly = await reportingRepo.getClockData(orgId, sevenDaysAgo, [
        barDeptId,
      ]);

      expect(barOnly).toHaveLength(1);
      expect(barOnly[0].staffName).toBe("Jamie");
    });
  });

  describe("getActiveStaffCount", () => {
    it("counts active staff and managers", async () => {
      // beforeEach creates 2 staff + 1 admin (admin role is company_admin)
      const count = await reportingRepo.getActiveStaffCount(orgId);
      expect(count).toBe(2);
    });

    it("excludes inactive members", async () => {
      await prisma.membership.update({
        where: { id: alexMembershipId },
        data: { status: "inactive" },
      });

      const count = await reportingRepo.getActiveStaffCount(orgId);
      expect(count).toBe(1);
    });

    it("filters by department when departmentIds provided", async () => {
      const kitchenCount = await reportingRepo.getActiveStaffCount(orgId, [
        kitchenDeptId,
      ]);
      expect(kitchenCount).toBe(1);
    });
  });

  // ===========================================================
  // Task Metrics
  // ===========================================================

  describe("getUnderstaffedTasks", () => {
    it("identifies tasks needing more staff", async () => {
      // requiredHeadcount: 3, only 1 assigned
      await createTaskAndAssignment({
        title: "Big task",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "assigned",
        requiredHeadcount: 3,
      });

      const result = await reportingRepo.getUnderstaffedTasks(orgId);

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Big task");
      expect(result[0].requiredHeadcount).toBe(3);
      expect(result[0].assignedCount).toBe(1);
      expect(result[0].departmentName).toBe("Kitchen");
    });

    it("excludes fully-staffed tasks", async () => {
      // requiredHeadcount: 1, 1 assigned — fully staffed
      await createTaskAndAssignment({
        title: "Staffed task",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "assigned",
        requiredHeadcount: 1,
      });

      const result = await reportingRepo.getUnderstaffedTasks(orgId);

      expect(result).toHaveLength(0);
    });

    it("excludes completed and cancelled tasks", async () => {
      await createTaskAndAssignment({
        title: "Completed task",
        deptId: kitchenDeptId,
        requiredHeadcount: 3,
        taskStatus: "completed",
      });
      await createTaskAndAssignment({
        title: "Cancelled task",
        deptId: kitchenDeptId,
        requiredHeadcount: 3,
        taskStatus: "cancelled",
      });

      const result = await reportingRepo.getUnderstaffedTasks(orgId);

      expect(result).toHaveLength(0);
    });

    it("filters by department", async () => {
      await createTaskAndAssignment({
        title: "Kitchen understaffed",
        deptId: kitchenDeptId,
        requiredHeadcount: 2,
      });
      await createTaskAndAssignment({
        title: "Bar understaffed",
        deptId: barDeptId,
        requiredHeadcount: 2,
      });

      const kitchenOnly = await reportingRepo.getUnderstaffedTasks(orgId, [
        kitchenDeptId,
      ]);

      expect(kitchenOnly).toHaveLength(1);
      expect(kitchenOnly[0].title).toBe("Kitchen understaffed");
    });
  });

  describe("getTasksForDateRange", () => {
    it("returns tasks overlapping the date range", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const start = new Date(tomorrow);
      start.setHours(8, 0, 0, 0);
      const end = new Date(tomorrow);
      end.setHours(12, 0, 0, 0);

      await createTaskAndAssignment({
        title: "Tomorrow shift",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "assigned",
        scheduledStart: start,
        scheduledEnd: end,
      });

      const dayStart = new Date(tomorrow);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(tomorrow);
      dayEnd.setHours(23, 59, 59, 999);

      const result = await reportingRepo.getTasksForDateRange(
        orgId,
        dayStart,
        dayEnd
      );

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Tomorrow shift");
      expect(result[0].assignedCount).toBe(1);
      expect(result[0].activeAssignmentCount).toBe(1);
    });

    it("excludes tasks outside the date range", async () => {
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      const start = new Date(nextWeek);
      start.setHours(8, 0, 0, 0);
      const end = new Date(nextWeek);
      end.setHours(12, 0, 0, 0);

      await createTaskAndAssignment({
        title: "Next week task",
        deptId: kitchenDeptId,
        scheduledStart: start,
        scheduledEnd: end,
      });

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dayStart = new Date(tomorrow);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(tomorrow);
      dayEnd.setHours(23, 59, 59, 999);

      const result = await reportingRepo.getTasksForDateRange(
        orgId,
        dayStart,
        dayEnd
      );

      expect(result).toHaveLength(0);
    });

    it("returns tasks ordered by scheduled start", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const lateStart = new Date(tomorrow);
      lateStart.setHours(14, 0, 0, 0);
      const lateEnd = new Date(tomorrow);
      lateEnd.setHours(18, 0, 0, 0);

      const earlyStart = new Date(tomorrow);
      earlyStart.setHours(7, 0, 0, 0);
      const earlyEnd = new Date(tomorrow);
      earlyEnd.setHours(11, 0, 0, 0);

      // Create late task first
      await createTaskAndAssignment({
        title: "Afternoon shift",
        deptId: barDeptId,
        scheduledStart: lateStart,
        scheduledEnd: lateEnd,
      });
      await createTaskAndAssignment({
        title: "Morning shift",
        deptId: kitchenDeptId,
        scheduledStart: earlyStart,
        scheduledEnd: earlyEnd,
      });

      const dayStart = new Date(tomorrow);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(tomorrow);
      dayEnd.setHours(23, 59, 59, 999);

      const result = await reportingRepo.getTasksForDateRange(
        orgId,
        dayStart,
        dayEnd
      );

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe("Morning shift");
      expect(result[1].title).toBe("Afternoon shift");
    });
  });

  describe("getDepartmentMetrics", () => {
    it("returns task and staff counts per department", async () => {
      // Kitchen: 2 tasks, 1 staff (Alex)
      await createTaskAndAssignment({ title: "K1", deptId: kitchenDeptId });
      await createTaskAndAssignment({ title: "K2", deptId: kitchenDeptId });

      // Bar: 1 task, 1 staff (Jamie)
      await createTaskAndAssignment({ title: "B1", deptId: barDeptId });

      const result = await reportingRepo.getDepartmentMetrics(orgId);

      expect(result).toHaveLength(2);

      const kitchen = result.find((d) => d.name === "Kitchen");
      expect(kitchen).toBeDefined();
      expect(kitchen!.activeTaskCount).toBe(2);
      expect(kitchen!.staffCount).toBe(1);
      expect(kitchen!.color).toBe("#EF4444");

      const bar = result.find((d) => d.name === "Bar");
      expect(bar).toBeDefined();
      expect(bar!.activeTaskCount).toBe(1);
      expect(bar!.staffCount).toBe(1);
    });

    it("only counts active (open/in_progress) tasks", async () => {
      await createTaskAndAssignment({ title: "Open task", deptId: kitchenDeptId });
      await createTaskAndAssignment({
        title: "Completed task",
        deptId: kitchenDeptId,
        taskStatus: "completed",
      });
      await createTaskAndAssignment({
        title: "Cancelled task",
        deptId: kitchenDeptId,
        taskStatus: "cancelled",
      });

      const result = await reportingRepo.getDepartmentMetrics(orgId);
      const kitchen = result.find((d) => d.name === "Kitchen");

      expect(kitchen!.activeTaskCount).toBe(1);
    });

    it("only counts active staff members", async () => {
      // Deactivate Alex
      await prisma.membership.update({
        where: { id: alexMembershipId },
        data: { status: "inactive" },
      });

      const result = await reportingRepo.getDepartmentMetrics(orgId);
      const kitchen = result.find((d) => d.name === "Kitchen");

      expect(kitchen!.staffCount).toBe(0);
    });
  });

  // ===========================================================
  // Assignment Metrics
  // ===========================================================

  describe("countAssignmentsByStatus", () => {
    it("groups assignments by status accurately", async () => {
      const since = new Date();
      since.setDate(since.getDate() - 7);
      since.setHours(0, 0, 0, 0);

      await createTaskAndAssignment({
        title: "T1",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "assigned",
      });
      await createTaskAndAssignment({
        title: "T2",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "in_progress",
      });
      await createTaskAndAssignment({
        title: "T3",
        deptId: barDeptId,
        membershipId: jamieMembershipId,
        assignmentStatus: "cancelled",
      });

      const result = await reportingRepo.countAssignmentsByStatus(orgId, since);

      const assigned = result.find((r) => r.status === "assigned");
      const inProgress = result.find((r) => r.status === "in_progress");
      const cancelled = result.find((r) => r.status === "cancelled");

      expect(assigned?.count).toBe(1);
      expect(inProgress?.count).toBe(1);
      expect(cancelled?.count).toBe(1);
    });
  });

  // Pending-assignment and rejection-analysis queries were removed with the
  // auto-assigned lifecycle; staff no longer accept or reject assigned work.

  // ===========================================================
  // Certification Metrics
  // ===========================================================

  describe("getExpiringCertifications", () => {
    it("returns certs expiring within N days", async () => {
      const expires = new Date();
      expires.setDate(expires.getDate() + 15);

      await prisma.certification.create({
        data: {
          membershipId: alexMembershipId,
          name: "Food Safety",
          issuedDate: new Date("2025-01-01"),
          expiryDate: expires,
          status: "verified",
        },
      });

      const result = await reportingRepo.getExpiringCertifications(orgId, 30);

      expect(result).toHaveLength(1);
      expect(result[0].certName).toBe("Food Safety");
      expect(result[0].staffName).toBe("Alex");
    });

    it("excludes certs expiring beyond the window", async () => {
      const farFuture = new Date();
      farFuture.setDate(farFuture.getDate() + 90);

      await prisma.certification.create({
        data: {
          membershipId: alexMembershipId,
          name: "First Aid",
          issuedDate: new Date("2025-01-01"),
          expiryDate: farFuture,
          status: "verified",
        },
      });

      const result = await reportingRepo.getExpiringCertifications(orgId, 30);

      expect(result).toHaveLength(0);
    });

    it("excludes unverified certs", async () => {
      const expires = new Date();
      expires.setDate(expires.getDate() + 15);

      await prisma.certification.create({
        data: {
          membershipId: alexMembershipId,
          name: "Pending cert",
          issuedDate: new Date("2025-01-01"),
          expiryDate: expires,
          status: "pending",
        },
      });

      const result = await reportingRepo.getExpiringCertifications(orgId, 30);

      expect(result).toHaveLength(0);
    });
  });

  describe("getPendingCertVerifications", () => {
    it("returns certs awaiting verification", async () => {
      await prisma.certification.create({
        data: {
          membershipId: alexMembershipId,
          name: "New cert",
          issuedDate: new Date(),
          status: "pending",
        },
      });
      await prisma.certification.create({
        data: {
          membershipId: jamieMembershipId,
          name: "Verified cert",
          issuedDate: new Date(),
          status: "verified",
        },
      });

      const result = await reportingRepo.getPendingCertVerifications(orgId);

      expect(result).toHaveLength(1);
      expect(result[0].certName).toBe("New cert");
      expect(result[0].staffName).toBe("Alex");
    });
  });

  // ===========================================================
  // Staff Personal
  // ===========================================================

  describe("getStaffAssignments", () => {
    it("returns assignments for a staff member in date range", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const start = new Date(tomorrow);
      start.setHours(8, 0, 0, 0);
      const end = new Date(tomorrow);
      end.setHours(12, 0, 0, 0);

      await createTaskAndAssignment({
        title: "My shift",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "assigned",
        scheduledStart: start,
        scheduledEnd: end,
      });

      const weekStart = new Date(tomorrow);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(tomorrow);
      weekEnd.setDate(weekEnd.getDate() + 7);
      weekEnd.setHours(0, 0, 0, 0);

      const result = await reportingRepo.getStaffAssignments(
        alexMembershipId,
        weekStart,
        weekEnd
      );

      expect(result).toHaveLength(1);
      expect(result[0].taskTitle).toBe("My shift");
      expect(result[0].status).toBe("assigned");
      expect(result[0].departmentName).toBe("Kitchen");
      expect(result[0].departmentColor).toBe("#EF4444");
    });

    it("excludes cancelled assignments", async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const start = new Date(tomorrow);
      start.setHours(8, 0, 0, 0);
      const end = new Date(tomorrow);
      end.setHours(12, 0, 0, 0);

      await createTaskAndAssignment({
        title: "Cancelled shift",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "cancelled",
        scheduledStart: start,
        scheduledEnd: end,
      });

      const weekStart = new Date(tomorrow);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(tomorrow);
      weekEnd.setDate(weekEnd.getDate() + 7);
      weekEnd.setHours(0, 0, 0, 0);

      const result = await reportingRepo.getStaffAssignments(
        alexMembershipId,
        weekStart,
        weekEnd
      );

      expect(result).toHaveLength(0);
    });
  });

  describe("getStaffAvailability", () => {
    it("returns weekly schedule for a staff member", async () => {
      await prisma.availability.createMany({
        data: [
          {
            membershipId: alexMembershipId,
            dayOfWeek: 1,
            startTime: "08:00",
            endTime: "16:00",
            isAvailable: true,
          },
          {
            membershipId: alexMembershipId,
            dayOfWeek: 2,
            startTime: "08:00",
            endTime: "16:00",
            isAvailable: true,
          },
        ],
      });

      const result = await reportingRepo.getStaffAvailability(
        alexMembershipId
      );

      expect(result).toHaveLength(2);
      expect(result[0].dayOfWeek).toBe(1);
      expect(result[0].startTime).toBe("08:00");
      expect(result[0].isAvailable).toBe(true);
    });
  });

  describe("getStaffAssignmentHistory", () => {
    it("returns raw assignment data for stats computation", async () => {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      since.setHours(0, 0, 0, 0);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      await createTaskAndAssignment({
        title: "Completed",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "completed",
        scheduledStart: new Date(tomorrow.setHours(8, 0, 0, 0)),
        scheduledEnd: new Date(tomorrow.setHours(12, 0, 0, 0)),
        clockInTime: new Date(tomorrow.setHours(7, 55, 0, 0)),
        clockOutTime: new Date(tomorrow.setHours(12, 5, 0, 0)),
      });
      await createTaskAndAssignment({
        title: "Assigned",
        deptId: kitchenDeptId,
        membershipId: alexMembershipId,
        assignmentStatus: "assigned",
      });

      const result = await reportingRepo.getStaffAssignmentHistory(
        alexMembershipId,
        since
      );

      expect(result).toHaveLength(2);
      const completed = result.find((r) => r.status === "completed");
      const assigned = result.find((r) => r.status === "assigned");
      expect(completed).toBeDefined();
      expect(assigned).toBeDefined();
      expect(completed!.clockInTime).toBeInstanceOf(Date);
    });
  });

  // ===========================================================
  // Multi-Tenant Isolation
  // ===========================================================

  describe("org isolation", () => {
    it("does not return data from other organizations", async () => {
      const otherUser = await userRepo.create({
        name: "Other",
        email: "other@test.com",
        hashedPassword: "hash",
      });
      const otherOrg = await orgRepo.create(
        { name: "Other Org", slug: "other-org" },
        otherUser.id
      );
      const otherDept = await deptRepo.create({
        name: "Other Dept",
        organizationId: otherOrg.id,
      });
      const otherMembership = await prisma.membership.findFirstOrThrow({
        where: { userId: otherUser.id, organizationId: otherOrg.id },
      });

      // Create task in other org
      await taskRepo.create({
        title: "Other org task",
        organizationId: otherOrg.id,
        departmentId: otherDept.id,
        requiredHeadcount: 5,
        createdById: otherUser.id,
      });

      // Create cert in other org
      await prisma.certification.create({
        data: {
          membershipId: otherMembership.id,
          name: "Other cert",
          issuedDate: new Date(),
          status: "pending",
        },
      });

      // All queries scoped to our org should return 0
      const understaffed = await reportingRepo.getUnderstaffedTasks(orgId);
      const certs = await reportingRepo.getPendingCertVerifications(orgId);
      const metrics = await reportingRepo.getDepartmentMetrics(orgId);

      expect(understaffed).toHaveLength(0);
      expect(certs).toHaveLength(0);

      // Our org has 2 departments (Kitchen, Bar) but no tasks
      expect(metrics).toHaveLength(2);
      expect(metrics.every((d) => d.activeTaskCount === 0)).toBe(true);
    });
  });
});
