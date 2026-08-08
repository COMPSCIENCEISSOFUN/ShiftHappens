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
import { hourInTimeZone } from "@/lib/timezone";

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
    data: { organizationId: org.id, workingDayHours: 8 },
  });
});

/**
 * Records `hours` of worked time for the staff member, ENDING NOW.
 *
 * ## Why not clamped to midnight
 *
 * This used to clamp clock-in to the organisation's midnight so a shift "never
 * crossed into yesterday", keeping the clock-in inside the calendar day. It
 * clamped the START while keeping the DURATION, which pushed the END into the
 * future: run at 01:00 with `hours` of 7, it produced a shift from 00:00 to
 * 07:00 — six of those hours had not happened yet.
 *
 * That passed only because the rolling 24-hour sum used to add an interval's
 * whole duration once its start fell inside the window. Now that hour totals
 * count the OVERLAP with the window, work in the future correctly contributes
 * nothing, and the fixture was left describing hours nobody had worked. The
 * suite went red at 01:15 in the morning and would have been green again by
 * breakfast, which is the worst kind of test failure.
 *
 * A shift ending now and starting `hours` ago is both what the tests mean and
 * what actually happens on a roster.
 */
async function seedWorkedHours(hours: number) {
  const task = await taskRepo.create({
    title: `Shift (${hours}h)`,
    organizationId: orgId,
    createdById: adminUserId,
  });

  const clockOut = new Date();
  const clockIn = new Date(clockOut.getTime() - hours * 60 * 60 * 1000);

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

  return { clockIn, clockOut };
}

/**
 * Moves the organisation's day boundary to the hour a shift began.
 *
 * `operatingHoursStart` doubles as the business-day boundary, so a daily cap is
 * judged over `[boundary, boundary + 24h)`. Pinning it to the shift's own start
 * hour guarantees the whole shift lands in one business day, whatever time of
 * day the suite happens to run — the alternative is a test that passes in the
 * afternoon and fails at breakfast.
 */
async function alignBusinessDayToShiftStart(clockIn: Date) {
  await prisma.companySettings.update({
    where: { organizationId: orgId },
    data: { operatingHoursStart: hourInTimeZone(clockIn) },
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
      const { clockIn } = await seedWorkedHours(5); // under the 8h break rule, over the 4h/day rule
      // A daily cap is judged against the BUSINESS day, which begins at the
      // organisation's operating-hours start. Aligning the boundary to the
      // moment the shift began puts all five hours in one day no matter what
      // time of day the suite runs — otherwise a run just after 06:00 would
      // split the shift across two days and see only part of it.
      await alignBusinessDayToShiftStart(clockIn);

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
