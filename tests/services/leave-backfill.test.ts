/**
 * What approving leave does to the shifts the person was already on.
 *
 * Until now: nothing. `reviewLeave` sent a notification saying the member was
 * no longer eligible and left them assigned, so the roster went on claiming the
 * shift was covered. The only thing between that and a no-show was a manager
 * reading a notification.
 *
 * Now approval RELEASES the shift and then looks for cover, following the
 * allocation mode the organisation already set. The two assertions that matter
 * most are that the release actually happens, and that an automatic replacement
 * is an OFFER — a full-timer's all-week availability was opened by default
 * rather than chosen by them, so it is too weak a fact to book someone on.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { AvailabilityService } from "@/services/availability.service";
import { overrideDateKey } from "@/repositories/availability.repository";
import { dayOfWeekInTimeZone } from "@/lib/timezone";
import { NOTIFICATION_TYPES } from "@/services/notification.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new AvailabilityService();

let tenant: Tenant;
let absentee: string;
let cover: string;

/** A point `days` from now, at 10:00 UTC so it never lands on a boundary. */
function daysAway(days: number): Date {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(10, 0, 0, 0);
  return d;
}

async function openEveryDay(membershipId: string) {
  await service.openUnsetDays(membershipId);
}

async function shiftOn(start: Date, headcount = 1) {
  const end = new Date(start.getTime() + 4 * 3_600_000);
  return prisma.task.create({
    data: {
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      title: "Dinner Service",
      status: "open",
      priority: "medium",
      requiredHeadcount: headcount,
      scheduledStart: start,
      scheduledEnd: end,
    },
  });
}

async function book(taskId: string, membershipId: string) {
  return prisma.taskAssignment.create({
    data: {
      taskId,
      membershipId,
      assignedById: tenant.admin.userId,
      status: "accepted",
    },
  });
}

async function setMode(allocationMode: string) {
  await prisma.companySettings.upsert({
    where: { organizationId: tenant.orgId },
    update: { allocationMode },
    create: { organizationId: tenant.orgId, allocationMode },
  });
}

/** Files leave for the day the shift falls on, and approves it. */
async function approveLeaveFor(membershipId: string, shiftStart: Date) {
  const created = await service.createOverride(membershipId, {
    date: overrideDateKey(shiftStart).toISOString(),
    isAvailable: false,
    reason: "Medical appointment",
  });
  return service.reviewLeave(created.id, "approved", tenant.manager.userId, tenant.orgId);
}

function notificationsOfType(type: string) {
  return prisma.notification.findMany({ where: { type } });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("backfill");

  const make = async (name: string, email: string) => {
    const user = await prisma.user.create({
      data: { name, email, hashedPassword: "h" },
    });
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: tenant.orgId,
        role: "staff",
        status: "active",
        employmentType: "full_time",
      },
    });
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: tenant.departmentId },
    });
    await openEveryDay(membership.id);
    return membership.id;
  };

  absentee = await make("Sam Absent", "sam@backfill.test");
  cover = await make("Jamie Cover", "jamie@backfill.test");
});

describe("releasing the shift", () => {
  it("takes the member off a shift they can no longer work", async () => {
    const start = daysAway(10);
    const task = await shiftOn(start);
    const assignment = await book(task.id, absentee);

    await approveLeaveFor(absentee, start);

    // `cancel` DELETES the row rather than storing a status — the same choice
    // the withdrawal path makes, and what lets somebody be re-assigned later
    // without tripping the (taskId, membershipId) unique constraint.
    const after = await prisma.taskAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(after).toBeNull();
  });

  it("leaves shifts on other days alone", async () => {
    const leaveDay = daysAway(10);
    const otherDay = daysAway(12);
    const other = await shiftOn(otherDay);
    const untouched = await book(other.id, absentee);

    await approveLeaveFor(absentee, leaveDay);

    const after = await prisma.taskAssignment.findUniqueOrThrow({
      where: { id: untouched.id },
    });
    expect(after.status).toBe("accepted");
  });

  /*
   * Rejection is not a quieter approval. A refused request must leave the
   * roster exactly as it was, or a manager saying no would still cost the shift
   * its cover.
   */
  it("changes nothing when the request is rejected", async () => {
    const start = daysAway(10);
    const task = await shiftOn(start);
    const assignment = await book(task.id, absentee);

    const created = await service.createOverride(absentee, {
      date: overrideDateKey(start).toISOString(),
      isAvailable: false,
      reason: "Medical appointment",
    });
    await service.reviewLeave(created.id, "rejected", tenant.manager.userId, tenant.orgId);

    const after = await prisma.taskAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(after.status).toBe("accepted");
  });
});

