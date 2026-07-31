/**
 * Tests for Smart-Swap (Task Service - cancelAssignment)
 *
 * Verifies that cancelling an assignment triggers replacement
 * suggestions via notification when the task becomes understaffed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskService } from "@/services/task.service";
import { NotificationRepository } from "@/repositories/notification.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import bcrypt from "bcryptjs";
import { atHourSgt, nextMondaySgt, nextSundaySgt } from "../helpers/time";

const taskService = new TaskService();
const notificationRepo = new NotificationRepository();

let orgId: string;
let adminUserId: string;
let staffUserIds: string[];
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
    data: { organizationId: orgId, taskAcceptanceMode: "require_acceptance" },
  });

  const dept = await prisma.department.create({
    data: { name: "Kitchen", organizationId: orgId, color: "#EF4444" },
  });
  deptId = dept.id;

  staffUserIds = [];
  staffMembershipIds = [];
  const staffData = [
    { name: "Alex", email: "alex@test.com" },
    { name: "Jamie", email: "jamie@test.com" },
    { name: "Taylor", email: "taylor@test.com" },
  ];

  for (const s of staffData) {
    const user = await prisma.user.create({
      data: { name: s.name, email: s.email, hashedPassword, emailVerified: new Date() },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId: orgId, role: "staff", status: "active" },
    });
    staffUserIds.push(user.id);
    staffMembershipIds.push(membership.id);

    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: deptId },
    });

    for (let d = 1; d <= 5; d++) {
      await prisma.availability.create({
        data: { membershipId: membership.id, dayOfWeek: d, startTime: "06:00", endTime: "18:00", isAvailable: true },
      });
    }
  }
});

describe("Smart-Swap", () => {
  it("sends replacement notification when task becomes understaffed", async () => {
    const nextMon = getNextMonday();
    const task = await prisma.task.create({
      data: {
        title: "Kitchen Prep",
        organizationId: orgId,
        departmentId: deptId,
        priority: "high",
        requiredHeadcount: 2,
        scheduledStart: setHour(nextMon, 8),
        scheduledEnd: setHour(nextMon, 12),
        createdById: adminUserId,
      },
    });

    // Assign 2 staff
    const a1 = await prisma.taskAssignment.create({
      data: { taskId: task.id, membershipId: staffMembershipIds[0], assignedById: adminUserId, status: "accepted" },
    });
    await prisma.taskAssignment.create({
      data: { taskId: task.id, membershipId: staffMembershipIds[1], assignedById: adminUserId, status: "accepted" },
    });

    // Cancel one — task becomes understaffed (1/2)
    await taskService.cancelAssignment(a1.id, orgId, adminUserId);

    // Wait for fire-and-forget notification
    await new Promise((r) => setTimeout(r, 500));

    const notifications = await notificationRepo.findByUserId(adminUserId, orgId);
    expect(notifications.length).toBeGreaterThanOrEqual(1);

    const swapNotif = notifications.find((n) => n.title === "Smart swap — replacement suggested");
    expect(swapNotif).toBeDefined();
    expect(swapNotif!.message).toContain("Kitchen Prep");
    expect(swapNotif!.message).toContain("needs 1 more");
  });

  it("does not send notification when task is still fully staffed", async () => {
    const nextMon = getNextMonday();
    const task = await prisma.task.create({
      data: {
        title: "Small Task",
        organizationId: orgId,
        departmentId: deptId,
        priority: "medium",
        requiredHeadcount: 1,
        scheduledStart: setHour(nextMon, 9),
        scheduledEnd: setHour(nextMon, 11),
        createdById: adminUserId,
      },
    });

    // Assign 2 staff to a task needing 1 (over-staffed scenario via direct DB)
    const a1 = await prisma.taskAssignment.create({
      data: { taskId: task.id, membershipId: staffMembershipIds[0], assignedById: adminUserId, status: "accepted" },
    });
    await prisma.taskAssignment.create({
      data: { taskId: task.id, membershipId: staffMembershipIds[1], assignedById: adminUserId, status: "accepted" },
    });

    // Cancel one — still has 1/1, not understaffed
    await taskService.cancelAssignment(a1.id, orgId, adminUserId);

    await new Promise((r) => setTimeout(r, 500));

    const notifications = await notificationRepo.findByUserId(adminUserId, orgId);
    const swapNotif = notifications.find((n) => n.title === "Smart swap — replacement suggested");
    expect(swapNotif).toBeUndefined();
  });

  it("sends no-replacements notification when no eligible staff", async () => {
    // Task on Sunday — no staff have Sunday availability
    const nextSun = getNextSunday();
    const task = await prisma.task.create({
      data: {
        title: "Sunday Task",
        organizationId: orgId,
        departmentId: deptId,
        priority: "high",
        requiredHeadcount: 1,
        scheduledStart: setHour(nextSun, 10),
        scheduledEnd: setHour(nextSun, 14),
        createdById: adminUserId,
      },
    });

    const a1 = await prisma.taskAssignment.create({
      data: { taskId: task.id, membershipId: staffMembershipIds[0], assignedById: adminUserId, status: "pending" },
    });

    await taskService.cancelAssignment(a1.id, orgId, adminUserId);

    await new Promise((r) => setTimeout(r, 500));

    const notifications = await notificationRepo.findByUserId(adminUserId, orgId);
    const noReplace = notifications.find((n) => n.title === "Staff unassigned — no replacements");
    expect(noReplace).toBeDefined();
    expect(noReplace!.message).toContain("Sunday Task");
  });

  it("does not block cancellation if smart-swap fails", async () => {
    const nextMon = getNextMonday();
    const task = await prisma.task.create({
      data: {
        title: "Safe Cancel",
        organizationId: orgId,
        departmentId: deptId,
        priority: "medium",
        requiredHeadcount: 2,
        scheduledStart: setHour(nextMon, 9),
        scheduledEnd: setHour(nextMon, 12),
        createdById: adminUserId,
      },
    });

    const a1 = await prisma.taskAssignment.create({
      data: { taskId: task.id, membershipId: staffMembershipIds[0], assignedById: adminUserId, status: "accepted" },
    });

    // Cancellation should always succeed regardless of smart-swap
    const result = await taskService.cancelAssignment(a1.id, orgId, adminUserId);
    expect(result).toBeDefined();
  });
});

// Weekday and midnight both have to be resolved in the organisation's
// timezone: near midnight the runner's weekday can be a different day, which
// would place these fixtures on the wrong side of an availability window.
function getNextMonday(): Date {
  return nextMondaySgt();
}

function getNextSunday(): Date {
  return nextSundaySgt();
}

function setHour(date: Date, hour: number): Date {
  // Singapore hour. setHours() would set the runner's hour, so on a UTC
  // runner a "09:00 shift" became 17:00 SGT and fell outside the staff
  // member's availability window — making every candidate ineligible and
  // suppressing the smart-swap suggestion this file exists to test.
  return atHourSgt(date, hour);
}