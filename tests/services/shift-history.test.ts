/**
 * A member's own shift history.
 *
 * The two things worth testing hard are what gets INTO the history, and whether
 * the totals describe the same rows as the list.
 *
 * "History" is not "in the past". A shift they declined is history the moment
 * they decline it, even for next Tuesday; a shift that was cancelled is history
 * although nothing about it ever ran; and a shift that ended while still marked
 * "accepted" is history in the state that makes it worth looking at. Three
 * separate conditions, none of which the other two cover.
 *
 * The totals are computed over the whole range while the list is paged, so they
 * are two queries against one definition. Every figure has a test that pages
 * past its rows and asserts it did not move.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { TaskAssignmentService } from "@/services/task-assignment.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new TaskAssignmentService();

let tenant: Tenant;
let member: string;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("history");
  member = tenant.staff.membershipId;
});

/**
 * One shift and one assignment on it.
 *
 * `daysAgo` is negative for the future, which reads badly until you remember
 * every caller here is describing a past shift and the two future cases are the
 * interesting exceptions.
 */
async function shift(options: {
  daysAgo: number;
  status?: string;
  taskStatus?: string;
  clockedHours?: number;
  rating?: number;
  title?: string;
  membershipId?: string;
  scheduled?: boolean;
}) {
  const start = new Date(Date.now() - options.daysAgo * DAY);
  const end = new Date(start.getTime() + 8 * HOUR);
  const scheduled = options.scheduled ?? true;

  const task = await prisma.task.create({
    data: {
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      title: options.title ?? `Shift ${options.daysAgo}`,
      status: options.taskStatus ?? "completed",
      scheduledStart: scheduled ? start : null,
      scheduledEnd: scheduled ? end : null,
    },
  });

  return prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: options.membershipId ?? member,
      assignedById: tenant.admin.userId,
      status: options.status ?? "completed",
      clockInTime: options.clockedHours ? start : null,
      clockOutTime: options.clockedHours
        ? new Date(start.getTime() + options.clockedHours * HOUR)
        : null,
      satisfactionRating: options.rating ?? null,
      ratedAt: options.rating ? new Date() : null,
    },
  });
}

describe("what counts as history", () => {
  it("includes a shift that has ended", async () => {
    await shift({ daysAgo: 3 });
    const history = await service.getHistory(member);
    expect(history.total).toBe(1);
  });

  it("leaves out a shift still to come", async () => {
    await shift({ daysAgo: -3, status: "accepted", taskStatus: "open" });
    const history = await service.getHistory(member);
    expect(history.total).toBe(0);
  });

  /*
   * The reason history is not simply "scheduledEnd < now". Declining a shift
   * settles it for that member — it is not on their plate, and their record of
   * having turned it down is the thing they would come here to check.
   */
  it("includes a future shift they declined", async () => {
    await shift({ daysAgo: -5, status: "rejected", taskStatus: "open" });
    const history = await service.getHistory(member);
    expect(history.total).toBe(1);
    expect(history.rows[0].outcome).toBe("declined");
  });

  it("includes a future shift they withdrew from", async () => {
    await shift({ daysAgo: -5, status: "withdrawn", taskStatus: "open" });
    const history = await service.getHistory(member);
    expect(history.rows[0].outcome).toBe("withdrawn");
  });

  /*
   * The blind spot. A cancelled future shift leaves the assignment at
   * "accepted", so neither of the two conditions above catches it — it would
   * drop off the upcoming list and never appear in the record of what happened.
   */
  it("includes a future shift that was cancelled", async () => {
    await shift({ daysAgo: -5, status: "accepted", taskStatus: "cancelled" });
    const history = await service.getHistory(member);
    expect(history.total).toBe(1);
    expect(history.rows[0].outcome).toBe("cancelled");
  });

  it("leaves out a pending assignment on an unscheduled task", async () => {
    await shift({ daysAgo: 3, status: "pending", taskStatus: "open", scheduled: false });
    const history = await service.getHistory(member);
    expect(history.total).toBe(0);
  });

  it("shows nobody else's shifts", async () => {
    await shift({ daysAgo: 2, membershipId: tenant.manager.membershipId });
    const history = await service.getHistory(member);
    expect(history.total).toBe(0);
  });
});