describe("finding cover", () => {
  it("manual mode leaves the gap and says so", async () => {
    await setMode("manual");
    const start = daysAway(10);
    const task = await shiftOn(start);
    await book(task.id, absentee);

    await approveLeaveFor(absentee, start);

    await vi.waitFor(async () => {
      const alerts = await notificationsOfType(NOTIFICATION_TYPES.BACKFILL_NEEDED);
      expect(alerts.length).toBeGreaterThan(0);
    });
    // Nobody was put on the shift.
    const assignments = await prisma.taskAssignment.findMany({
      where: { taskId: task.id },
    });
    expect(assignments).toHaveLength(0);
  });

  it("suggested mode names a replacement without booking them", async () => {
    await setMode("suggested");
    const start = daysAway(10);
    const task = await shiftOn(start);
    await book(task.id, absentee);

    await approveLeaveFor(absentee, start);

    await vi.waitFor(async () => {
      const alerts = await notificationsOfType(NOTIFICATION_TYPES.BACKFILL_NEEDED);
      expect(alerts.some((a) => a.message.includes("Jamie Cover"))).toBe(true);
    });
    const assignments = await prisma.taskAssignment.findMany({
      where: { taskId: task.id },
    });
    expect(assignments).toHaveLength(0);
  });

  it("auto mode puts the replacement on the shift", async () => {
    await setMode("auto");
    const start = daysAway(10);
    const task = await shiftOn(start);
    await book(task.id, absentee);

    await approveLeaveFor(absentee, start);

    const assignments = await prisma.taskAssignment.findMany({
      where: { taskId: task.id },
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].membershipId).toBe(cover);
  });

  /*
   * THE assertion of this feature. `taskAcceptanceMode` defaults to
   * auto_accept, so without the override Jamie would wake up committed to a
   * shift nobody asked them about — on the strength of an availability we
   * opened for them by default.
   */
  it("auto mode offers rather than books, even under auto-accept", async () => {
    await setMode("auto");
    await prisma.companySettings.update({
      where: { organizationId: tenant.orgId },
      data: { taskAcceptanceMode: "auto_accept" },
    });
    const start = daysAway(10);
    const task = await shiftOn(start);
    await book(task.id, absentee);

    await approveLeaveFor(absentee, start);

    const offer = await prisma.taskAssignment.findFirstOrThrow({
      where: { taskId: task.id, membershipId: cover },
    });
    expect(offer.status).toBe("pending");
  });

  it("tells the replacement they have been asked", async () => {
    await setMode("auto");
    const start = daysAway(10);
    const task = await shiftOn(start);
    await book(task.id, absentee);

    await approveLeaveFor(absentee, start);

    await vi.waitFor(async () => {
      const offered = await notificationsOfType(NOTIFICATION_TYPES.BACKFILL_OFFERED);
      expect(offered.length).toBeGreaterThan(0);
    });
  });

  it("says nobody is available when nobody is", async () => {
    await setMode("suggested");
    // Jamie is the only other candidate; take them out of the running.
    await prisma.membership.update({
      where: { id: cover },
      data: { status: "inactive" },
    });
    const start = daysAway(10);
    const task = await shiftOn(start);
    await book(task.id, absentee);

    await approveLeaveFor(absentee, start);

    await vi.waitFor(async () => {
      const alerts = await notificationsOfType(NOTIFICATION_TYPES.BACKFILL_NEEDED);
      expect(alerts.some((a) => a.title.includes("nobody available"))).toBe(true);
    });
  });
});

describe("short notice", () => {
  /*
   * Inside the window, filling the gap is a phone call. Sending an offer that
   * may sit unread until after the shift has started would look like the system
   * had handled it.
   */
  it("skips the automation entirely for an imminent shift", async () => {
    await setMode("auto");
    const start = daysAway(1);
    const task = await shiftOn(start);
    await book(task.id, absentee);

    await approveLeaveFor(absentee, start);

    await vi.waitFor(async () => {
      const alerts = await notificationsOfType(NOTIFICATION_TYPES.BACKFILL_NEEDED);
      expect(alerts.some((a) => a.title.includes("Urgent"))).toBe(true);
    });
    const assignments = await prisma.taskAssignment.findMany({
      where: { taskId: task.id },
    });
    expect(assignments).toHaveLength(0);
  });

  it("still releases the member from it", async () => {
    await setMode("auto");
    const start = daysAway(1);
    const task = await shiftOn(start);
    const assignment = await book(task.id, absentee);

    await approveLeaveFor(absentee, start);

    const after = await prisma.taskAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(after).toBeNull();
  });

  it("automates a shift outside the window", async () => {
    await setMode("auto");
    const start = daysAway(5);
    const task = await shiftOn(start);
    await book(task.id, absentee);

    await approveLeaveFor(absentee, start);

    const assignments = await prisma.taskAssignment.findMany({
      where: { taskId: task.id },
    });
    expect(assignments).toHaveLength(1);
  });
});

