/**
 * Narrowing a member's history, and the risk that comes with it.
 *
 * ## Two implementations of one rule
 *
 * `shiftOutcome` decides what became of a shift in application code. The
 * outcome FILTER has to decide the same thing in SQL, because the list is paged
 * — classifying in application code would mean fetching the whole history to
 * filter it, which breaks paging and makes the totals describe a different set
 * of rows than the list underneath them.
 *
 * They cannot easily share code: `shift-outcome.ts` is imported by the browser,
 * and giving it Prisma types would drag the server's client into the page
 * bundle. So the two definitions are separate, which is exactly the shape this
 * codebase keeps getting bitten by — a rule written twice and drifting.
 *
 * The answer here is not to hope. The partition test below filters by every
 * outcome in turn, classifies each returned row with `shiftOutcome`, and
 * asserts the seven counts sum to the unfiltered total. Overlap or a gap
 * between the two definitions cannot survive it, and it costs one test rather
 * than seven.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { TaskAssignmentService } from "@/services/task-assignment.service";
import { shiftOutcome, SHIFT_OUTCOMES } from "@/lib/shift-outcome";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new TaskAssignmentService();

let tenant: Tenant;
let member: string;
let secondDepartment: string;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function shift(options: {
  daysAgo: number;
  status?: string;
  taskStatus?: string;
  clockIn?: boolean;
  clockOut?: boolean;
  title?: string;
  departmentId?: string;
}) {
  const start = new Date(Date.now() - options.daysAgo * DAY);
  const task = await prisma.task.create({
    data: {
      organizationId: tenant.orgId,
      departmentId: options.departmentId ?? tenant.departmentId,
      createdById: tenant.admin.userId,
      title: options.title ?? `Shift ${options.daysAgo}`,
      status: options.taskStatus ?? "completed",
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 8 * HOUR),
    },
  });

  return prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: member,
      assignedById: tenant.admin.userId,
      status: options.status ?? "completed",
      clockInTime: options.clockIn ? start : null,
      clockOutTime: options.clockOut ? new Date(start.getTime() + 8 * HOUR) : null,
    },
  });
}

/**
 * At least one row of every outcome, plus the awkward combinations the
 * precedence exists to settle — a worked shift that was later cancelled, and a
 * declined shift on a cancelled task.
 */
async function seedEveryOutcome() {
  await shift({ daysAgo: 1, status: "completed", clockIn: true, clockOut: true });
  await shift({ daysAgo: 2, status: "clocked_out", clockIn: true, clockOut: true });
  await shift({ daysAgo: 3, status: "rejected", taskStatus: "open" });
  await shift({ daysAgo: 4, status: "withdrawn", taskStatus: "open" });
  await shift({ daysAgo: 5, status: "accepted", taskStatus: "cancelled" });
  await shift({ daysAgo: 6, status: "accepted", clockIn: true });
  await shift({ daysAgo: 7, status: "pending" });
  await shift({ daysAgo: 8, status: "decline_requested" });
  await shift({ daysAgo: 9, status: "accepted" });
  await shift({ daysAgo: 10, status: "withdrawal_requested" });
  // Worked, then the task was cancelled underneath it. Must read as worked.
  await shift({
    daysAgo: 11,
    status: "completed",
    taskStatus: "cancelled",
    clockIn: true,
    clockOut: true,
  });
  // Declined a shift that was then called off. Their decision came first.
  await shift({ daysAgo: 12, status: "rejected", taskStatus: "cancelled" });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("filters");
  member = tenant.staff.membershipId;

  const dept = await prisma.department.create({
    data: { name: "Bar", organizationId: tenant.orgId, color: "#f59e0b" },
  });
  secondDepartment = dept.id;
});

describe("the two definitions of an outcome agree", () => {
  /*
   * The test this file exists for.
   *
   * Every row the SQL filter returns must classify, in application code, as the
   * outcome that was asked for. A filter that was too broad fails here.
   */
  it("returns only rows that classify as the outcome asked for", async () => {
    await seedEveryOutcome();

    for (const outcome of SHIFT_OUTCOMES) {
      const { rows } = await service.getHistory(member, { outcome, pageSize: 100 });
      for (const row of rows) {
        expect(shiftOutcome(row), `${outcome} filter returned a ${shiftOutcome(row)}`).toBe(
          outcome
        );
      }
    }
  });

  /*
   * And the other direction. Summing the seven filtered counts against the
   * unfiltered total catches a filter that is too NARROW — rows falling through
   * every outcome, which the test above cannot see because it only inspects
   * what came back.
   *
   * Together the two make it a partition: no overlap, no gap.
   */
  it("partitions the whole history exactly", async () => {
    await seedEveryOutcome();

    const all = await service.getHistory(member, { pageSize: 100 });

    let summed = 0;
    for (const outcome of SHIFT_OUTCOMES) {
      const { total } = await service.getHistory(member, { outcome, pageSize: 100 });
      summed += total;
    }

    expect(summed).toBe(all.total);
    // A fixture that seeded nothing would satisfy 0 === 0.
    expect(all.total).toBeGreaterThanOrEqual(SHIFT_OUTCOMES.length);
  });

  // The precedence cases, named individually so a failure says which one broke.
  it("counts a worked shift that was later cancelled as worked", async () => {
    await shift({
      daysAgo: 1,
      status: "completed",
      taskStatus: "cancelled",
      clockIn: true,
      clockOut: true,
    });

    const worked = await service.getHistory(member, { outcome: "worked" });
    const cancelled = await service.getHistory(member, { outcome: "cancelled" });

    expect(worked.total).toBe(1);
    expect(cancelled.total).toBe(0);
  });

  it("counts a declined shift that was later cancelled as declined", async () => {
    await shift({ daysAgo: 1, status: "rejected", taskStatus: "cancelled" });

    const declined = await service.getHistory(member, { outcome: "declined" });
    const cancelled = await service.getHistory(member, { outcome: "cancelled" });

    expect(declined.total).toBe(1);
    expect(cancelled.total).toBe(0);
  });

  /*
   * A clock-out with a status that never reached a worked state still counts as
   * worked — the hours happened whether or not anybody pressed the last button.
   */
  it("counts a clock-out as worked whatever the status says", async () => {
    await shift({ daysAgo: 1, status: "accepted", clockIn: true, clockOut: true });

    const worked = await service.getHistory(member, { outcome: "worked" });
    expect(worked.total).toBe(1);
  });
});

