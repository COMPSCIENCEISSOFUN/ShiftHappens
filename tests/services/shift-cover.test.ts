/**
 * What happens to a shift somebody has just come off.
 *
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { AllocationService } from "@/services/allocation.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { todaySgtAt } from "../helpers/time";
import { eventuallyMatching, pauseForAbsence } from "../helpers/settle";

const assignments = new TaskAssignmentService();
const allocation = new AllocationService();

let tenant: Tenant;

/**
 * Available 06:00–18:00 every day.
 *
 * The window matters and the shift times below sit inside it on purpose. The
 * auto-schedule suite has already been caught by this once: a fixture whose
 * shifts fell outside the availability window refused every candidate on
 * availability, so the rule under test was never reached and deleting it
 * changed nothing.
 */
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

async function setMode(mode: "manual" | "suggested" | "auto") {
  await prisma.companySettings.update({
    where: { organizationId: tenant.orgId },
    data: { allocationMode: mode },
  });
}

/** A one-person shift, by default comfortably in the future and in-window. */
async function shiftAt(startHour = 8, dayOffset = 5) {
  return prisma.task.create({
    data: {
      title: "Evening service",
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      status: "open",
      priority: "medium",
      requiredHeadcount: 1,
      scheduledStart: todaySgtAt(startHour, dayOffset),
      scheduledEnd: todaySgtAt(startHour + 4, dayOffset),
    },
  });
}

/** The staff member accepts the shift and then asks to come off it. */
async function withdrawalPendingOn(taskId: string) {
  const assignment = await prisma.taskAssignment.create({
    data: {
      taskId,
      membershipId: tenant.staff.membershipId,
      assignedById: tenant.admin.userId,
      status: "accepted",
    },
  });
  await assignments.requestWithdrawal(
    assignment.id,
    tenant.staff.membershipId,
    "personal_reasons"
  );
  return assignment;
}

function backfillNotices() {
  return prisma.notification.findMany({
    where: { organizationId: tenant.orgId, type: "backfill_needed" },
  });
}

