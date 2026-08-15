/**
 * Auto allocation mode, applied to the shifts the system creates for itself.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RecurringTaskService } from "@/services/recurring-task.service";
import { AllocationService } from "@/services/allocation.service";
import { TaskService } from "@/services/task.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { todaySgtAt } from "../helpers/time";
import { eventuallyAtLeast, pauseForAbsence } from "../helpers/settle";

const recurring = new RecurringTaskService();
const tasks = new TaskService();

/** The default horizon `create` uses, so a later run must reach past it. */
const FIRST_HORIZON = 14;
const LONGER_HORIZON = 28;

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

async function makeUnavailable(membershipIds: string[]) {
  await prisma.availability.updateMany({
    where: { membershipId: { in: membershipIds } },
    data: { isAvailable: false },
  });
}

/**
 * A daily series, created in MANUAL mode so nothing is staffed yet.
 *
 * 09:00–13:00 Singapore, inside the 06:00–18:00 windows the members hold, so
 * eligibility is decided by the rule under test rather than by a shift falling
 * outside a window — the trap the auto-schedule suite was caught by once.
 */
async function createDailySeriesUnstaffed() {
  await setMode("manual");
  const template = await tasks.create(
    {
      title: "Morning shift",
      departmentId: tenant.departmentId,
      scheduledStart: todaySgtAt(9, 1).toISOString(),
      scheduledEnd: todaySgtAt(13, 1).toISOString(),
      isRecurring: true,
      recurringPattern: JSON.stringify({ freq: "daily", interval: 1 }),
    },
    tenant.orgId,
    tenant.admin.userId
  );

  // The premise of every test below. If the pattern shape were wrong,
  // `parseRecurrencePattern` would return null and the series would expand to
  // nothing — and the assertions further down would all pass over an empty set.
  const first = await prisma.task.count({ where: { parentTaskId: template.id } });
  expect(
    first,
    "the series expanded to no instances — check the recurrence pattern shape"
  ).toBeGreaterThan(0);

  return template;
}

function backfillNotices() {
  return prisma.notification.findMany({
    where: { organizationId: tenant.orgId, type: "backfill_needed" },
  });
}

/** Instances of the series that carry at least one assignment. */
async function staffedCount(templateId: string) {
  const instances = await prisma.task.findMany({
    where: { parentTaskId: templateId },
    include: { assignments: true },
  });
  return {
    total: instances.length,
    staffed: instances.filter((i) => i.assignments.length > 0).length,
  };
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("recur");
  // Two rosterable members in the department. The admin is excluded by the
  // engine (admins hold no shifts) and the inactive member is not active, so
  // these two are the entire candidate pool.
  await makeAvailable(tenant.staff.membershipId);
  await makeAvailable(tenant.manager.membershipId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auto mode staffs what the generator creates", () => {
  it("fills the instances a later run materialises", async () => {
    const template = await createDailySeriesUnstaffed();
    const before = await staffedCount(template.id);
    expect(before.staffed).toBe(0);

    await setMode("auto");
    const run = await recurring.generateForOrganization(
      tenant.orgId,
      LONGER_HORIZON
    );

    // The run has to have made something, or "it filled everything it made" is
    // a statement about an empty set.
    expect(run.created).toBeGreaterThan(0);
    expect(run.filled).toBe(run.created);
    expect(run.unfilled).toBe(0);

    // Exactly the new ones. The instances that existed before this run were
    // made in manual mode and must still be untouched — a pass that quietly
    // back-filled them would be a different feature.
    const after = await staffedCount(template.id);
    expect(after.staffed).toBe(run.created);
    expect(after.total).toBe(before.total + run.created);
  });

  it("leaves them alone in manual mode", async () => {
    const template = await createDailySeriesUnstaffed();

    const run = await recurring.generateForOrganization(
      tenant.orgId,
      LONGER_HORIZON
    );

    expect(run.created).toBeGreaterThan(0);
    expect(run.filled).toBe(0);
    // Not "unfilled" either: in manual mode staffing them is not this job's
    // business, so counting them as failures would misreport a working org.
    expect(run.unfilled).toBe(0);
    expect((await staffedCount(template.id)).staffed).toBe(0);
  });

  /**
   * The providers must not be reachable from here.
   *
   * An hourly cron over every tenant calling a model once per unfilled shift is
   * a bill nobody agreed to and an outage nobody chose — a provider being down
   * would become a rostering failure. Both paths look identical in the
   * database, so the only way to state "and it did not do it the expensive way"
   * is to watch the AI entry point.
   */
  it("never asks a provider", async () => {
    await createDailySeriesUnstaffed();
    await setMode("auto");
    const ai = vi.spyOn(AllocationService.prototype, "getRankedSuggestions");

    const run = await recurring.generateForOrganization(
      tenant.orgId,
      LONGER_HORIZON
    );

    expect(run.filled).toBeGreaterThan(0);
    expect(ai).not.toHaveBeenCalled();
  });
});

