/**
 * Three related defects in the whole-week scheduler.
 *
 * 1. It counted CLOCKED hours as the week's load, so a shift booked for next
 *    Tuesday read as zero — and "fewest hours worked" carries the ranker's
 *    largest single weight. Two runs in the same week therefore piled work onto
 *    the same people, with every hard rule passing.
 * 2. It ran org-wide for everybody, so a manager granted the permission through
 *    a custom role drafted and confirmed across departments they have no
 *    authority over.
 * 3. Confirm re-read headcount and composition from live state but not the
 *    person-level constraints, so two drafts built from the same starting state
 *    could each place one person on a different overlapping shift.
 *
 * Scope narrows WHAT IT FILLS and WHO IT MAY USE, never WHAT IT COUNTS — hours
 * and conflicts are facts about a person, not a department, and a draft blind
 * to another department's shifts would roster straight through a rest gap.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { AutoScheduleService } from "@/services/auto-schedule.service";
import { AvailabilityService } from "@/services/availability.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const scheduler = new AutoScheduleService();
const availability = new AvailabilityService();

let tenant: Tenant;
let kitchenId: string;
let securityId: string;
/** In Kitchen only. */
let cook: string;
/** In Security only. */
let guard: string;

/** Monday of a week comfortably in the future. */
function weekStart(): Date {
  const d = new Date(Date.now() + 21 * 86_400_000);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay() + 1);
  return d;
}

async function makeMember(name: string, email: string, departmentId: string) {
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
    data: { membershipId: membership.id, departmentId },
  });
  await availability.openUnsetDays(membership.id);
  return membership.id;
}