describe("ordering", () => {
  /*
   * By the shift's own date, not by when the row was written. A manager
   * backfilling last month's roster today would otherwise put those shifts at
   * the top of the member's history.
   */
  it("puts the most recent shift first regardless of entry order", async () => {
    await shift({ daysAgo: 2, title: "Recent" });
    await shift({ daysAgo: 40, title: "Old" });

    const history = await service.getHistory(member);
    expect(history.rows.map((r) => r.task.title)).toEqual(["Recent", "Old"]);
  });

  // Postgres sorts NULLs first on DESC, which would open the page with them.
  it("puts undated shifts last", async () => {
    await shift({ daysAgo: 2, title: "Dated" });
    await shift({
      daysAgo: 2,
      title: "Undated",
      scheduled: false,
      status: "rejected",
    });

    const history = await service.getHistory(member);
    expect(history.rows.map((r) => r.task.title)).toEqual(["Dated", "Undated"]);
  });
});

describe("paging", () => {
  async function seed(count: number) {
    for (let i = 1; i <= count; i++) {
      await shift({ daysAgo: i, title: `Shift ${i}`, clockedHours: 4 });
    }
  }

  it("returns one page and the full count", async () => {
    await seed(5);
    const history = await service.getHistory(member, { pageSize: 2 });

    expect(history.rows).toHaveLength(2);
    expect(history.total).toBe(5);
    expect(history.totalPages).toBe(3);
  });

  it("does not repeat a row on the next page", async () => {
    await seed(5);
    const [first, second] = await Promise.all([
      service.getHistory(member, { pageSize: 2, page: 1 }),
      service.getHistory(member, { pageSize: 2, page: 2 }),
    ]);

    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
  });

  /*
   * The figures describe the range, not the page. If they were derived from the
   * rows in hand, "5 shifts, 20 hours" would become "2 shifts, 8 hours" on the
   * same data as soon as somebody set a page size — a number that changes when
   * you click next, which is the kind a reader trusts precisely because they
   * assume it cannot.
   */
  it("reports the same totals on every page", async () => {
    await seed(5);
    const first = await service.getHistory(member, { pageSize: 2, page: 1 });
    const last = await service.getHistory(member, { pageSize: 2, page: 3 });

    expect(first.summary).toEqual(last.summary);
    expect(last.summary.shiftsWorked).toBe(5);
    expect(last.summary.hoursWorked).toBe(20);
  });

  it("clamps an absurd page size rather than trying to serve it", async () => {
    await seed(3);
    const history = await service.getHistory(member, { pageSize: 5000 });
    expect(history.pageSize).toBe(100);
  });

  it("treats page zero as the first page", async () => {
    await seed(3);
    const history = await service.getHistory(member, { page: 0 });
    expect(history.page).toBe(1);
    expect(history.rows).toHaveLength(3);
  });

  // An empty history still has one page, or the pager renders "Page 1 of 0".
  it("reports one page when there is nothing", async () => {
    const history = await service.getHistory(member);
    expect(history.totalPages).toBe(1);
    expect(history.total).toBe(0);
  });
});

