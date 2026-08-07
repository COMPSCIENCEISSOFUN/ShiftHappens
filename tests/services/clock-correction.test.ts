/**
 * Correcting a recorded clock time.
 *
 * ## The gap this closes
 *
 * A shift clocked into and never out of contributes no hours, and nothing could
 * put it right. The member's own history said the shift was not counted and
 * offered no route to fixing it — a page telling somebody their pay is short
 * and that nothing can be done about it. Worse, the note on that row used to
 * read "ask your manager to correct it", which pointed at a feature that did
 * not exist: they would go and ask, and the manager would find out the same way.
 *
 * ## What is being protected
 *
 * This writes the field the hours totals are built from, on somebody else's
 * record. So the tests here are less about the happy path than about the three
 * things that make an amendment legitimate rather than an edit: a stated
 * reason, a durable account of the before and after, and the member being told
 * it happened.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { TaskAssignmentService } from "@/services/task-assignment.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { eventuallyAtLeast } from "../helpers/settle";

const service = new TaskAssignmentService();

let tenant: Tenant;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const START = new Date(Date.now() - 2 * DAY);
const END = new Date(START.getTime() + 8 * HOUR);

/** A finished shift, clocked in and — unless told otherwise — never out. */
async function shift(options: { clockIn?: Date | null; clockOut?: Date | null } = {}) {
  const task = await prisma.task.create({
    data: {
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      title: "Saturday close",
      status: "completed",
      scheduledStart: START,
      scheduledEnd: END,
    },
  });

  return prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: tenant.staff.membershipId,
      assignedById: tenant.admin.userId,
      status: "accepted",
      clockInTime: options.clockIn === undefined ? START : options.clockIn,
      clockOutTime: options.clockOut ?? null,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("clockfix");
});

describe("amending the times", () => {
  it("fills in a missing clock-out", async () => {
    const assignment = await shift();

    await service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
      clockInTime: START,
      clockOutTime: END,
      reason: "Forgot to clock out",
    });

    const row = await prisma.taskAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(row?.clockOutTime?.getTime()).toBe(END.getTime());
  });

  /*
   * The hours are the point. A correction that stored the right times and left
   * the member's total unchanged would look like it had worked while changing
   * nothing they can see.
   */
  it("puts the hours back into the member's total", async () => {
    const assignment = await shift();

    const before = await service.getHistory(tenant.staff.membershipId);
    expect(before.summary.hoursWorked).toBe(0);
    expect(before.summary.shiftsMissingHours).toBe(1);

    await service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
      clockInTime: START,
      clockOutTime: END,
      reason: "Forgot to clock out",
    });

    const after = await service.getHistory(tenant.staff.membershipId);
    expect(after.summary.hoursWorked).toBe(8);
    expect(after.summary.shiftsMissingHours).toBe(0);
  });

  /*
   * Clearing a wrongly-entered clock-in has to be expressible. Prisma reads
   * `undefined` as "leave alone", so if the service treated a missing value
   * that way there would be no way to erase one — the manager would send
   * nothing and the wrong time would survive.
   */
  it("can clear a clock-in that should never have been there", async () => {
    const assignment = await shift({ clockIn: START });

    await service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
      clockInTime: null,
      clockOutTime: null,
      reason: "Clocked in on the wrong shift",
    });

    const row = await prisma.taskAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(row?.clockInTime).toBeNull();
  });

  /*
   * A clock-in with no clock-out is allowed: it is the state a running shift is
   * genuinely in, and refusing it would stop a manager fixing a mistyped start
   * time until the member had finished.
   */
  it("accepts a clock-in with no clock-out", async () => {
    const assignment = await shift({ clockIn: null });

    await service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
      clockInTime: START,
      clockOutTime: null,
      reason: "Started at six, not eight",
    });

    const row = await prisma.taskAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(row?.clockInTime?.getTime()).toBe(START.getTime());
  });
});