/** Rows on the task other than the one that was withdrawn from. */
async function replacementsOn(taskId: string) {
  return prisma.taskAssignment.findMany({
    where: {
      taskId,
      membershipId: { not: tenant.staff.membershipId },
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("cover");
  // The manager is rosterable and sits in the same department, so they are the
  // replacement the engine has to find. The admin is not — admins hold no
  // shifts — which is why the ACTOR below is the admin and never the candidate.
  await makeAvailable(tenant.staff.membershipId);
  await makeAvailable(tenant.manager.membershipId);
});

describe("the person who asked to come off is not offered it back", () => {
  /**
   * The whole reason the row survives.
   *
   * Break `TaskAssignmentRepository.withdraw` back to `cancel` and this goes
   * red — not because cover stops working, but because it starts working too
   * well and hands the shift to the one person who has just said they cannot
   * work it.
   */
  it("keeps the assignment row, marked withdrawn", async () => {
    await setMode("manual");
    const task = await shiftAt();
    const assignment = await withdrawalPendingOn(task.id);

    await assignments.resolveWithdrawal(
      assignment.id,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );

    const row = await prisma.taskAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(row?.status).toBe("withdrawn");
  });

  it("leaves them out of the cover options afterwards", async () => {
    await setMode("manual");
    const task = await shiftAt();
    const assignment = await withdrawalPendingOn(task.id);

    await assignments.resolveWithdrawal(
      assignment.id,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );

    const options = await allocation.coverOptions(task.id, tenant.orgId);
    expect(options.map((o) => o.membershipId)).not.toContain(
      tenant.staff.membershipId
    );
    // And the ranking is not simply empty — the manager IS available, so an
    // empty list would pass this for the wrong reason.
    expect(options.map((o) => o.membershipId)).toContain(
      tenant.manager.membershipId
    );
  });

  it("leaves them out while the request is still open, too", async () => {
    await setMode("manual");
    const task = await shiftAt();
    await withdrawalPendingOn(task.id);

    const options = await allocation.coverOptions(task.id, tenant.orgId);

    expect(options.map((o) => o.membershipId)).not.toContain(
      tenant.staff.membershipId
    );
    // The positive control. Without it a pool that came back empty for any
    // unrelated reason — a fixture that failed to write windows, a scope bug —
    // satisfies the line above and the test reports nothing.
    expect(options.map((o) => o.membershipId)).toContain(
      tenant.manager.membershipId
    );
  });
});

describe("approving a withdrawal looks for cover", () => {
  it("offers the shift to the best replacement in auto mode", async () => {
    await setMode("auto");
    const task = await shiftAt();
    const assignment = await withdrawalPendingOn(task.id);

    await assignments.resolveWithdrawal(
      assignment.id,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );

    const replacements = await replacementsOn(task.id);
    expect(replacements).toHaveLength(1);
    expect(replacements[0].membershipId).toBe(tenant.manager.membershipId);
    /*
     * PENDING, not accepted, and that is the design rather than an accident of
     * the org's acceptance mode: cover is always offered. The engine decides
     * who to ask; the person still decides whether to work.
     */
    expect(replacements[0].status).toBe("pending");
  });

  it("assigns nobody in manual mode, and tells the people who can act", async () => {
    await setMode("manual");
    const task = await shiftAt();
    const assignment = await withdrawalPendingOn(task.id);

    await assignments.resolveWithdrawal(
      assignment.id,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );

    expect(await replacementsOn(task.id)).toHaveLength(0);
    // The predicate names what is being waited for. `() => true` would make the
    // assertion below a tautology: the helper returns as soon as any row
    // exists, so a non-empty list is guaranteed by the time it is read.
    const notices = await eventuallyMatching(backfillNotices, (n) =>
      n.title.includes("needs cover")
    );
    expect(notices.map((n) => n.title).join(" | ")).toContain("needs cover");
  });

  /**
   * The branch a manager most needs and the one an empty screen hides.
   *
   * Nobody else is available here — the manager's availability is removed — so
   * the honest outcome is a message saying so, not silence. Without this the
   * "no eligible replacement" branch is reachable only in production.
   */
  it("says so when nobody is eligible", async () => {
    await setMode("auto");
    await prisma.availability.updateMany({
      where: { membershipId: tenant.manager.membershipId },
      data: { isAvailable: false },
    });
    const task = await shiftAt();
    const assignment = await withdrawalPendingOn(task.id);

    await assignments.resolveWithdrawal(
      assignment.id,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );

    expect(await replacementsOn(task.id)).toHaveLength(0);
    const notices = await eventuallyMatching(backfillNotices, (n) =>
      n.title.includes("nobody available")
    );
    expect(notices.map((n) => n.title).join(" ")).toContain("nobody available");
  });
});

describe("what automation refuses to do", () => {
  /**
   * Inside the 48-hour window, auto mode stops assigning and asks a human.
   *
   * Paired deliberately with the ended-shift test below, because both produce
   * no assignment and only the NOTIFICATION tells them apart. A test asserting
   * "nobody was assigned" alone would pass for either reason and could not
   * distinguish the rule from its absence.
   */
  it("does not fill a shift starting within 48 hours, but does raise it", async () => {
    await setMode("auto");
    /*
     * Tomorrow at 08:00: always in the future, always under 48 hours away,
     * whatever time the suite runs at. TODAY at 08:00 would usually be in the
     * PAST, which trips the ended-shift guard below instead and would have had
     * this test passing on a rule it is not about.
     */
    const task = await shiftAt(8, 1);
    const assignment = await withdrawalPendingOn(task.id);

    await assignments.resolveWithdrawal(
      assignment.id,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );

    expect(await replacementsOn(task.id)).toHaveLength(0);
    const notices = await eventuallyMatching(backfillNotices, (n) =>
      n.title.includes("Urgent")
    );
    // The short-notice branch has its own wording, so this distinguishes "the
    // rule fired" from "some notification happened" — which is what separates
    // this test from the ended-shift one below, where nothing fires at all.
    expect(notices.map((n) => n.title).join(" | ")).toContain("Urgent");
  });

  /**
   * A shift that has already finished needs no cover and no message.
   *
   * This is the stale request from backlog §5.24 — a withdrawal from months ago
   * answered today. Without the guard it arrives as SHORT NOTICE, because the
   * short-notice check measures hours until the start and a past shift is
   * comfortably under any threshold, so the whole watcher list would be told to
   * "arrange cover directly" for a shift nobody can work now.
   */
  it("does not look for cover for a shift that has already ended", async () => {
    await setMode("auto");
    const task = await shiftAt(8, -30);
    const assignment = await withdrawalPendingOn(task.id);

    await assignments.resolveWithdrawal(
      assignment.id,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );

    expect(await replacementsOn(task.id)).toHaveLength(0);
    // Absence, so a fixed pause rather than polling — see helpers/settle.ts.
    await pauseForAbsence();
    expect(await backfillNotices()).toHaveLength(0);
  });
});

describe("approving a decline looks for cover too", () => {
  /**
   * Driven by putting the row into `decline_requested` directly rather than
   * through `reject`, which would drag the full-time employment rules into a
   * test about what happens AFTER the decision. The state is what
   * `resolveDecline` acts on, and the state is what this sets up.
   */
  it("offers the shift on to somebody else", async () => {
    await setMode("auto");
    const task = await shiftAt();
    const assignment = await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "decline_requested",
        rejectionReason: "personal_reasons",
      },
    });

    await assignments.resolveDecline(
      assignment.id,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );

    const replacements = await replacementsOn(task.id);
    expect(replacements).toHaveLength(1);
    expect(replacements[0].membershipId).toBe(tenant.manager.membershipId);
  });

  it("leaves the declined row in place as a rejection", async () => {
    await setMode("manual");
    const task = await shiftAt();
    const assignment = await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "decline_requested",
        rejectionReason: "personal_reasons",
      },
    });

    await assignments.resolveDecline(
      assignment.id,
      "approve",
      tenant.admin.userId,
      tenant.orgId
    );

    const row = await prisma.taskAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(row?.status).toBe("rejected");
  });
});

