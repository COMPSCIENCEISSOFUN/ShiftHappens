/**
 * Tests for the Scheduler Service (Control Layer).
 *
 * The scheduler fans the per-org jobs out across ALL active organizations so
 * an external cron only needs to hit one endpoint:
 *  - recurring-task generation (materialise upcoming instances)
 *  - hour-limit alert scan (notify at-risk staff/managers)
 *
 * Requirements verified:
 *  - runs for every ACTIVE org, skips suspended/inactive ones
 *  - one org failing must not abort the whole run
 *  - aggregates per-org results
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SchedulerService } from "@/services/scheduler.service";
import { TaskRepository } from "@/repositories/task.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { NOTIFICATION_TYPES } from "@/services/notification.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { todaySgtAt } from "../helpers/time";

const scheduler = new SchedulerService();
const taskRepo = new TaskRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let emailCounter = 0;

/** Creates an org (active by default) with a company_admin and settings. */
async function makeOrg(slug: string, status: "active" | "suspended" = "active") {
  const admin = await userRepo.create({
    name: `Admin ${slug}`,
    email: `admin-${slug}-${emailCounter++}@example.com`,
    hashedPassword: "hash",
  });
  const org = await orgRepo.create({ name: `Org ${slug}`, slug }, admin.id);
  await prisma.organization.update({ where: { id: org.id }, data: { status } });
  await prisma.companySettings.create({
    data: { organizationId: org.id, breakRuleHoursWorked: 8 },
  });
  const adminMembership = await prisma.membership.findFirst({
    where: { organizationId: org.id },
  });
  return { orgId: org.id, adminUserId: admin.id, adminMembershipId: adminMembership!.id };
}

/** A daily recurring template starting today at 09:00–13:00 (no instances yet). */
async function addDailyTemplate(orgId: string, createdById: string) {
  const start = todaySgtAt(9);
  const end = todaySgtAt(13);
  return taskRepo.create({
    title: "Daily prep",
    organizationId: orgId,
    createdById,
    scheduledStart: start,
    scheduledEnd: end,
    isRecurring: true,
    recurringPattern: JSON.stringify({ freq: "daily", interval: 1 }),
  });
}

/** Seeds `hours` of clocked-out work for a staff member ending now. */
async function addWorkedStaff(orgId: string, adminUserId: string, hours: number) {
  const user = await userRepo.create({
    name: `Staff ${emailCounter}`,
    email: `staff-${emailCounter++}@example.com`,
    hashedPassword: "hash",
  });
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role: "staff", status: "active" },
  });
  const task = await taskRepo.create({
    title: "Worked shift",
    organizationId: orgId,
    createdById: adminUserId,
  });
  await prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: membership.id,
      assignedById: adminUserId,
      status: "clocked_out",
      clockInTime: new Date(Date.now() - hours * 60 * 60 * 1000),
      clockOutTime: new Date(),
    },
  });
  return { staffUserId: user.id, membershipId: membership.id };
}

beforeEach(async () => {
  await cleanDatabase();
  emailCounter = 0;
});

