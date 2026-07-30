/**
 * Tests for Reporting Service (Control Layer)
 *
 * Verifies dashboard data aggregation through ReportingRepository:
 * - Legacy getDashboardReports (backward compatibility)
 * - Needs-attention alerts
 * - Key metrics (pipeline, completion rate, hours)
 * - Tomorrow's schedule
 * - Completion chart (7-day)
 * - Staff utilization
 * - Department workload with imbalance detection
 * - Rejection trends grouped by staff
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ReportingService } from "@/services/reporting.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { UserRepository } from "@/repositories/user.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { atHourSgt, startOfTodaySgt, todaySgtAt } from "../helpers/time";

const reportingService = new ReportingService();
const orgRepo = new OrganizationRepository();
const deptRepo = new DepartmentRepository();
const userRepo = new UserRepository();
const taskRepo = new TaskRepository();

let orgId: string;
let userId: string;
let staffMembershipId: string;
let deptId: string;

/** Helper: create a staff member with optional department */
async function createStaff(
  name: string,
  email: string,
  deptIdParam?: string
): Promise<string> {
  const user = await userRepo.create({ name, email, hashedPassword: "hash" });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: orgId,
      role: "staff",
      status: "active",
    },
  });
  if (deptIdParam) {
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: deptIdParam },
    });
  }
  return membership.id;
}

/** Helper: create task + optional assignment */
async function createTaskAndAssignment(opts: {
  title: string;
  deptId?: string;
  membershipId?: string;
  assignmentStatus?: string;
  requiredHeadcount?: number;
  taskStatus?: string;
  scheduledStart?: Date;
  scheduledEnd?: Date;
  clockInTime?: Date;
  clockOutTime?: Date;
  rejectionReason?: string;
}) {
  const task = await taskRepo.create({
    title: opts.title,
    organizationId: orgId,
    departmentId: opts.deptId ?? deptId,
    requiredHeadcount: opts.requiredHeadcount ?? 1,
    scheduledStart: opts.scheduledStart,
    scheduledEnd: opts.scheduledEnd,
    createdById: userId,
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
        status: opts.assignmentStatus ?? "pending",
        assignedById: userId,
        clockInTime: opts.clockInTime,
        clockOutTime: opts.clockOutTime,
        rejectionReason: opts.rejectionReason,
      },
    });
  }

  return { task, assignment };
}

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  userId = user.id;

  const org = await orgRepo.create(
    { name: "Test Org", slug: "test-org" },
    user.id
  );
  orgId = org.id;

  // Create company settings
  await prisma.companySettings.create({
    data: {
      organizationId: orgId,
      breakRuleHoursWorked: 8,
    },
  });

  // Create department
  const dept = await deptRepo.create({
    name: "Kitchen",
    organizationId: orgId,
    color: "#EF4444",
  });
  deptId = dept.id;

  // Create staff member assigned to department
  staffMembershipId = await createStaff("Staff User", "staff@example.com", deptId);
});