async function makeShift(departmentId: string | null, offsetHours: number, hours = 4) {
  const start = new Date(weekStart().getTime() + offsetHours * 3_600_000);
  return prisma.task.create({
    data: {
      organizationId: tenant.orgId,
      departmentId,
      createdById: tenant.admin.userId,
      title: `Shift +${offsetHours}h`,
      status: "open",
      requiredHeadcount: 1,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + hours * 3_600_000),
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("sched");
  kitchenId = tenant.departmentId;
  const security = await prisma.department.create({
    data: { name: "Security", organizationId: tenant.orgId },
  });
  securityId = security.id;

  cook = await makeMember("Cook", "cook@sched.test", kitchenId);
  guard = await makeMember("Guard", "guard@sched.test", securityId);
});

describe("hours already committed", () => {
  /*
   * The whole point: a booked shift is load whether or not anybody has clocked
   * into it yet. Read from `hoursThisWeek` on the context rather than through
   * a generated draft, because the draft's choice depends on the AI provider
   * and this is a question about the input.
   */
  it("counts a booked shift that nobody has worked yet", async () => {
    const shift = await makeShift(kitchenId, 30, 6);
    await prisma.taskAssignment.create({
      data: {
        taskId: shift.id,
        membershipId: cook,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    const context = await scheduler.collectWeekData(tenant.orgId, weekStart());
    const entry = context.staff.find((s) => s.membershipId === cook);
    expect(entry?.hoursThisWeek).toBeCloseTo(6, 1);
  });

  it("reads zero for somebody with nothing booked", async () => {
    const context = await scheduler.collectWeekData(tenant.orgId, weekStart());
    expect(
      context.staff.find((s) => s.membershipId === guard)?.hoursThisWeek
    ).toBe(0);
  });

  // A shift that overran is worth what it really took, not what was planned.
  it("prefers the actual hours once the shift has been worked", async () => {
    const shift = await makeShift(kitchenId, 30, 4);
    const start = new Date(weekStart().getTime() + 30 * 3_600_000);
    await prisma.taskAssignment.create({
      data: {
        taskId: shift.id,
        membershipId: cook,
        assignedById: tenant.admin.userId,
        status: "completed",
        clockInTime: start,
        clockOutTime: new Date(start.getTime() + 7 * 3_600_000),
      },
    });

    const context = await scheduler.collectWeekData(tenant.orgId, weekStart());
    expect(
      context.staff.find((s) => s.membershipId === cook)?.hoursThisWeek
    ).toBeCloseTo(7, 1);
  });

  it("ignores a shift somebody turned down", async () => {
    const shift = await makeShift(kitchenId, 30, 6);
    await prisma.taskAssignment.create({
      data: {
        taskId: shift.id,
        membershipId: cook,
        assignedById: tenant.admin.userId,
        status: "rejected",
      },
    });

    const context = await scheduler.collectWeekData(tenant.orgId, weekStart());
    expect(
      context.staff.find((s) => s.membershipId === cook)?.hoursThisWeek
    ).toBe(0);
  });
});

describe("what a scoped draft may fill", () => {
  beforeEach(async () => {
    await makeShift(kitchenId, 30);
    await makeShift(securityId, 32);
    await makeShift(null, 34);
  });

  it("an admin sees every department", async () => {
    const context = await scheduler.collectWeekData(tenant.orgId, weekStart(), null);
    const depts = context.tasks.map((t) => t.departmentId);
    expect(depts).toContain(kitchenId);
    expect(depts).toContain(securityId);
  });

  it("a scoped caller sees only their own", async () => {
    const context = await scheduler.collectWeekData(tenant.orgId, weekStart(), [
      kitchenId,
    ]);
    expect(context.tasks.map((t) => t.departmentId)).toEqual([kitchenId]);
  });

  /*
   * A department-less shift is org-wide work. `isDepartmentInScope` treats it
   * as out of scope for every non-admin, so a scoped caller who cannot see it
   * must not be able to roster it either.
   */
  it("a shift with no department is admin-only", async () => {
    const admin = await scheduler.collectWeekData(tenant.orgId, weekStart(), null);
    expect(admin.tasks.some((t) => t.departmentId === null)).toBe(true);

    const scoped = await scheduler.collectWeekData(tenant.orgId, weekStart(), [
      kitchenId,
    ]);
    expect(scoped.tasks.some((t) => t.departmentId === null)).toBe(false);
  });
});

describe("who a scoped draft may use", () => {
  it("only members of the caller's departments", async () => {
    const context = await scheduler.collectWeekData(tenant.orgId, weekStart(), [
      kitchenId,
    ]);
    const ids = context.staff.map((s) => s.membershipId);
    expect(ids).toContain(cook);
    expect(ids).not.toContain(guard);
  });

  // Belonging to ANY of the caller's departments is enough — somebody in both
  // Kitchen and Security is a legitimate candidate for a Kitchen draft.
  it("includes somebody who is in one of several", async () => {
    const both = await makeMember("Floater", "float@sched.test", kitchenId);
    await prisma.departmentMembership.create({
      data: { membershipId: both, departmentId: securityId },
    });

    const context = await scheduler.collectWeekData(tenant.orgId, weekStart(), [
      kitchenId,
    ]);
    expect(context.staff.map((s) => s.membershipId)).toContain(both);
  });

  /*
   * The qualification that matters. Scope narrows the candidate list; it must
   * NOT narrow what the engine knows about those candidates, or a Kitchen
   * manager's draft would think a shared member was idle when Security had
   * them all week.
   */
  it("still counts their hours from departments the caller cannot see", async () => {
    const both = await makeMember("Floater", "float2@sched.test", kitchenId);
    await prisma.departmentMembership.create({
      data: { membershipId: both, departmentId: securityId },
    });
    const securityShift = await makeShift(securityId, 30, 8);
    await prisma.taskAssignment.create({
      data: {
        taskId: securityShift.id,
        membershipId: both,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    const context = await scheduler.collectWeekData(tenant.orgId, weekStart(), [
      kitchenId,
    ]);
    expect(
      context.staff.find((s) => s.membershipId === both)?.hoursThisWeek
    ).toBeCloseTo(8, 1);
  });
});

describe("confirming a draft", () => {
  function row(taskId: string, membershipId: string) {
    return { taskId, taskTitle: "Shift", membershipId, staffName: "X", reasoning: "" };
  }

  it("refuses rows for a department the caller cannot see", async () => {
    const securityShift = await makeShift(securityId, 30);

    const result = await scheduler.confirmSchedule(
      tenant.orgId,
      [row(securityShift.id, guard)],
      tenant.manager.userId,
      undefined,
      [kitchenId]
    );

    expect(result.created).toBe(0);
    expect(result.rejected).toBe(1);
    expect(
      await prisma.taskAssignment.count({ where: { taskId: securityShift.id } })
    ).toBe(0);
  });

  it("allows rows inside it", async () => {
    const kitchenShift = await makeShift(kitchenId, 30);

    const result = await scheduler.confirmSchedule(
      tenant.orgId,
      [row(kitchenShift.id, cook)],
      tenant.manager.userId,
      undefined,
      [kitchenId]
    );

    expect(result.created).toBe(1);
  });

  /*
   * THE concurrency case. Two drafts built from the same starting state, each
   * naming the same person for a different shift that overlaps the other. The
   * slots differ and composition is fine, so nothing but a person-level
   * re-check can catch it.
   */
  it("refuses a second overlapping shift for the same person", async () => {
    const morning = await makeShift(kitchenId, 30, 6);
    const overlapping = await makeShift(kitchenId, 33, 6);

    const result = await scheduler.confirmSchedule(
      tenant.orgId,
      [row(morning.id, cook), row(overlapping.id, cook)],
      tenant.admin.userId
    );

    expect(result.created).toBe(1);
    expect(result.ineligible).toBe(1);
  });

  it("refuses a row whose leave was approved after the draft was built", async () => {
    const shift = await makeShift(kitchenId, 30);
    const override = await availability.createOverride(cook, {
      date: new Date(weekStart().getTime() + 30 * 3_600_000).toISOString(),
      isAvailable: false,
      reason: "Medical",
    });
    await availability.reviewLeave(
      override.id,
      "approved",
      tenant.admin.userId,
      tenant.orgId
    );

    const result = await scheduler.confirmSchedule(
      tenant.orgId,
      [row(shift.id, cook)],
      tenant.admin.userId
    );

    expect(result.created).toBe(0);
    expect(result.ineligible).toBe(1);
  });

  /*
   * The docblock on the return value warns that a skip category added without
   * its own counter disappears into `failed`. This is that assertion.
   */
  it("keeps the reason counters a partition of failed", async () => {
    const shift = await makeShift(kitchenId, 30);
    const securityShift = await makeShift(securityId, 32);

    const result = await scheduler.confirmSchedule(
      tenant.orgId,
      [
        row(shift.id, cook),
        row(shift.id, cook), // duplicate
        row(shift.id, guard), // over capacity
        row(securityShift.id, guard), // out of scope
      ],
      tenant.manager.userId,
      undefined,
      [kitchenId]
    );

    expect(
      result.rejected +
        result.overCapacity +
        result.brokeComposition +
        result.ineligible +
        result.duplicates +
        result.writeErrors
    ).toBe(result.failed);
  });
});