describe("the totals", () => {
  it("counts hours only from complete clock pairs", async () => {
    await shift({ daysAgo: 1, clockedHours: 6 });
    await shift({ daysAgo: 2, status: "accepted", taskStatus: "completed" });

    const { summary } = await service.getHistory(member);
    expect(summary.hoursWorked).toBe(6);
  });

  /*
   * A shift clocked into and never out of contributes no hours, and saying so
   * is the point — the total can be short as long as the page can explain why.
   * Falling back to the scheduled span would produce a figure that looks
   * measured and is not, on exactly the rows where it matters.
   */
  it("counts the shifts whose hours could not be measured", async () => {
    const start = new Date(Date.now() - 2 * DAY);
    const task = await prisma.task.create({
      data: {
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
        title: "Forgot to clock out",
        status: "completed",
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 8 * HOUR),
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: member,
        assignedById: tenant.admin.userId,
        status: "accepted",
        clockInTime: start,
      },
    });

    const { summary } = await service.getHistory(member);
    expect(summary.hoursWorked).toBe(0);
    expect(summary.shiftsMissingHours).toBe(1);
  });

  it("averages the ratings the member gave", async () => {
    await shift({ daysAgo: 1, clockedHours: 4, rating: 5 });
    await shift({ daysAgo: 2, clockedHours: 4, rating: 4 });

    const { summary } = await service.getHistory(member);
    expect(summary.averageRating).toBe(4.5);
    expect(summary.ratedShifts).toBe(2);
  });

  /*
   * Null, not zero. A member who has rated nothing has no average, and 0.0 out
   * of 5 on their own page reads as a score somebody gave them.
   */
  it("has no average when nothing has been rated", async () => {
    await shift({ daysAgo: 1, clockedHours: 4 });
    const { summary } = await service.getHistory(member);
    expect(summary.averageRating).toBeNull();
  });

  it("says how many worked shifts are still unrated", async () => {
    await shift({ daysAgo: 1, clockedHours: 4, rating: 5 });
    await shift({ daysAgo: 2, clockedHours: 4 });
    await shift({ daysAgo: 3, status: "rejected", taskStatus: "open" });

    const { summary } = await service.getHistory(member);
    expect(summary.unratedWorkedShifts).toBe(1);
  });

  it("does not count a declined shift as worked", async () => {
    await shift({ daysAgo: 1, status: "rejected", taskStatus: "open" });
    const { summary } = await service.getHistory(member);
    expect(summary.shiftsWorked).toBe(0);
    expect(summary.shiftsInRange).toBe(1);
  });
});

describe("filtering by date range", () => {
  beforeEach(async () => {
    await shift({ daysAgo: 3, title: "This week", clockedHours: 4 });
    await shift({ daysAgo: 45, title: "Last month", clockedHours: 8 });
  });

  it("keeps only shifts inside the range", async () => {
    const history = await service.getHistory(member, {
      from: new Date(Date.now() - 30 * DAY),
    });

    expect(history.rows.map((r) => r.task.title)).toEqual(["This week"]);
  });

  // The headline figures have to follow the filter, or the page reads
  // "Last 30 days — 12 hours" over a list of one four-hour shift.
  it("recomputes the totals for the range", async () => {
    const history = await service.getHistory(member, {
      from: new Date(Date.now() - 30 * DAY),
    });

    expect(history.summary.hoursWorked).toBe(4);
    expect(history.summary.shiftsWorked).toBe(1);
  });

  it("respects an upper bound too", async () => {
    const history = await service.getHistory(member, {
      to: new Date(Date.now() - 30 * DAY),
    });

    expect(history.rows.map((r) => r.task.title)).toEqual(["Last month"]);
  });

  it("refuses a range that runs backwards", async () => {
    await expect(
      service.getHistory(member, {
        from: new Date(Date.now()),
        to: new Date(Date.now() - 10 * DAY),
      })
    ).rejects.toThrow(/must come before/);
  });
});

describe("what each row carries", () => {
  /*
   * Department colour travels with the name in every task query in the
   * codebase. Without it the chip renders with no colour, which looks like a
   * department that has none rather than a select that forgot to ask.
   */
  it("includes the department's colour, not just its name", async () => {
    await shift({ daysAgo: 1 });
    const history = await service.getHistory(member);

    expect(history.rows[0].task.department?.name).toBeTruthy();
    expect(history.rows[0].task.department?.color).toBeTruthy();
  });

  it("gives each row its own hours", async () => {
    await shift({ daysAgo: 1, clockedHours: 7 });
    const history = await service.getHistory(member);
    expect(history.rows[0].hoursWorked).toBe(7);
  });

  it("leaves hours null where they cannot be measured", async () => {
    await shift({ daysAgo: 1, status: "rejected", taskStatus: "open" });
    const history = await service.getHistory(member);
    expect(history.rows[0].hoursWorked).toBeNull();
  });

  it("carries the reason a shift was turned down", async () => {
    const assignment = await shift({ daysAgo: 1, status: "rejected", taskStatus: "open" });
    await prisma.taskAssignment.update({
      where: { id: assignment.id },
      data: { rejectionReason: "feeling_unwell", rejectionNotes: "Flu" },
    });

    const history = await service.getHistory(member);
    expect(history.rows[0].rejectionReason).toBe("feeling_unwell");
    expect(history.rows[0].rejectionNotes).toBe("Flu");
  });
});
