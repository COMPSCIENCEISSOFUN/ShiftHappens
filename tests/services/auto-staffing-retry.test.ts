/**
 * The second attempt.
 *
 * ## The gap
 *
 * Auto allocation ran once — when a task was created or generated — and never
 * again. A shift a fortnight out that nobody was eligible for at that moment,
 * because availability had not been entered yet or a certificate had not been
 * verified, stayed empty until a human noticed. The organisation had asked the
 * system to do its rostering and the system tried once and gave up
 * permanently.
 *
 * ## What is pinned
 *
 * That the sweep fills what it can and only in `auto` mode; that it stops 48
 * hours out, because in `auto_accept` this ASSIGNS rather than offers and
 * putting somebody on tomorrow's rota by background job is a surprise the
 * product should not spring; that it counts occupancy with the shared rule
 * rather than by counting rows; and that it says NOTHING, which is the design
 * decision here most likely to be argued with.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AllocationService } from "@/services/allocation.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { todaySgtAt } from "../helpers/time";
import { pauseForAbsence } from "../helpers/settle";

const allocation = new AllocationService();

let tenant: Tenant;

async function makeAvailable(membershipId: string) {
  for (let day = 0; day < 7; day++) {
    await prisma.availability.create({
      data: {
        membershipId,
        dayOfWeek: day,
        startTime: "06:00",
        endTime: "18:00",
        isAvailable: true,
      },
    });
  }
}

async function setMode(mode: "manual" | "auto") {
  await prisma.companySettings.update({
    where: { organizationId: tenant.orgId },
    data: { allocationMode: mode },
  });
}

/**
 * An open, unstaffed shift. 09:00–13:00 Singapore sits inside the availability
 * window the members hold, so eligibility turns on the rule under test rather
 * than on a shift falling outside a window.
 */
async function openShift(dayOffset: number, headcount = 1) {
  return prisma.task.create({
    data: {
      title: `Shift +${dayOffset}`,
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      status: "open",
      priority: "medium",
      requiredHeadcount: headcount,
      scheduledStart: todaySgtAt(9, dayOffset),
      scheduledEnd: todaySgtAt(13, dayOffset),
    },
  });
}

function assignmentsOn(taskId: string) {
  return prisma.taskAssignment.findMany({ where: { taskId } });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("sweep");
  await makeAvailable(tenant.staff.membershipId);
  await makeAvailable(tenant.manager.membershipId);
});

describe("what the sweep fills", () => {
  it("staffs a shift that was left empty", async () => {
    await setMode("auto");
    const task = await openShift(5);

    const result = await allocation.staffUnfilled(tenant.orgId);

    expect(result.considered).toBe(1);
    expect(result.filled).toBe(1);
    expect(await assignmentsOn(task.id)).toHaveLength(1);
  });

  it("does nothing at all in manual mode", async () => {
    await setMode("manual");
    const task = await openShift(5);

    const result = await allocation.staffUnfilled(tenant.orgId);

    expect(result).toEqual({ considered: 0, filled: 0 });
    expect(await assignmentsOn(task.id)).toHaveLength(0);
  });

  it("leaves a shift that is already fully staffed alone", async () => {
    await setMode("auto");
    const task = await openShift(5);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    const result = await allocation.staffUnfilled(tenant.orgId);

    expect(result.considered).toBe(0);
    expect(await assignmentsOn(task.id)).toHaveLength(1);
  });

  /**
   * The distinction `assignment-status` exists for.
   *
   * A one-person shift with a single REJECTED row has an assignment row and
   * nobody on it. Counting rows would read it as staffed and skip it forever —
   * which is exactly how the dashboard and the reporting layer once reported
   * two different numbers for the same shift.
   */
  it("treats a shift whose only assignment was rejected as empty", async () => {
    await setMode("auto");
    const task = await openShift(5);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "rejected",
      },
    });

    const result = await allocation.staffUnfilled(tenant.orgId);

    expect(result.considered).toBe(1);
    expect(result.filled).toBe(1);
    // The manager, because the staff member already holds a row on this task
    // and `buildCandidatePool` excludes anyone who does.
    const rows = await assignmentsOn(task.id);
    expect(rows).toHaveLength(2);
    expect(
      rows.filter((r) => r.membershipId === tenant.manager.membershipId)
    ).toHaveLength(1);
  });
});

describe("what the sweep refuses to touch", () => {
  /**
   * Inside 48 hours it stops.
   *
   * Not the same reason as `findCover`'s short-notice rule, though it is the
   * same threshold: in `auto_accept` mode this assigns outright, and a
   * background job putting somebody on tomorrow's rota hours after they last
   * looked at the app is a surprise. The dashboard's understaffed alert is the
   * honest surface inside the window, because it faces a human.
   */
  it("will not fill a shift starting tomorrow", async () => {
    await setMode("auto");
    const task = await openShift(1);

    const result = await allocation.staffUnfilled(tenant.orgId);

    expect(result.considered).toBe(0);
    expect(await assignmentsOn(task.id)).toHaveLength(0);
  });

  it("will not reach past the horizon", async () => {
    await setMode("auto");
    const task = await openShift(40);

    const result = await allocation.staffUnfilled(tenant.orgId, 14);

    expect(result.considered).toBe(0);
    expect(await assignmentsOn(task.id)).toHaveLength(0);
  });

  it("ignores a shift with no date, rather than treating it as urgent", async () => {
    await setMode("auto");
    const task = await prisma.task.create({
      data: {
        title: "Someday",
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
        status: "open",
        priority: "low",
        requiredHeadcount: 1,
      },
    });

    const result = await allocation.staffUnfilled(tenant.orgId);

    expect(result.considered).toBe(0);
    expect(await assignmentsOn(task.id)).toHaveLength(0);
  });

  it("ignores a task that is not open", async () => {
    await setMode("auto");
    const task = await openShift(5);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "cancelled" },
    });

    expect((await allocation.staffUnfilled(tenant.orgId)).considered).toBe(0);
  });
});

describe("the sweep is deliberately silent", () => {
  /**
   * The decision most likely to be argued with, so it is stated as a test.
   *
   * Every shift this looks at was already reported once, when it was created or
   * generated and could not be filled. Re-reporting the same unfilled shift
   * every hour would not be an alert — it would be the reason somebody turns
   * notifications off, and it would bury the first message that said something
   * new.
   */
  it("says nothing when it still cannot fill a shift", async () => {
    await setMode("auto");
    await prisma.availability.updateMany({
      where: {
        membershipId: {
          in: [tenant.staff.membershipId, tenant.manager.membershipId],
        },
      },
      data: { isAvailable: false },
    });
    await openShift(5);

    const result = await allocation.staffUnfilled(tenant.orgId);
    expect(result.considered).toBe(1);
    expect(result.filled).toBe(0);

    await pauseForAbsence();
    const notices = await prisma.notification.findMany({
      where: { organizationId: tenant.orgId },
    });
    expect(notices).toHaveLength(0);
  });
});
