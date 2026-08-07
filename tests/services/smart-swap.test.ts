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
import { eventuallyMatching, pauseForAbsence } from "../helpers/settle";

const taskService = new TaskService();
const notificationRepo = new NotificationRepository();

/**
 * Notification titles as one string.
 *
 * A string, not an array: Vitest abbreviates a failed array match to
 * `[ Array(1) ]`, which hides the one thing worth seeing.
 */
function titlesOf(notifications: { title: string }[]): string {
  return notifications.length ? notifications.map((n) => n.title).join(" | ") : "(none)";
}

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

    /*
     * Polled, not slept. `suggestReplacement` is fired with `void` so there is
     * nothing to await, and the fixed 500ms this used to wait was a guess about
     * the machine: 83ms of work on the CI sandbox, and a failure on a Windows
     * laptop straight after a build.
     */
    const notifications = await eventuallyMatching(
      () => notificationRepo.findByUserId(adminUserId, orgId),
      (n) => n.title === "Smart swap — replacement suggested"
    );

    // Asserted against the titles JOINED INTO A STRING, so the failure names
    // what did arrive. `expect(found).toBeDefined()` could only ever report
    // `undefined`, and asserting on the array prints `[ Array(1) ]` — Vitest
    // truncates it, which loses exactly the information this is here for.
    expect(titlesOf(notifications)).toContain("Smart swap — replacement suggested");

    const swapNotif = notifications.find((n) => n.title === "Smart swap — replacement suggested");
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

    // Absence cannot be polled for — see the caveat in helpers/settle.
    await pauseForAbsence(500);

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

    const notifications = await eventuallyMatching(
      () => notificationRepo.findByUserId(adminUserId, orgId),
      (n) => n.title === "Staff unassigned — no replacements"
    );

    /*
     * The assertion that failed on Darryn's machine was `expect(noReplace)
     * .toBeDefined()`, which reports `undefined` and nothing else. Two very
     * different faults produce it: the notification had not landed yet, or a
     * replacement WAS found and "Smart swap — replacement suggested" arrived
     * instead — which would mean somebody was eligible on a Sunday nobody has
     * availability for. Naming the titles distinguishes them in the failure
     * message rather than in a debugging session.
     */
    expect(titlesOf(notifications)).toContain("Staff unassigned — no replacements");

    const noReplace = notifications.find((n) => n.title === "Staff unassigned — no replacements");
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