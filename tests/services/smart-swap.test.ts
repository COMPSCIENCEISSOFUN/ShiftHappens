/**
 * Tests for replacement allocation after manager removal.
 *
 * Verifies that cancelling an assignment recalculates coverage and creates
 * real replacement assignments when eligible staff are available.
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
    data: { organizationId: orgId, allocationMode: "auto" },
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
      data: {
        userId: user.id,
        organizationId: orgId,
        role: "staff",
        status: "active",
        employmentType: "temporary_part_time",
      },
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

describe("Replacement allocation after manager removal", () => {
  it("creates a replacement assignment when task becomes understaffed", async () => {
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
      data: { taskId: task.id, membershipId: staffMembershipIds[0], assignedById: adminUserId, status: "assigned" },
    });
    await prisma.taskAssignment.create({
      data: { taskId: task.id, membershipId: staffMembershipIds[1], assignedById: adminUserId, status: "assigned" },
    });

    // Cancel one: coverage briefly becomes 1/2, then the gap is filled.
    await taskService.cancelAssignment(a1.id, orgId, adminUserId);

    const active = await prisma.taskAssignment.findMany({
      where: { taskId: task.id, status: "assigned" },
    });
    expect(active).toHaveLength(2);
    expect(active.map((assignment) => assignment.membershipId)).toContain(
      staffMembershipIds[2]
    );
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
      data: { taskId: task.id, membershipId: staffMembershipIds[0], assignedById: adminUserId, status: "assigned" },
    });
    await prisma.taskAssignment.create({
      data: { taskId: task.id, membershipId: staffMembershipIds[1], assignedById: adminUserId, status: "assigned" },
    });

    // Cancel one — still has 1/1, not understaffed
    await taskService.cancelAssignment(a1.id, orgId, adminUserId);

    const active = await prisma.taskAssignment.count({
      where: { taskId: task.id, status: "assigned" },
    });
    expect(active).toBe(1);
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
      data: { taskId: task.id, membershipId: staffMembershipIds[0], assignedById: adminUserId, status: "assigned" },
    });

    await taskService.cancelAssignment(a1.id, orgId, adminUserId);

    const notifications = await notificationRepo.findByUserId(adminUserId, orgId);
    const noReplace = notifications.find(
      (n) => n.title === "Replacement needed - no eligible staff"
    );
    expect(noReplace).toBeDefined();
    expect(noReplace!.message).toContain("Sunday Task");
  });

  it("does not block cancellation when no replacement can be allocated", async () => {
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
      data: { taskId: task.id, membershipId: staffMembershipIds[0], assignedById: adminUserId, status: "assigned" },
    });

    // Cancellation remains valid even when coverage cannot be restored.
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
  // suppressing the replacement allocation this file exists to test.
  return atHourSgt(date, hour);
}