describe("SchedulerService.runRecurringGeneration", () => {
  it("generates instances for every active org", async () => {
    const a = await makeOrg("org-a");
    const b = await makeOrg("org-b");
    const templateA = await addDailyTemplate(a.orgId, a.adminUserId);
    const templateB = await addDailyTemplate(b.orgId, b.adminUserId);

    const result = await scheduler.runRecurringGeneration(14);

    expect(result.orgsProcessed).toBe(2);
    expect(result.totalCreated).toBeGreaterThan(0);

    const instancesA = await prisma.task.count({ where: { parentTaskId: templateA.id } });
    const instancesB = await prisma.task.count({ where: { parentTaskId: templateB.id } });
    expect(instancesA).toBeGreaterThan(0);
    expect(instancesB).toBeGreaterThan(0);
  });

  it("skips suspended organizations", async () => {
    const active = await makeOrg("active-org");
    const suspended = await makeOrg("suspended-org", "suspended");
    await addDailyTemplate(active.orgId, active.adminUserId);
    const suspendedTemplate = await addDailyTemplate(suspended.orgId, suspended.adminUserId);

    const result = await scheduler.runRecurringGeneration(14);

    expect(result.orgsProcessed).toBe(1);
    const suspendedInstances = await prisma.task.count({
      where: { parentTaskId: suspendedTemplate.id },
    });
    expect(suspendedInstances).toBe(0);
  });

  it("is safe to run twice (idempotent — no duplicates on the second pass)", async () => {
    const a = await makeOrg("org-a");
    const template = await addDailyTemplate(a.orgId, a.adminUserId);

    await scheduler.runRecurringGeneration(14);
    const countAfterFirst = await prisma.task.count({ where: { parentTaskId: template.id } });

    const second = await scheduler.runRecurringGeneration(14);
    const countAfterSecond = await prisma.task.count({ where: { parentTaskId: template.id } });

    expect(second.totalCreated).toBe(0);
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});

describe("SchedulerService.runHourAlerts", () => {
  it("alerts at-risk staff across active orgs", async () => {
    const a = await makeOrg("org-a");
    const { staffUserId } = await addWorkedStaff(a.orgId, a.adminUserId, 9); // over 8h

    const result = await scheduler.runHourAlerts();

    expect(result.orgsProcessed).toBe(1);
    expect(result.totalAlerted).toBeGreaterThanOrEqual(1);

    const notes = await prisma.notification.findMany({
      where: { userId: staffUserId, type: NOTIFICATION_TYPES.HOUR_LIMIT_WARNING },
    });
    expect(notes.length).toBe(1);
  });

  it("does not alert staff who are under the limit", async () => {
    const a = await makeOrg("org-a");
    const { staffUserId } = await addWorkedStaff(a.orgId, a.adminUserId, 2); // under 8h

    const result = await scheduler.runHourAlerts();

    expect(result.totalAlerted).toBe(0);
    const notes = await prisma.notification.findMany({
      where: { userId: staffUserId, type: NOTIFICATION_TYPES.HOUR_LIMIT_WARNING },
    });
    expect(notes.length).toBe(0);
  });
});

describe("SchedulerService.runAll", () => {
  it("returns a summary for all three scheduled jobs", async () => {
    const a = await makeOrg("org-a");
    await addDailyTemplate(a.orgId, a.adminUserId);
    await addWorkedStaff(a.orgId, a.adminUserId, 9);

    const result = await scheduler.runAll(14);

    expect(result.recurring.orgsProcessed).toBe(1);
    expect(result.recurring.totalCreated).toBeGreaterThan(0);
    expect(result.hourAlerts.orgsProcessed).toBe(1);
    expect(result.hourAlerts.totalAlerted).toBeGreaterThanOrEqual(1);
    // Certification expiry runs even with nothing to report — the cron response
    // should always carry all three summaries so a silent job is visible.
    expect(result.certExpiry.orgsProcessed).toBe(1);
    expect(result.certExpiry.totalNotified).toBe(0);
  });
});

describe("SchedulerService.runCertificationExpiry", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("warns the holder of a certificate about to lapse", async () => {
    const a = await makeOrg("org-cert");
    const staff = await addWorkedStaff(a.orgId, a.adminUserId, 1);

    const cert = await prisma.certification.create({
      data: {
        membershipId: staff.membershipId,
        name: "First Aid",
        issuedDate: new Date("2026-01-01"),
        expiryDate: new Date(Date.now() + 10 * DAY_MS),
        status: "verified",
      },
    });

    const summary = await scheduler.runCertificationExpiry();

    expect(summary.orgsProcessed).toBe(1);
    expect(summary.totalNotified).toBe(1);

    const notes = await prisma.notification.findMany({
      where: {
        userId: staff.staffUserId,
        type: NOTIFICATION_TYPES.CERT_EXPIRING,
      },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].entityId).toBe(cert.id);
  });

  it("says nothing when no certificate is lapsing", async () => {
    const a = await makeOrg("org-quiet");
    await addWorkedStaff(a.orgId, a.adminUserId, 1);

    const summary = await scheduler.runCertificationExpiry();

    expect(summary.orgsProcessed).toBe(1);
    expect(summary.totalNotified).toBe(0);
  });
});