describe("when it cannot fill them", () => {
  it("still creates the shifts, and counts what it could not staff", async () => {
    const template = await createDailySeriesUnstaffed();
    await makeUnavailable([
      tenant.staff.membershipId,
      tenant.manager.membershipId,
    ]);
    await setMode("auto");

    const run = await recurring.generateForOrganization(
      tenant.orgId,
      LONGER_HORIZON
    );

    // Non-zero on the counter the feature exists for — the first draft of this
    // file only ever observed zeros, so deleting the accounting entirely would
    // have left it green.
    expect(run.created).toBeGreaterThan(0);
    expect(run.unfilled).toBe(run.created);
    expect(run.filled).toBe(0);
    // The shifts exist and are empty, which is the intended outcome: a
    // generation run that gave up half way would leave the rest of the month
    // missing entirely, and that is worse than an unstaffed board.
    const after = await staffedCount(template.id);
    expect(after.total).toBeGreaterThan(0);
    expect(after.staffed).toBe(0);
  });

  it("reports it once per watcher, not once per shift", async () => {
    await createDailySeriesUnstaffed();
    await makeUnavailable([
      tenant.staff.membershipId,
      tenant.manager.membershipId,
    ]);
    await setMode("auto");

    const run = await recurring.generateForOrganization(
      tenant.orgId,
      LONGER_HORIZON
    );
    expect(run.unfilled).toBeGreaterThan(1);

    const notices = await eventuallyAtLeast(backfillNotices, 1);

    const perWatcher = new Map<string, number>();
    for (const notice of notices) {
      perWatcher.set(notice.userId, (perWatcher.get(notice.userId) ?? 0) + 1);
    }
    expect(perWatcher.size).toBeGreaterThan(0);
    for (const [userId, count] of perWatcher) {
      expect(
        count,
        `watcher ${userId} was told ${count} times for one run of ${run.unfilled} shifts`
      ).toBe(1);
    }
  });
});

describe("a run that creates nothing says nothing", () => {
  /**
   * Re-running over the same horizon materialises no new occurrences, so there
   * is nothing to staff and nothing to report.
   *
   * The series has to EXIST for this to mean anything. An earlier version of
   * this test created no series at all, so generation returned at "no
   * templates" long before reaching the code the test is named after — it would
   * have passed with the guard deleted.
   */
  it("does not notify on a repeat run", async () => {
    await createDailySeriesUnstaffed();
    await makeUnavailable([
      tenant.staff.membershipId,
      tenant.manager.membershipId,
    ]);
    await setMode("auto");

    const repeat = await recurring.generateForOrganization(
      tenant.orgId,
      FIRST_HORIZON
    );
    expect(repeat.seriesProcessed).toBeGreaterThan(0);
    expect(repeat.created).toBe(0);

    await pauseForAbsence();
    expect(await backfillNotices()).toHaveLength(0);
  });
});
