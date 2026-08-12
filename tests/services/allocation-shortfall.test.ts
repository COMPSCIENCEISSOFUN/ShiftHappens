// @vitest-environment node
/**
 * What auto mode says when it does not finish the job.
 *
 * ## The gap this closes
 *
 * `autoAllocate` takes the top N candidates for N places and throws only when
 * it finds NOBODY. A shift needing three people and offered one therefore
 * assigned that one, returned normally, and told nobody — so it read as staffed
 * on every screen that checks a status rather than a count, and the first
 * person to discover otherwise was whoever turned up to work it.
 *
 * "Nobody at all" was already reported. "Not enough" was silent. That asymmetry
 * is what these tests pin.
 *
 * ## Why the counts are deliberately lopsided
 *
 * A headcount larger than the tenant has members can never be filled, whatever
 * the eligibility rules decide about any individual — so "partly staffed" is
 * reached without the test depending on how many of admin, manager and staff
 * happen to qualify. The empty case is forced the other way, with a shift at
 * 03:00 that sits outside every availability window, rather than by removing
 * availability rows and hoping nobody is eligible by default.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskService } from "@/services/task.service";
import { NOTIFICATION_TYPES } from "@/lib/notification-types";
import { countOccupied } from "@/lib/assignment-status";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { todaySgtAt } from "../helpers/time";
import { pauseForAbsence } from "../helpers/settle";

const tasks = new TaskService();

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

/** Create through the SERVICE, which is what runs auto allocation. */
function createShift(
  headcount: number,
  opts: { hour?: number; dayOffset?: number } = {}
) {
  const hour = opts.hour ?? 9;
  const dayOffset = opts.dayOffset ?? 5;
  return tasks.create(
    {
      title: `Shift needing ${headcount}`,
      departmentId: tenant.departmentId,
      requiredHeadcount: headcount,
      priority: "medium",
      scheduledStart: todaySgtAt(hour, dayOffset).toISOString(),
      scheduledEnd: todaySgtAt(hour + 4, dayOffset).toISOString(),
    },
    tenant.orgId,
    tenant.admin.userId
  );
}

function notificationsOfType(type: string) {
  return prisma.notification.findMany({
    where: { organizationId: tenant.orgId, type },
  });
}

/**
 * The shared rule, not a hand-written status list.
 *
 * The first version of this counted `status in ("assigned","accepted")` and
 * disagreed with the service on every other occupying status — so the message
 * under test said one person had been placed while the assertion beside it saw
 * none. Importing the same predicate the production path uses is what makes
 * the two agree by construction rather than by coincidence.
 */
async function occupiedCount(taskId: string) {
  const assignments = await prisma.taskAssignment.findMany({ where: { taskId } });
  return countOccupied(assignments);
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("shortfall");
  await setMode("auto");
});

describe("when auto mode fills the shift completely", () => {
  it("says nothing at all", async () => {
    await makeAvailable(tenant.staff.membershipId);

    const task = await createShift(1);
    await pauseForAbsence();

    expect(await occupiedCount(task.id)).toBe(1);
    expect(
      await notificationsOfType(NOTIFICATION_TYPES.TASK_PARTIALLY_FILLED)
    ).toHaveLength(0);
    expect(
      await notificationsOfType(NOTIFICATION_TYPES.TASK_UNFILLED)
    ).toHaveLength(0);
  });
});

describe("when auto mode fills the shift only partly", () => {
  it("tells the watchers it is short", async () => {
    await makeAvailable(tenant.staff.membershipId);
    await makeAvailable(tenant.manager.membershipId);

    // More places than this organisation has people, so it cannot be filled.
    const task = await createShift(9);
    await pauseForAbsence();

    const placed = await occupiedCount(task.id);
    expect(placed).toBeGreaterThan(0);
    expect(placed).toBeLessThan(9);

    const raised = await notificationsOfType(
      NOTIFICATION_TYPES.TASK_PARTIALLY_FILLED
    );
    expect(raised.length).toBeGreaterThan(0);
    expect(
      await notificationsOfType(NOTIFICATION_TYPES.TASK_UNFILLED)
    ).toHaveLength(0);
  });

  /*
   * The number is the point. "Understaffed" reads the same on a shift missing
   * one of nine as on one missing eight, and which of those it is decides
   * whether anybody has to do something today.
   */
  it("says how many places are still open", async () => {
    await makeAvailable(tenant.staff.membershipId);

    const task = await createShift(9);
    await pauseForAbsence();

    const placed = await occupiedCount(task.id);
    const [raised] = await notificationsOfType(
      NOTIFICATION_TYPES.TASK_PARTIALLY_FILLED
    );

    expect(raised.message).toContain(`${9 - placed} place`);
    expect(raised.entityId).toBe(task.id);
  });

  /*
   * The creator is looking at the screen that already shows the shift short.
   * A notification about the thing they did one second ago is how a feed
   * becomes something people stop opening.
   */
  it("does not tell the person who created it", async () => {
    await makeAvailable(tenant.staff.membershipId);

    await createShift(9);
    await pauseForAbsence();

    const raised = await notificationsOfType(
      NOTIFICATION_TYPES.TASK_PARTIALLY_FILLED
    );
    expect(raised.some((n) => n.userId === tenant.admin.userId)).toBe(false);
  });
});

describe("when auto mode finds nobody", () => {
  /*
   * 03:00 sits outside every availability window in this fixture, so the pool
   * is empty for a reason the eligibility rules agree on rather than because
   * the rows were withheld.
   */
  it("reports it as not staffed rather than as partly staffed", async () => {
    await makeAvailable(tenant.staff.membershipId);

    const task = await createShift(1, { hour: 3 });
    await pauseForAbsence();

    expect(await occupiedCount(task.id)).toBe(0);
    expect(
      await notificationsOfType(NOTIFICATION_TYPES.TASK_UNFILLED)
    ).not.toHaveLength(0);
    expect(
      await notificationsOfType(NOTIFICATION_TYPES.TASK_PARTIALLY_FILLED)
    ).toHaveLength(0);
  });
});

describe("in manual mode", () => {
  /*
   * Auto allocation never ran, so there is no shortfall to report — a human is
   * going to assign this task, and telling them it is unassigned the moment
   * they create it is noise.
   */
  it("says nothing, because nothing was attempted", async () => {
    await setMode("manual");
    await makeAvailable(tenant.staff.membershipId);

    await createShift(9);
    await pauseForAbsence();

    expect(
      await notificationsOfType(NOTIFICATION_TYPES.TASK_PARTIALLY_FILLED)
    ).toHaveLength(0);
    expect(
      await notificationsOfType(NOTIFICATION_TYPES.TASK_UNFILLED)
    ).toHaveLength(0);
  });
});