describe("coverOptions", () => {
  it("returns nobody when nobody else is eligible", async () => {
    const task = await shiftAt();
    /*
     * BOTH rosterable members, not just the manager.
     *
     * This task carries no assignment, so unlike every other fixture in this
     * file the staff member is not excluded by holding a row — they were still
     * a perfectly good candidate and the empty-list assertion could never have
     * held. The admin is excluded by the engine and the inactive member by
     * their status, so with these two off there is genuinely nobody.
     */
    await prisma.availability.updateMany({
      where: {
        membershipId: {
          in: [tenant.staff.membershipId, tenant.manager.membershipId],
        },
      },
      data: { isAvailable: false },
    });

    expect(await allocation.coverOptions(task.id, tenant.orgId)).toEqual([]);
  });

  it("names the people it ranks", async () => {
    const task = await shiftAt();

    const options = await allocation.coverOptions(task.id, tenant.orgId);

    expect(options.length).toBeGreaterThan(0);
    /*
     * The name the fixture actually gave this person, not "is not blank".
     *
     * `coverOptions` builds its lookup from the same array that produced the
     * rankings, so its `?? "A staff member"` fallback is unreachable by
     * construction and asserting against it proves nothing. Naming the expected
     * value is the only version that catches a join keyed on the wrong field.
     */
    const manager = await prisma.membership.findUniqueOrThrow({
      where: { id: tenant.manager.membershipId },
      include: { user: { select: { name: true } } },
    });
    const named = options.find(
      (o) => o.membershipId === tenant.manager.membershipId
    );
    expect(named?.name).toBe(manager.user.name);
  });

  it("refuses a task belonging to another organisation", async () => {
    const other = await createTenant("cover-other");
    const task = await prisma.task.create({
      data: {
        title: "Not yours",
        organizationId: other.orgId,
        departmentId: other.departmentId,
        createdById: other.admin.userId,
        status: "open",
        priority: "medium",
        requiredHeadcount: 1,
      },
    });

    await expect(
      allocation.coverOptions(task.id, tenant.orgId)
    ).rejects.toThrow("Task not found");
  });
});
