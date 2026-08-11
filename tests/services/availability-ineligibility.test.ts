/**
 * Availability changes that put an assigned shift at risk.
 *
 * The gap this closes was an asymmetry. When a MANAGER rescheduled a task, the
 * system re-checked everyone assigned and warned if someone no longer fitted.
 * When a STAFF MEMBER changed their availability — the same event from the
 * other side — nothing was re-checked and nobody was told. The first anyone
 * knew was a no-show.
 *
 * Three properties are worth guarding here, and each fails silently:
 *
 *   1. it fires at all
 *   2. it only fires for NEWLY ineligible shifts, so correcting a typo does
 *      not re-alert on a problem the manager already has
 *   3. it never fails the staff member's own save
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AvailabilityService } from "@/services/availability.service";
import { EligibilityService } from "@/services/eligibility.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { TaskService } from "@/services/task.service";
import { eventuallyAtLeast, pauseForAbsence } from "../helpers/settle";

const availability = new AvailabilityService();
const tasks = new TaskService();

let tenant: Tenant;
let otherDept: string;

/**
 * A shift 09:00–17:00 Singapore time, `daysAhead` days out.
 *
 * NOT "next Tuesday", which is what this said: today plus seven is whatever
 * weekday today is. Nothing here depends on the weekday — the availability
 * fixtures below cover all seven — so the code was right and only the comment
 * was wrong, which is the harder of the two to notice.
 */
function upcoming(daysAhead = 7) {
  const start = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  start.setUTCHours(1, 0, 0, 0); // 09:00 Singapore
  const end = new Date(start.getTime() + 8 * 60 * 60 * 1000);
  return { start, end };
}

async function shift(opts: { departmentId?: string | null; daysAhead?: number } = {}) {
  const { start, end } = upcoming(opts.daysAhead ?? 7);
  const task = await prisma.task.create({
    data: {
      title: "Evening shift",
      organizationId: tenant.orgId,
      departmentId:
        opts.departmentId === undefined ? tenant.departmentId : opts.departmentId,
      createdById: tenant.admin.userId,
      scheduledStart: start,
      scheduledEnd: end,
      requiredHeadcount: 1,
    },
  });
  await prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: tenant.staff.membershipId,
      assignedById: tenant.admin.userId,
      status: "accepted",
    },
  });
  return { task, start, end };
}

/** Makes the staff member available for every hour of every day. */
async function alwaysAvailable() {
  for (let day = 0; day < 7; day++) {
    await prisma.availability.create({
      data: {
        membershipId: tenant.staff.membershipId,
        dayOfWeek: day,
        startTime: "00:00",
        endTime: "23:59",
        isAvailable: true,
      },
    });
  }
}

function notifications() {
  return prisma.notification.findMany({
    where: { type: "staff_ineligible" },
    include: { user: { select: { id: true } } },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("avail");
  const dept = await prisma.department.create({
    data: { name: "Front of house", organizationId: tenant.orgId, color: "#3B82F6" },
  });
  otherDept = dept.id;
  await alwaysAvailable();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every day marked unavailable — the change that breaks the booking. */
const UNAVAILABLE_WEEK = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  startTime: "09:00",
  endTime: "17:00",
  isAvailable: false,
}));

const AVAILABLE_WEEK = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  startTime: "00:00",
  endTime: "23:59",
  isAvailable: true,
}));

/* ------------------------------------------------------------------ */

describe("the alert fires", () => {
  it("warns when a weekly change strands an upcoming shift", async () => {
    await shift();

    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    const sent = await notifications();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].message).toMatch(/no longer eligible for "Evening shift"/);
  });

  it("names the person, so the manager knows who to talk to", async () => {
    await shift();
    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    const sent = await notifications();
    expect(sent[0].message).toMatch(/updated their availability/);
  });

  it("links the notification to the shift", async () => {
    const { task } = await shift();
    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    const sent = await notifications();
    expect(sent[0].entityId).toBe(task.id);
    expect(sent[0].entityType).toBe("task");
  });

  it("warns on a date override too, not only the weekly pattern", async () => {
    const { start } = await shift();

    await availability.createOverride(tenant.staff.membershipId, {
      date: start.toISOString(),
      isAvailable: false,
      reason: "Dentist",
    });

    expect((await notifications()).length).toBeGreaterThan(0);
  });

  it("raises one alert per stranded shift", async () => {
    await shift({ daysAhead: 7 });
    await shift({ daysAhead: 8 });

    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    // Each carries its own task link, which is what makes it actionable.
    const linked = new Set((await notifications()).map((n) => n.entityId));
    expect(linked.size).toBe(2);
  });
});

/* ------------------------------------------------------------------ */