describe("ReportingService", () => {
  // ===========================================================
  // Legacy getDashboardReports (backward compatibility)
  // ===========================================================

  describe("getDashboardReports", () => {
    it("returns all four report sections", async () => {
      const reports = await reportingService.getDashboardReports(orgId);

      expect(reports).toHaveProperty("completionTrend");
      expect(reports).toHaveProperty("staffUtilization");
      expect(reports).toHaveProperty("departmentWorkload");
      expect(reports).toHaveProperty("hoursSummary");
    });

    it("returns 7 days in completion trend", async () => {
      const reports = await reportingService.getDashboardReports(orgId);

      expect(reports.completionTrend).toHaveLength(7);
      expect(reports.completionTrend[0]).toHaveProperty("date");
      expect(reports.completionTrend[0]).toHaveProperty("label");
      expect(reports.completionTrend[0]).toHaveProperty("completed");
    });

    it("counts completed tasks in completion trend", async () => {
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      await createTaskAndAssignment({
        title: "Test task",
        membershipId: staffMembershipId,
        assignmentStatus: "completed",
        clockInTime: twoHoursAgo,
        clockOutTime: now,
      });

      const reports = await reportingService.getDashboardReports(orgId);

      const today = reports.completionTrend[reports.completionTrend.length - 1];
      expect(today.completed).toBe(1);
    });

    it("calculates staff utilization from clock data", async () => {
      const now = new Date();
      const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

      await createTaskAndAssignment({
        title: "Test task",
        membershipId: staffMembershipId,
        assignmentStatus: "completed",
        clockInTime: fourHoursAgo,
        clockOutTime: now,
      });

      const reports = await reportingService.getDashboardReports(orgId);

      const staffUtil = reports.staffUtilization.find(
        (s) => s.name === "Staff User"
      );
      expect(staffUtil).toBeDefined();
      expect(staffUtil!.hoursWorked).toBeGreaterThan(3.5);
      expect(staffUtil!.hoursWorked).toBeLessThan(4.5);
      expect(staffUtil!.percentage).toBeGreaterThan(0);
    });

    it("returns department workload with colors", async () => {
      await createTaskAndAssignment({ title: "Kitchen task 1" });
      await createTaskAndAssignment({ title: "Kitchen task 2" });

      const reports = await reportingService.getDashboardReports(orgId);

      const kitchen = reports.departmentWorkload.find(
        (d) => d.name === "Kitchen"
      );
      expect(kitchen).toBeDefined();
      expect(kitchen!.taskCount).toBe(2);
      expect(kitchen!.color).toBe("#EF4444");
    });

    it("handles empty data gracefully", async () => {
      const reports = await reportingService.getDashboardReports(orgId);

      expect(reports.completionTrend).toHaveLength(7);
      expect(reports.completionTrend.every((d) => d.completed === 0)).toBe(true);
      expect(reports.hoursSummary.totalLogged).toBe(0);
    });
  });

  // ===========================================================
  // Needs Attention
  // ===========================================================

  describe("getNeedsAttention", () => {
    it("returns understaffed task alerts as danger severity", async () => {
      await createTaskAndAssignment({
        title: "Big event",
        requiredHeadcount: 3,
        membershipId: staffMembershipId,
        assignmentStatus: "accepted",
      });

      const items = await reportingService.getNeedsAttention(orgId);

      const understaffed = items.filter((i) => i.type === "understaffed");
      expect(understaffed).toHaveLength(1);
      expect(understaffed[0].severity).toBe("danger");
      expect(understaffed[0].message).toContain("2 more staff");
      expect(understaffed[0].actionLabel).toBe("Assign");
    });

    it("returns pending assignment alerts as warning severity", async () => {
      await createTaskAndAssignment({
        title: "Pending task",
        membershipId: staffMembershipId,
        assignmentStatus: "pending",
      });

      const items = await reportingService.getNeedsAttention(orgId);

      const pending = items.filter((i) => i.type === "pending_acceptance");
      expect(pending).toHaveLength(1);
      expect(pending[0].severity).toBe("warning");
      expect(pending[0].message).toContain("1 assignment");
      expect(pending[0].message).toContain("Staff User");
    });

    it("returns expiring certification alerts", async () => {
      const expiresSoon = new Date();
      expiresSoon.setDate(expiresSoon.getDate() + 10);

      await prisma.certification.create({
        data: {
          membershipId: staffMembershipId,
          name: "Food Safety",
          issuedDate: new Date("2025-01-01"),
          expiryDate: expiresSoon,
          status: "verified",
        },
      });

      const items = await reportingService.getNeedsAttention(orgId);

      const certs = items.filter((i) => i.type === "expiring_cert");
      expect(certs).toHaveLength(1);
      expect(certs[0].severity).toBe("warning");
      expect(certs[0].message).toContain("Food Safety");
      expect(certs[0].message).toContain("10 days");
    });

    it("returns pending verification alerts as info severity", async () => {
      await prisma.certification.create({
        data: {
          membershipId: staffMembershipId,
          name: "First Aid",
          issuedDate: new Date(),
          status: "pending",
        },
      });

      const items = await reportingService.getNeedsAttention(orgId);

      const verifications = items.filter(
        (i) => i.type === "pending_verification"
      );
      expect(verifications).toHaveLength(1);
      expect(verifications[0].severity).toBe("info");
      expect(verifications[0].actionLabel).toBe("Review");
    });

    it("returns empty array when nothing needs attention", async () => {
      const items = await reportingService.getNeedsAttention(orgId);
      expect(items).toHaveLength(0);
    });
  });

  // ===========================================================
  // Key Metrics
  // ===========================================================

  describe("getKeyMetrics", () => {
    it("returns assignment pipeline breakdown", async () => {
      await createTaskAndAssignment({
        title: "Pending",
        membershipId: staffMembershipId,
        assignmentStatus: "pending",
      });

      const jamie = await createStaff("Jamie", "jamie@example.com", deptId);
      await createTaskAndAssignment({
        title: "Accepted",
        membershipId: jamie,
        assignmentStatus: "accepted",
      });

      const metrics = await reportingService.getKeyMetrics(orgId);

      expect(metrics.assignmentPipeline.total).toBeGreaterThanOrEqual(2);
      expect(metrics.assignmentPipeline.pending).toBeGreaterThanOrEqual(1);
      expect(metrics.assignmentPipeline.accepted).toBeGreaterThanOrEqual(1);
    });

    it("returns completion rate with trend direction", async () => {
      const metrics = await reportingService.getKeyMetrics(orgId);

      expect(metrics.completionRate).toHaveProperty("current");
      expect(metrics.completionRate).toHaveProperty("previous");
      expect(metrics.completionRate).toHaveProperty("trend");
      expect(["up", "down", "flat"]).toContain(metrics.completionRate.trend);
    });

    it("returns hours logged with utilization", async () => {
      const now = new Date();
      const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      await createTaskAndAssignment({
        title: "Shift",
        membershipId: staffMembershipId,
        assignmentStatus: "completed",
        clockInTime: threeHoursAgo,
        clockOutTime: now,
      });

      const metrics = await reportingService.getKeyMetrics(orgId);

      expect(metrics.hoursLogged.hours).toBeGreaterThan(2.5);
      expect(metrics.hoursLogged.capacity).toBeGreaterThan(0);
      expect(metrics.hoursLogged.utilization).toBeGreaterThan(0);
    });
  });

  // ===========================================================
  // Tomorrow's Schedule
  // ===========================================================

  describe("getTomorrowsSchedule", () => {
    it("returns tasks scheduled for tomorrow", async () => {
      // 08:00-12:00 tomorrow, Singapore time. The service formats time ranges in
      // the organisation's timezone, so a fixture built on the runner's clock
      // rendered as "4pm-8pm" on a UTC runner.
      const start = todaySgtAt(8, 1);
      const end = todaySgtAt(12, 1);

      await createTaskAndAssignment({
        title: "Morning prep",
        membershipId: staffMembershipId,
        assignmentStatus: "accepted",
        scheduledStart: start,
        scheduledEnd: end,
      });

      const schedule = await reportingService.getTomorrowsSchedule(orgId);

      expect(schedule).toHaveLength(1);
      expect(schedule[0].title).toBe("Morning prep");
      expect(schedule[0].timeRange).toContain("8am");
      expect(schedule[0].isUnderstaffed).toBe(false);
    });

    it("flags understaffed tasks", async () => {
      const start = todaySgtAt(14, 1);
      const end = todaySgtAt(18, 1);

      await createTaskAndAssignment({
        title: "Big dinner",
        requiredHeadcount: 4,
        scheduledStart: start,
        scheduledEnd: end,
      });

      const schedule = await reportingService.getTomorrowsSchedule(orgId);

      expect(schedule).toHaveLength(1);
      expect(schedule[0].isUnderstaffed).toBe(true);
      expect(schedule[0].assignedCount).toBe(0);
      expect(schedule[0].requiredHeadcount).toBe(4);
    });

    it("returns empty array when nothing is scheduled", async () => {
      const schedule = await reportingService.getTomorrowsSchedule(orgId);
      expect(schedule).toHaveLength(0);
    });
  });

  // ===========================================================
  // Completion Chart
  // ===========================================================

  describe("getCompletionChart", () => {
    it("returns exactly 7 days with zero-fill", async () => {
      const chart = await reportingService.getCompletionChart(orgId);

      expect(chart).toHaveLength(7);
      expect(chart.every((d) => d.count === 0)).toBe(true);
      expect(chart[0]).toHaveProperty("date");
      expect(chart[0]).toHaveProperty("label");
    });

    it("counts completions on correct day", async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      await createTaskAndAssignment({
        title: "Just done",
        membershipId: staffMembershipId,
        assignmentStatus: "completed",
        clockInTime: oneHourAgo,
        clockOutTime: now,
      });

      const chart = await reportingService.getCompletionChart(orgId);

      const today = chart[chart.length - 1];
      expect(today.count).toBe(1);
    });
  });

  // ===========================================================
  // Staff Utilization
  // ===========================================================

  describe("getStaffUtilization", () => {
    it("includes all active staff including those with zero hours", async () => {
      const jamie = await createStaff("Jamie", "jamie@example.com", deptId);
      // Jamie has no assignments — should still appear with 0%

      const utilization = await reportingService.getStaffUtilization(orgId);

      // staffMembershipId + jamie = at least 2 staff
      expect(utilization.length).toBeGreaterThanOrEqual(2);
      const jamieUtil = utilization.find((s) => s.name === "Jamie");
      expect(jamieUtil).toBeDefined();
      expect(jamieUtil!.hoursWorked).toBe(0);
      expect(jamieUtil!.percentage).toBe(0);
    });

    it("computes hours and sorts descending by utilization", async () => {
      const now = new Date();
      const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);

      await createTaskAndAssignment({
        title: "Long shift",
        membershipId: staffMembershipId,
        assignmentStatus: "completed",
        clockInTime: fiveHoursAgo,
        clockOutTime: now,
      });

      const jamie = await createStaff("Jamie", "jamie@example.com", deptId);

      const utilization = await reportingService.getStaffUtilization(orgId);

      // Staff User (with hours) should be first
      expect(utilization[0].name).toBe("Staff User");
      expect(utilization[0].hoursWorked).toBeGreaterThan(4.5);
      expect(utilization[0].percentage).toBeGreaterThan(0);
    });
  });

  // ===========================================================
  // Department Workload
  // ===========================================================

  describe("getDepartmentWorkload", () => {
    it("returns task and staff counts per department", async () => {
      await createTaskAndAssignment({ title: "K1" });
      await createTaskAndAssignment({ title: "K2" });

      const workload = await reportingService.getDepartmentWorkload(orgId);

      const kitchen = workload.find((d) => d.name === "Kitchen");
      expect(kitchen).toBeDefined();
      expect(kitchen!.taskCount).toBe(2);
      expect(kitchen!.staffCount).toBe(1);
      expect(kitchen!.color).toBe("#EF4444");
    });

    it("flags imbalanced departments (tasks but no staff)", async () => {
      const emptyDept = await deptRepo.create({
        name: "Events",
        organizationId: orgId,
      });

      await taskRepo.create({
        title: "Event task",
        organizationId: orgId,
        departmentId: emptyDept.id,
        createdById: userId,
      });

      const workload = await reportingService.getDepartmentWorkload(orgId);

      const events = workload.find((d) => d.name === "Events");
      expect(events).toBeDefined();
      expect(events!.isImbalanced).toBe(true);
    });

    it("does not flag balanced departments", async () => {
      await createTaskAndAssignment({ title: "Normal task" });

      const workload = await reportingService.getDepartmentWorkload(orgId);

      const kitchen = workload.find((d) => d.name === "Kitchen");
      expect(kitchen!.isImbalanced).toBe(false);
    });
  });

  // ===========================================================
  // Rejection Trends
  // ===========================================================

  describe("getRejectionTrends", () => {
    it("groups rejections by staff with reason breakdown", async () => {
      await createTaskAndAssignment({
        title: "R1",
        membershipId: staffMembershipId,
        assignmentStatus: "rejected",
        rejectionReason: "schedule_conflict",
      });
      await createTaskAndAssignment({
        title: "R2",
        membershipId: staffMembershipId,
        assignmentStatus: "rejected",
        rejectionReason: "schedule_conflict",
      });
      await createTaskAndAssignment({
        title: "R3",
        membershipId: staffMembershipId,
        assignmentStatus: "rejected",
        rejectionReason: "feeling_unwell",
      });

      const trends = await reportingService.getRejectionTrends(orgId);

      expect(trends).toHaveLength(1);
      expect(trends[0].staffName).toBe("Staff User");
      expect(trends[0].rejectionCount).toBe(3);
      expect(trends[0].reasons).toHaveLength(2);

      // Sorted by count: schedule_conflict (2) before feeling_unwell (1)
      expect(trends[0].reasons[0].reason).toBe("schedule_conflict");
      expect(trends[0].reasons[0].count).toBe(2);
      expect(trends[0].reasons[1].reason).toBe("feeling_unwell");
      expect(trends[0].reasons[1].count).toBe(1);
    });

    it("sorts staff by rejection count descending", async () => {
      const jamie = await createStaff("Jamie", "jamie@example.com", deptId);

      // Staff User: 1 rejection
      await createTaskAndAssignment({
        title: "R1",
        membershipId: staffMembershipId,
        assignmentStatus: "rejected",
        rejectionReason: "personal_reasons",
      });

      // Jamie: 3 rejections
      await createTaskAndAssignment({
        title: "R2",
        membershipId: jamie,
        assignmentStatus: "rejected",
        rejectionReason: "transport_issues",
      });
      await createTaskAndAssignment({
        title: "R3",
        membershipId: jamie,
        assignmentStatus: "rejected",
        rejectionReason: "transport_issues",
      });
      await createTaskAndAssignment({
        title: "R4",
        membershipId: jamie,
        assignmentStatus: "rejected",
        rejectionReason: "schedule_conflict",
      });

      const trends = await reportingService.getRejectionTrends(orgId);

      expect(trends).toHaveLength(2);
      expect(trends[0].staffName).toBe("Jamie");
      expect(trends[0].rejectionCount).toBe(3);
      expect(trends[1].staffName).toBe("Staff User");
      expect(trends[1].rejectionCount).toBe(1);
    });

    it("returns empty array when no rejections", async () => {
      const trends = await reportingService.getRejectionTrends(orgId);
      expect(trends).toHaveLength(0);
    });
  });

  // ─── Company-admin dashboard summaries (PRD 3.15) ───────────────────────

  describe("getTaskSummary", () => {
    it("counts tasks by task status", async () => {
      await createTaskAndAssignment({ title: "Open 1" });
      await createTaskAndAssignment({ title: "Open 2" });
      await createTaskAndAssignment({ title: "Done", taskStatus: "completed" });
      await createTaskAndAssignment({ title: "Gone", taskStatus: "cancelled" });

      const summary = await reportingService.getTaskSummary(orgId);

      expect(summary.total).toBe(4);
      expect(summary.open).toBe(2);
      expect(summary.completed).toBe(1);
      expect(summary.cancelled).toBe(1);
    });

    it("returns zeros for an org with no tasks", async () => {
      const summary = await reportingService.getTaskSummary(orgId);
      expect(summary.total).toBe(0);
      expect(summary.open).toBe(0);
    });
  });

  describe("getCertificationSummary", () => {
    it("counts certifications by status, expiring soon, and expired", async () => {
      const soon = new Date();
      soon.setDate(soon.getDate() + 10); // within the 30-day window
      const past = new Date();
      past.setDate(past.getDate() - 5); // already lapsed
      const farOff = new Date();
      farOff.setDate(farOff.getDate() + 200);

      await prisma.certification.createMany({
        data: [
          {
            membershipId: staffMembershipId,
            name: "Food Safety",
            issuedDate: new Date(),
            expiryDate: farOff,
            status: "verified",
          },
          {
            membershipId: staffMembershipId,
            name: "First Aid",
            issuedDate: new Date(),
            expiryDate: soon,
            status: "verified",
          },
          {
            membershipId: staffMembershipId,
            name: "Forklift",
            issuedDate: new Date(),
            expiryDate: past,
            status: "verified",
          },
          {
            membershipId: staffMembershipId,
            name: "Pending one",
            issuedDate: new Date(),
            status: "pending",
          },
          {
            membershipId: staffMembershipId,
            name: "Rejected one",
            issuedDate: new Date(),
            status: "rejected",
          },
        ],
      });

      const summary = await reportingService.getCertificationSummary(orgId);

      expect(summary.verified).toBe(3);
      expect(summary.pending).toBe(1);
      expect(summary.rejected).toBe(1);
      expect(summary.total).toBe(5);
      expect(summary.expiringSoon).toBe(1); // only "First Aid"
      expect(summary.expired).toBe(1); // only "Forklift"
    });
  });

  describe("getCoverageSummary", () => {
    it("classifies upcoming tasks as fully staffed, understaffed, or unassigned", async () => {
      const inTwoDays = todaySgtAt(9, 2);
      const end = new Date(inTwoDays.getTime() + 4 * 60 * 60 * 1000);

      const staff2 = await createStaff("Staff Two", "staff2@example.com");

      // Fully staffed: needs 1, has 1
      await createTaskAndAssignment({
        title: "Covered",
        membershipId: staffMembershipId,
        assignmentStatus: "accepted",
        requiredHeadcount: 1,
        scheduledStart: inTwoDays,
        scheduledEnd: end,
      });

      // Understaffed: needs 2, has 1
      await createTaskAndAssignment({
        title: "Short",
        membershipId: staff2,
        assignmentStatus: "accepted",
        requiredHeadcount: 2,
        scheduledStart: inTwoDays,
        scheduledEnd: end,
      });

      // Unassigned: needs 1, has 0
      await createTaskAndAssignment({
        title: "Empty",
        requiredHeadcount: 1,
        scheduledStart: inTwoDays,
        scheduledEnd: end,
      });

      const summary = await reportingService.getCoverageSummary(orgId);

      expect(summary.upcomingTasks).toBe(3);
      expect(summary.fullyStaffed).toBe(1);
      expect(summary.understaffed).toBe(1);
      expect(summary.unassigned).toBe(1);
      // Filled 2 of 4 required slots (1/1 + 1/2 + 0/1)
      expect(summary.coveragePercent).toBe(50);
    });

    it("reports 100% coverage when there are no upcoming tasks", async () => {
      const summary = await reportingService.getCoverageSummary(orgId);
      expect(summary.upcomingTasks).toBe(0);
      expect(summary.coveragePercent).toBe(100);
    });

    it("ignores tasks outside the 7-day window", async () => {
      const farOut = todaySgtAt(9, 30);
      const end = new Date(farOut.getTime() + 4 * 60 * 60 * 1000);

      await createTaskAndAssignment({
        title: "Next month",
        requiredHeadcount: 1,
        scheduledStart: farOut,
        scheduledEnd: end,
      });

      const summary = await reportingService.getCoverageSummary(orgId);
      expect(summary.upcomingTasks).toBe(0);
    });
  });
});