describe("what it refuses", () => {
  it("refuses a clock-out before the clock-in", async () => {
    const assignment = await shift();

    await expect(
      service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
        clockInTime: END,
        clockOutTime: START,
        reason: "Typo",
      })
    ).rejects.toThrow(/must be after/);
  });

  it("refuses a clock-out equal to the clock-in", async () => {
    const assignment = await shift();

    await expect(
      service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
        clockInTime: START,
        clockOutTime: START,
        reason: "Typo",
      })
    ).rejects.toThrow(/must be after/);
  });

  /*
   * Half a correction: it would produce a row the hours calculation reads as
   * unmeasurable while looking complete on screen.
   */
  it("refuses a clock-out with no clock-in", async () => {
    const assignment = await shift({ clockIn: null });

    await expect(
      service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
        clockInTime: null,
        clockOutTime: END,
        reason: "They definitely left at four",
      })
    ).rejects.toThrow(/needs a clock in/);
  });

  /*
   * The reason is what separates a correction from an adjustment to somebody's
   * pay. Whitespace is not a reason.
   */
  it("refuses a blank reason", async () => {
    const assignment = await shift();

    await expect(
      service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
        clockInTime: START,
        clockOutTime: END,
        reason: "   ",
      })
    ).rejects.toThrow(/reason is required/);
  });

  it("writes nothing when it refuses", async () => {
    const assignment = await shift();

    await service
      .correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
        clockInTime: START,
        clockOutTime: END,
        reason: "",
      })
      .catch(() => {});

    const row = await prisma.taskAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(row?.clockOutTime).toBeNull();
    expect(row?.clockCorrectedAt).toBeNull();
  });

  // Another tenant's assignment is not found, not forbidden — the id is not
  // theirs to learn anything about.
  it("refuses an assignment in another organisation", async () => {
    const other = await createTenant("otherorg");
    const assignment = await shift();

    await expect(
      service.correctClock(assignment.id, other.orgId, other.admin.userId, {
        clockInTime: START,
        clockOutTime: END,
        reason: "Not mine to fix",
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe("the record of the change", () => {
  it("marks the row as corrected, by whom and why", async () => {
    const assignment = await shift();

    await service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
      clockInTime: START,
      clockOutTime: END,
      reason: "Forgot to clock out",
    });

    const row = await prisma.taskAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(row?.clockCorrectedAt).not.toBeNull();
    expect(row?.clockCorrectedById).toBe(tenant.admin.userId);
    expect(row?.clockCorrectionReason).toBe("Forgot to clock out");
  });

  /*
   * The before and after go to the audit log rather than onto the row. A value
   * the same person can quietly restate is not evidence, and two sets of times
   * on one record invites the question of which is real.
   */
  it("records what the times were before", async () => {
    const assignment = await shift();

    await service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
      clockInTime: START,
      clockOutTime: END,
      reason: "Forgot to clock out",
    });

    const logs = await prisma.auditLog.findMany({
      where: {
        organizationId: tenant.orgId,
        action: "assignment.clock_corrected",
      },
    });

    expect(logs).toHaveLength(1);
    const details = logs[0].details as Record<string, unknown>;
    const before = details.before as Record<string, string | null>;
    const after = details.after as Record<string, string | null>;

    expect(before.clockOutTime).toBeNull();
    expect(new Date(after.clockOutTime as string).getTime()).toBe(END.getTime());
  });

  /*
   * Awaited, not fired and forgotten. Everywhere else a lost audit row costs a
   * line of history; here it costs the only account of who changed somebody's
   * hours, which is the thing that makes the correction legitimate.
   */
  it("has written the audit row by the time it returns", async () => {
    const assignment = await shift();

    await service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
      clockInTime: START,
      clockOutTime: END,
      reason: "Forgot to clock out",
    });

    // No polling. If this needs to wait, the await was dropped.
    const logs = await prisma.auditLog.findMany({
      where: { action: "assignment.clock_corrected" },
    });
    expect(logs).toHaveLength(1);
  });

  /*
   * Told, not just recorded. Somebody else changing the hours you are paid
   * against is not an administrative detail, and a member who disagrees can
   * only say so if they know it happened.
   */
  it("tells the member", async () => {
    const assignment = await shift();

    await service.correctClock(assignment.id, tenant.orgId, tenant.admin.userId, {
      clockInTime: START,
      clockOutTime: END,
      reason: "Forgot to clock out",
    });

    const notes = await eventuallyAtLeast(() =>
      prisma.notification.findMany({ where: { userId: tenant.staff.userId } })
    );

    expect(notes.map((n) => n.title)).toContain("A clock time was corrected");
    expect(notes[0].message).toContain("Forgot to clock out");
  });
});