describe("the alert stays quiet", () => {
  it("says nothing when the change strands nobody", async () => {
    await shift();

    await availability.setWeeklySchedule(tenant.staff.membershipId, AVAILABLE_WEEK);

    expect(await notifications()).toHaveLength(0);
  });

  it("does not re-alert on a second save that changes nothing", async () => {
    // The noise case. Someone corrects a typo in an unrelated day's hours and
    // the manager gets a fresh alert about a problem they already know about.
    // A few of those and managers learn to ignore the notification.
    await shift();

    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);
    const afterFirst = (await notifications()).length;
    expect(afterFirst).toBeGreaterThan(0);

    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    expect(await notifications()).toHaveLength(afterFirst);
  });

  it("ignores shifts that have already started", async () => {
    // Alerting about a shift nobody can now change is noise about the past.
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const task = await prisma.task.create({
      data: {
        title: "Last week",
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
        scheduledStart: past,
        scheduledEnd: new Date(past.getTime() + 8 * 60 * 60 * 1000),
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    expect(await notifications()).toHaveLength(0);
  });

  it("ignores a shift the member already rejected", async () => {
    // Nobody is expecting them, so nothing is at risk.
    const { start, end } = upcoming();
    const task = await prisma.task.create({
      data: {
        title: "Declined shift",
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
        scheduledStart: start,
        scheduledEnd: end,
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "rejected",
        rejectionReason: "schedule_conflict",
      },
    });

    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    expect(await notifications()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("who hears about it", () => {
  it("tells the company admin", async () => {
    await shift();
    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    const recipients = (await notifications()).map((n) => n.userId);
    expect(recipients).toContain(tenant.admin.userId);
  });

  it("tells a manager of the shift's own department", async () => {
    // tenant.manager is assigned to tenant.departmentId by the fixture.
    await shift({ departmentId: tenant.departmentId });
    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    const recipients = (await notifications()).map((n) => n.userId);
    expect(recipients).toContain(tenant.manager.userId);
  });

  it("does not tell a manager who cannot see that department", async () => {
    // The whole point of scoping. The message names a staff member and a task
    // title — the same data a scoped manager is refused from every reporting
    // endpoint. Sending it here would reintroduce that leak by a side door.
    //
    // The staff member is added to the other department as well, because
    // `checkEligibilityForTask` only considers members OF the task's
    // department — without this the member is absent from the result entirely
    // and the test would pass for the wrong reason.
    await prisma.departmentMembership.create({
      data: { membershipId: tenant.staff.membershipId, departmentId: otherDept },
    });
    await shift({ departmentId: otherDept });
    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    const recipients = (await notifications()).map((n) => n.userId);
    expect(recipients).not.toContain(tenant.manager.userId);
    expect(recipients).toContain(tenant.admin.userId);
  });

  it("tells only company admins about a shift with no department", async () => {
    // Nobody's scope contains it, so no scoped manager owns it — the same rule
    // AccessService.isTaskInScope applies.
    await shift({ departmentId: null });
    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    const recipients = (await notifications()).map((n) => n.userId);
    expect(recipients).toEqual([tenant.admin.userId]);
  });
});

/* ------------------------------------------------------------------ */

describe("it never costs the staff member their save", () => {
  it("saves the schedule even when the check throws", async () => {
    await shift();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(
      EligibilityService.prototype,
      "checkEligibilityForTask"
    ).mockRejectedValue(new Error("engine down"));

    await expect(
      availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK)
    ).resolves.toBeDefined();

    const saved = await prisma.availability.findMany({
      where: { membershipId: tenant.staff.membershipId },
    });
    expect(saved.every((a) => a.isAvailable === false)).toBe(true);
    expect(consoleError).toHaveBeenCalled();
  });

  it("stays quiet rather than alerting on everything when the baseline fails", async () => {
    // Without a baseline there is nothing to compare against, and falling back
    // to "alert on all current problems" is exactly the noise this avoids.
    await shift();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const check = vi
      .spyOn(EligibilityService.prototype, "checkEligibilityForTask")
      .mockRejectedValueOnce(new Error("baseline down"));

    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    expect(check).toHaveBeenCalled();
    expect(await notifications()).toHaveLength(0);
  });

  it("does not unassign anyone", async () => {
    // Notify, do not act. The manager may have a replacement to line up, or an
    // eligibility override already recorded, or simply want a conversation.
    const { task } = await shift();

    await availability.setWeeklySchedule(tenant.staff.membershipId, UNAVAILABLE_WEEK);

    const assignment = await prisma.taskAssignment.findFirstOrThrow({
      where: { taskId: task.id },
    });
    expect(assignment.status).toBe("accepted");
  });
});

/**
 * Editing a task twice does not tell the managers twice.
 *
 * `notifyManagersOfIneligibleAssignees` reported everyone currently
 * ineligible, with nothing to compare against — so three tweaks to a task's
 * certification requirements sent three identical notifications naming the same
 * people, and an edit that stranded nobody new still named somebody who had
 * been stranded since last week.
 *
 * The availability path already diffed before against after and its docblock
 * argues that alerting on "everyone currently ineligible" is wrong. Both write
 * the same `staff_ineligible` type against the same task, so the two origins
 * disagreed about what was worth saying.
 */
describe("repeated edits to a task with a stranded assignee", () => {
  async function ineligibleNotifications() {
    return prisma.notification.findMany({ where: { type: "staff_ineligible" } });
  }

  it("names them once, not once per edit", async () => {
    const task = await prisma.task.create({
      data: {
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        title: "Needs a certificate",
        requiredHeadcount: 1,
        status: "open",
        createdById: tenant.admin.userId,
        scheduledStart: new Date(Date.now() + 86_400_000),
        scheduledEnd: new Date(Date.now() + 86_400_000 + 4 * 3_600_000),
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.staff.membershipId,
        status: "accepted",
        assignedById: tenant.admin.userId,
      },
    });

    // Strands them: they hold no certificates at all.
    await tasks.update(
      task.id,
      tenant.orgId,
      { requiredCertifications: ["Food Safety"] }
    );
    const afterFirst = await eventuallyAtLeast(ineligibleNotifications);
    expect(afterFirst.length).toBeGreaterThan(0);
    const countAfterFirst = afterFirst.length;

    // A second edit that changes the requirement again. They were already
    // stranded, so this is not news about them.
    await tasks.update(
      task.id,
      tenant.orgId,
      { requiredCertifications: ["Food Safety", "First Aid"] }
    );
    await pauseForAbsence();

    expect(await ineligibleNotifications()).toHaveLength(countAfterFirst);
  });
});