describe("the decision survives its own consequences", () => {
  /*
   * A manager has decided and the member has been told. If the roster tidy-up
   * throws, the approval must still stand — an approval that fails after
   * writing leaves the request looking unanswered when it is not.
   */
  it("still approves when finding cover fails", async () => {
    await setMode("auto");
    const start = daysAway(10);
    const task = await shiftOn(start);
    await book(task.id, absentee);

    const created = await service.createOverride(absentee, {
      date: overrideDateKey(start).toISOString(),
      isAvailable: false,
      reason: "Medical appointment",
    });

    const allocation = await import("@/services/allocation.service");
    const spy = vi
      .spyOn(allocation.AllocationService.prototype, "rankWithoutAI")
      .mockRejectedValue(new Error("ranker exploded"));

    await expect(
      service.reviewLeave(created.id, "approved", tenant.manager.userId, tenant.orgId)
    ).resolves.toBeTruthy();

    const override = await prisma.availabilityOverride.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(override.status).toBe("approved");
    spy.mockRestore();
  });
});

describe("the weekday the shift falls on", () => {
  // Guards the fixture rather than the feature: every member is opened for all
  // seven days, so a test failing for want of an availability row would be
  // reporting the wrong thing.
  it("is one the members are available for", async () => {
    const start = daysAway(10);
    const week = await service.getWeeklySchedule(cover);
    const row = week.find((d) => d.dayOfWeek === dayOfWeekInTimeZone(start));
    expect(row?.isAvailable).toBe(true);
  });
});

/*
 * The bug this feature was built on top of without noticing.
 *
 * `EligibilityService` skipped the availability check entirely for full-time
 * members — "always available during operating hours" — so an approved leave
 * request made somebody unavailable at the repository and left them fully
 * eligible at the engine. The assign screen went on offering them and the
 * auto-scheduler went on rostering them.
 *
 * Every test of the leave feature passed throughout, because every one of them
 * asserted against `isAvailableAt` rather than against eligibility. These
 * assert at the level the rest of the product actually reads.
 */
describe("approved leave reaches the eligibility engine", () => {
  async function eligibilityFor(start: Date) {
    const task = await shiftOn(start);
    const { EligibilityService } = await import("@/services/eligibility.service");
    const rows = await new EligibilityService().checkEligibilityForTask(
      task.id,
      tenant.orgId
    );
    return rows.find((r) => r.membershipId === absentee);
  }

  it("makes a full-time member ineligible", async () => {
    const start = daysAway(10);
    const created = await service.createOverride(absentee, {
      date: overrideDateKey(start).toISOString(),
      isAvailable: false,
      reason: "Medical appointment",
    });
    await service.reviewLeave(created.id, "approved", tenant.manager.userId, tenant.orgId);

    expect((await eligibilityFor(start))?.eligible).toBe(false);
  });

  // The half that must NOT change: an unanswered request leaves them rosterable.
  it("leaves them eligible while the request is only pending", async () => {
    const start = daysAway(10);
    await service.createOverride(absentee, {
      date: overrideDateKey(start).toISOString(),
      isAvailable: false,
      reason: "Medical appointment",
    });

    expect((await eligibilityFor(start))?.eligible).toBe(true);
  });

  it("honours a day an admin has explicitly closed", async () => {
    const start = daysAway(10);
    await prisma.availability.update({
      where: {
        membershipId_dayOfWeek: {
          membershipId: absentee,
          dayOfWeek: dayOfWeekInTimeZone(start),
        },
      },
      data: { isAvailable: false },
    });

    expect((await eligibilityFor(start))?.eligible).toBe(false);
  });

  /*
   * Backwards compatibility, and a rule in its own right: a contracted member
   * with nothing written down is open. Anyone created before `openUnsetDays`
   * existed — seeded, imported, or already in a live database — would otherwise
   * become ineligible for everything with no visible cause.
   */
  it("keeps a full-timer with no pattern at all eligible", async () => {
    const start = daysAway(10);
    await prisma.availability.deleteMany({ where: { membershipId: absentee } });

    expect((await eligibilityFor(start))?.eligible).toBe(true);
  });

  it("but a casual with no pattern is not", async () => {
    const start = daysAway(10);
    await prisma.availability.deleteMany({ where: { membershipId: absentee } });
    await prisma.membership.update({
      where: { id: absentee },
      data: { employmentType: "casual" },
    });

    expect((await eligibilityFor(start))?.eligible).toBe(false);
  });
});
