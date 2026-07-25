/**
 * Tests for Hour Limit Alert Service (Control Layer)
 *
 * Verifies:
 * - Severity thresholds (ok / approaching at 80% / exceeded at 100%)
 * - Alerts reach BOTH the staff member (US-85) and managers (US-72)
 * - Repeat alerts are suppressed within the cooldown window
 * - The org's `hourLimitWarning` notification preference is honoured
 * - Work-rule limits (max_hours_daily) are picked up, not just the break rule
 */
import { describe, it, expect, beforeEach } from "vitest";
import { HourAlertService } from "@/services/hour-alert.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { NOTIFICATION_TYPES } from "@/services/notification.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const hourAlertService = new HourAlertService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();
const taskRepo = new TaskRepository();

let orgId: string;
let adminUserId: string;
let managerUserId: string;
let staffUserId: string;
let staffMembershipId: string;

beforeEach(async () => {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create({ name: "Acme Corp", slug: "acme-corp" }, admin.id);
  orgId = org.id;

  const manager = await userRepo.create({
    name: "Manager User",
    email: "manager@example.com",
    hashedPassword: "hash",
  });
  managerUserId = manager.id;
  await prisma.membership.create({
    data: {
      userId: manager.id,
      organizationId: org.id,
      role: "manager",
      status: "active",
    },
  });

  const staff = await userRepo.create({
    name: "Staff User",
    email: "staff@example.com",
    hashedPassword: "hash",
  });
  staffUserId = staff.id;
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
    data: { organizationId: org.id, breakRuleHoursWorked: 8 },
  });
});

/**
 * Records `hours` of worked time for the staff member.
 * Clock-in is clamped to today at midnight so the shift never crosses
 * into yesterday — this keeps both the rolling-24h and calendar-day
 * hour checks stable regardless of what time the test suite runs.
 */
async function seedWorkedHours(hours: number) {
  const task = await taskRepo.create({
    title: `Shift (${hours}h)`,
    organizationId: orgId,
    createdById: adminUserId,
  });

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const rawClockIn = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const clockIn = rawClockIn < todayStart ? todayStart : rawClockIn;
  const clockOut = new Date(clockIn.getTime() + hours * 60 * 60 * 1000);

  await prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: staffMembershipId,
      assignedById: adminUserId,
      status: "clocked_out",
      clockInTime: clockIn,
      clockOutTime: clockOut,
    },
  });
}

function hourNotifications(userId: string) {
  return prisma.notification.findMany({
    where: { userId, type: NOTIFICATION_TYPES.HOUR_LIMIT_WARNING },
  });
}

describe("HourAlertService", () => {
  describe("severity thresholds", () => {
    it("is 'ok' when well under the limit", async () => {
      await seedWorkedHours(2); // 2 of 8h = 25%

      const status = await hourAlertService.getMemberStatus(
        staffMembershipId,
        orgId
      );
      expect(status!.severity).toBe("ok");
    });

    it("is 'approaching' at 80% or more of the limit", async () => {
      await seedWorkedHours(7); // 7 of 8h = 87.5%

      const status = await hourAlertService.getMemberStatus(
        staffMembershipId,
        orgId
      );
      expect(status!.severity).toBe("approaching");
    });

    it("is 'exceeded' at or over the limit", async () => {
      await seedWorkedHours(9); // 9 of 8h = 112%

      const status = await hourAlertService.getMemberStatus(
        staffMembershipId,
        orgId
      );
      expect(status!.severity).toBe("exceeded");
    });

    it("picks up a max_hours_daily work rule, not just the break rule", async () => {
      await prisma.workRule.create({
        data: {
          organizationId: orgId,
          name: "Daily cap",
          type: "max_hours_daily",
          maxHours: 4,
          isActive: true,
        },
      });
      await seedWorkedHours(5); // under the 8h break rule, but over the 4h/day rule

      const status = await hourAlertService.getMemberStatus(
        staffMembershipId,
        orgId
      );
      expect(status!.severity).toBe("exceeded");
      expect(status!.limits.some((l) => l.label.includes("Daily cap"))).toBe(true);
    });
  });

  describe("checkAndAlertMember", () => {
    it("notifies both the staff member and the manager", async () => {
      await seedWorkedHours(9);

      await hourAlertService.checkAndAlertMember(staffMembershipId, orgId);

      expect(await hourNotifications(staffUserId)).toHaveLength(1);
      expect(await hourNotifications(managerUserId)).toHaveLength(1);
      // The company admin is a manager-level recipient too.
      expect(await hourNotifications(adminUserId)).toHaveLength(1);
    });

    it("sends nothing when the member is under the limit", async () => {
      await seedWorkedHours(1);

      await hourAlertService.checkAndAlertMember(staffMembershipId, orgId);

      expect(await hourNotifications(staffUserId)).toHaveLength(0);
      expect(await hourNotifications(managerUserId)).toHaveLength(0);
    });

    it("does not re-alert within the cooldown window", async () => {
      await seedWorkedHours(9);

      await hourAlertService.checkAndAlertMember(staffMembershipId, orgId);
      await hourAlertService.checkAndAlertMember(staffMembershipId, orgId);

      expect(await hourNotifications(staffUserId)).toHaveLength(1);
      expect(await hourNotifications(managerUserId)).toHaveLength(1);
    });

    it("honours the org's hourLimitWarning preference being off", async () => {
      await prisma.companySettings.update({
        where: { organizationId: orgId },
        data: {
          notificationPreferences: JSON.stringify({ hourLimitWarning: false }),
        },
      });
      await seedWorkedHours(9);

      await hourAlertService.checkAndAlertMember(staffMembershipId, orgId);

      expect(await hourNotifications(staffUserId)).toHaveLength(0);
      expect(await hourNotifications(managerUserId)).toHaveLength(0);
    });
  });

  describe("checkOrganization", () => {
    it("returns only the at-risk members and alerts them", async () => {
      await seedWorkedHours(9);

      const result = await hourAlertService.checkOrganization(orgId);

      // Manager + staff are both non-admin active members that get checked.
      expect(result.checked).toBeGreaterThanOrEqual(1);
      expect(result.alerted).toHaveLength(1);
      expect(result.alerted[0].membershipId).toBe(staffMembershipId);
      expect(await hourNotifications(staffUserId)).toHaveLength(1);
    });
  });
});