describe("the totals follow the filter", () => {
  /*
   * The failure this guards is the one the summary was built to avoid, arriving
   * through a different door: a filter reaching the paged list but not the
   * unpaged totals would print "3 shifts, 24 hours" above a list of one.
   */
  it("recomputes the summary for the filtered set", async () => {
    await shift({ daysAgo: 1, status: "completed", clockIn: true, clockOut: true });
    await shift({ daysAgo: 2, status: "completed", clockIn: true, clockOut: true });
    await shift({ daysAgo: 3, status: "rejected", taskStatus: "open" });

    const declined = await service.getHistory(member, { outcome: "declined" });

    expect(declined.total).toBe(1);
    expect(declined.summary.shiftsInRange).toBe(1);
    expect(declined.summary.shiftsWorked).toBe(0);
    expect(declined.summary.hoursWorked).toBe(0);
  });

  it("recomputes it for a department filter too", async () => {
    await shift({ daysAgo: 1, status: "completed", clockIn: true, clockOut: true });
    await shift({
      daysAgo: 2,
      status: "completed",
      clockIn: true,
      clockOut: true,
      departmentId: secondDepartment,
    });

    const bar = await service.getHistory(member, { departmentId: secondDepartment });

    expect(bar.total).toBe(1);
    expect(bar.summary.hoursWorked).toBe(8);
  });
});

describe("narrowing by department", () => {
  it("keeps only that department's shifts", async () => {
    await shift({ daysAgo: 1, title: "Kitchen shift" });
    await shift({ daysAgo: 2, title: "Bar shift", departmentId: secondDepartment });

    const { rows } = await service.getHistory(member, {
      departmentId: secondDepartment,
    });

    expect(rows.map((r) => r.task.title)).toEqual(["Bar shift"]);
  });

  it("returns everything when no department is named", async () => {
    await shift({ daysAgo: 1 });
    await shift({ daysAgo: 2, departmentId: secondDepartment });

    const { total } = await service.getHistory(member);
    expect(total).toBe(2);
  });
});

describe("searching the title", () => {
  it("finds a shift by part of its name", async () => {
    await shift({ daysAgo: 1, title: "Saturday close" });
    await shift({ daysAgo: 2, title: "Sunday brunch" });

    const { rows } = await service.getHistory(member, { search: "close" });
    expect(rows.map((r) => r.task.title)).toEqual(["Saturday close"]);
  });

  /*
   * The member typing here is looking for a shift they remember, not running a
   * query. Matching the capitalisation a manager happened to use would be a
   * search that works only if you already know the answer.
   */
  it("ignores case", async () => {
    await shift({ daysAgo: 1, title: "Saturday Close" });

    const { rows } = await service.getHistory(member, { search: "saturday close" });
    expect(rows).toHaveLength(1);
  });

  it("treats whitespace as no search at all", async () => {
    await shift({ daysAgo: 1, title: "Saturday close" });
    await shift({ daysAgo: 2, title: "Sunday brunch" });

    const { total } = await service.getHistory(member, { search: "   " });
    expect(total).toBe(2);
  });

  it("finds nothing rather than everything when nothing matches", async () => {
    await shift({ daysAgo: 1, title: "Saturday close" });

    const { total } = await service.getHistory(member, { search: "zzzz" });
    expect(total).toBe(0);
  });
});

describe("filters combine", () => {
  /*
   * Each filter narrows the last rather than replacing it. Three conditions
   * ANDed is the obvious reading of the UI — three controls all set — and a
   * builder that ORed them would quietly widen the result every time somebody
   * added a constraint.
   */
  it("applies outcome, department and search together", async () => {
    await shift({
      daysAgo: 1,
      title: "Saturday close",
      status: "completed",
      clockIn: true,
      clockOut: true,
      departmentId: secondDepartment,
    });
    // Right department and title, wrong outcome.
    await shift({
      daysAgo: 2,
      title: "Saturday close",
      status: "rejected",
      taskStatus: "open",
      departmentId: secondDepartment,
    });
    // Right outcome and title, wrong department.
    await shift({
      daysAgo: 3,
      title: "Saturday close",
      status: "completed",
      clockIn: true,
      clockOut: true,
    });
    // Right outcome and department, wrong title.
    await shift({
      daysAgo: 4,
      title: "Sunday brunch",
      status: "completed",
      clockIn: true,
      clockOut: true,
      departmentId: secondDepartment,
    });

    const { total } = await service.getHistory(member, {
      outcome: "worked",
      departmentId: secondDepartment,
      search: "saturday",
    });

    expect(total).toBe(1);
  });

  it("still respects the date range alongside them", async () => {
    await shift({ daysAgo: 2, status: "completed", clockIn: true, clockOut: true });
    await shift({ daysAgo: 60, status: "completed", clockIn: true, clockOut: true });

    const { total } = await service.getHistory(member, {
      outcome: "worked",
      from: new Date(Date.now() - 30 * DAY),
    });

    expect(total).toBe(1);
  });
});
