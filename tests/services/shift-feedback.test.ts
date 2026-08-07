/**
 * Response timing and satisfaction ratings.
 *
 * Both exist because `updatedAt` was the only record of when anything
 * happened, and every later transition overwrote it. The tests that matter
 * most here are the ones about what is NOT counted: an auto-accepted
 * assignment nobody responded to, a row predating the columns, a pending
 * assignment whose clock is still running. Folding any of those into an
 * average produces a flattering number that no one earned.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { ReportingService } from "@/services/reporting.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { pauseForAbsence } from "../helpers/settle";

const assignments = new TaskAssignmentService();
const reporting = new ReportingService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("fb");
});

const HOUR = 60 * 60 * 1000;

async function makeTask(title = "Shift", scheduledStart?: Date) {
  return prisma.task.create({
    data: {
      title,
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: 1,
      ...(scheduledStart
        ? { scheduledStart, scheduledEnd: new Date(scheduledStart.getTime() + 8 * HOUR) }
        : {}),
    },
  });
}

async function assign(
  taskId: string,
  status = "pending",
  extra: Record<string, unknown> = {}
) {
  return prisma.taskAssignment.create({
    data: {
      taskId,
      membershipId: tenant.staff.membershipId,
      assignedById: tenant.admin.userId,
      status,
      ...extra,
    },
  });
}

describe("response timestamps", () => {
  it("stamps acceptedAt when a member accepts", async () => {
    const task = await makeTask();
    const a = await assign(task.id);

    const before = Date.now();
    await assignments.accept(a.id, tenant.staff.membershipId);

    const after = await prisma.taskAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.acceptedAt).not.toBeNull();
    expect(after.acceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(after.rejectedAt).toBeNull();
  });

  it("stamps rejectedAt when a member declines", async () => {
    const task = await makeTask();
    const a = await assign(task.id);

    await assignments.reject(a.id, tenant.staff.membershipId, "feeling_unwell");

    const after = await prisma.taskAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.rejectedAt).not.toBeNull();
    expect(after.acceptedAt).toBeNull();
  });

  it("stamps withdrawalRequestedAt when a member asks to drop out", async () => {
    const task = await makeTask();
    const a = await assign(task.id, "accepted");

    await assignments.requestWithdrawal(a.id, tenant.staff.membershipId, "transport_issues");

    const after = await prisma.taskAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.withdrawalRequestedAt).not.toBeNull();
  });

  // A refused withdrawal did not happen, and the member is back on the shift.
  it("clears withdrawalRequestedAt when a manager denies the request", async () => {
    const task = await makeTask();
    const a = await assign(task.id, "accepted");
    await assignments.requestWithdrawal(a.id, tenant.staff.membershipId, "personal_reasons");

    await assignments.resolveWithdrawal(a.id, "deny", tenant.admin.userId, tenant.orgId);

    const after = await prisma.taskAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.withdrawalRequestedAt).toBeNull();
    expect(after.status).toBe("accepted");
  });

  // The reason accept() has its own repository method. Denying a withdrawal
  // also returns a row to "accepted", and stamping there would rewrite the
  // original response time every time a manager refused a request.
  it("does not rewrite acceptedAt when a denied withdrawal returns the row to accepted", async () => {
    const task = await makeTask();
    const a = await assign(task.id);
    await assignments.accept(a.id, tenant.staff.membershipId);
    const original = (
      await prisma.taskAssignment.findUniqueOrThrow({ where: { id: a.id } })
    ).acceptedAt!;

    await assignments.requestWithdrawal(a.id, tenant.staff.membershipId, "personal_reasons");
    await assignments.resolveWithdrawal(a.id, "deny", tenant.admin.userId, tenant.orgId);

    const after = await prisma.taskAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.acceptedAt!.getTime()).toBe(original.getTime());
  });
});

describe("response statistics", () => {
  it("reports the median rather than the mean, so one outlier does not move it", async () => {
    const created = new Date(Date.now() - 20 * 24 * HOUR);
    for (const hours of [1, 2, 3, 4, 500]) {
      const task = await makeTask(`T${hours}`);
      await assign(task.id, "accepted", {
        createdAt: created,
        acceptedAt: new Date(created.getTime() + hours * HOUR),
      });
    }

    const stats = await reporting.getResponseStats(tenant.orgId, 30);
    expect(stats.answered).toBe(5);
    expect(stats.medianResponseHours).toBe(3);
  });

  // The failure this whole design is arranged around. Auto-accepted rows have
  // no acceptedAt, and counting them as instant responses would bury a slow
  // team under a pile of zeroes.
  it("counts an auto-accepted assignment as unanswered, not as an instant reply", async () => {
    const created = new Date(Date.now() - 5 * 24 * HOUR);
    const answered = await makeTask("answered");
    await assign(answered.id, "accepted", {
      createdAt: created,
      acceptedAt: new Date(created.getTime() + 6 * HOUR),
    });

    const auto = await makeTask("auto");
    await prisma.taskAssignment.create({
      data: {
        taskId: auto.id,
        membershipId: tenant.manager.membershipId,
        assignedById: tenant.admin.userId,
        status: "accepted",
        createdAt: created,
      },
    });

    const stats = await reporting.getResponseStats(tenant.orgId, 30);
    expect(stats.answered).toBe(1);
    expect(stats.unanswered).toBe(1);
    expect(stats.medianResponseHours).toBe(6);
  });

  it("counts a still-pending assignment as awaiting, not as unanswered", async () => {
    const task = await makeTask();
    await assign(task.id, "pending");

    const stats = await reporting.getResponseStats(tenant.orgId, 30);
    expect(stats.awaiting).toBe(1);
    expect(stats.unanswered).toBe(0);
    expect(stats.answered).toBe(0);
  });

  it("reports an acceptance rate over answered assignments only", async () => {
    const created = new Date(Date.now() - 2 * 24 * HOUR);
    const t1 = await makeTask("a");
    await assign(t1.id, "accepted", { createdAt: created, acceptedAt: created });
    const t2 = await makeTask("b");
    await prisma.taskAssignment.create({
      data: {
        taskId: t2.id,
        membershipId: tenant.manager.membershipId,
        assignedById: tenant.admin.userId,
        status: "rejected",
        createdAt: created,
        rejectedAt: new Date(created.getTime() + HOUR),
      },
    });
    // Pending — must not drag the rate down as though it had been declined.
    const t3 = await makeTask("c");
    await prisma.taskAssignment.create({
      data: {
        taskId: t3.id,
        membershipId: tenant.inactive.membershipId,
        assignedById: tenant.admin.userId,
        status: "pending",
        createdAt: created,
      },
    });

    const stats = await reporting.getResponseStats(tenant.orgId, 30);
    expect(stats.acceptanceRate).toBe(50);
  });

  it("returns nulls rather than zeroes when nothing has been offered", async () => {
    const stats = await reporting.getResponseStats(tenant.orgId, 30);
    expect(stats.totalOffered).toBe(0);
    expect(stats.medianResponseHours).toBeNull();
    expect(stats.acceptanceRate).toBeNull();
  });

  it("does not let clock skew produce a negative response time", async () => {
    const created = new Date(Date.now() - 24 * HOUR);
    const task = await makeTask();
    await assign(task.id, "accepted", {
      createdAt: created,
      acceptedAt: new Date(created.getTime() - 5000),
    });

    const stats = await reporting.getResponseStats(tenant.orgId, 30);
    expect(stats.medianResponseHours).toBe(0);
  });

  it("measures withdrawal notice against the shift's start time", async () => {
    const start = new Date(Date.now() + 48 * HOUR);
    const task = await makeTask("notice", start);
    await assign(task.id, "withdrawal_requested", {
      withdrawalRequestedAt: new Date(start.getTime() - 10 * HOUR),
      withdrawalReason: "feeling_unwell",
    });

    const stats = await reporting.getResponseStats(tenant.orgId, 30);
    expect(stats.withdrawals.count).toBe(1);
    expect(stats.withdrawals.medianNoticeHours).toBe(10);
    expect(stats.withdrawals.underOneDay).toBe(1);
  });

  it("excludes another organisation's assignments", async () => {
    const other = await createTenant("fb-other");
    const foreign = await prisma.task.create({
      data: {
        title: "Theirs",
        organizationId: other.orgId,
        createdById: other.admin.userId,
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: foreign.id,
        membershipId: other.staff.membershipId,
        assignedById: other.admin.userId,
        status: "pending",
      },
    });

    const stats = await reporting.getResponseStats(tenant.orgId, 30);
    expect(stats.totalOffered).toBe(0);
  });

  it("honours a department scope", async () => {
    const outside = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#000000" },
    });
    const inScope = await makeTask("in");
    await assign(inScope.id, "pending");

    const other = await prisma.task.create({
      data: {
        title: "out",
        organizationId: tenant.orgId,
        departmentId: outside.id,
        createdById: tenant.admin.userId,
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: other.id,
        membershipId: tenant.manager.membershipId,
        assignedById: tenant.admin.userId,
        status: "pending",
      },
    });

    const scoped = await reporting.getResponseStats(tenant.orgId, 30, [tenant.departmentId]);
    expect(scoped.totalOffered).toBe(1);
  });
});

describe("rating a shift", () => {
  async function workedShift() {
    const task = await makeTask();
    return assign(task.id, "completed");
  }

  it("records the rating, the comment and when it was given", async () => {
    const a = await workedShift();
    await assignments.rate(a.id, tenant.staff.membershipId, 4, "  Busy but fine  ");

    const after = await prisma.taskAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.satisfactionRating).toBe(4);
    expect(after.satisfactionComment).toBe("Busy but fine");
    expect(after.ratedAt).not.toBeNull();
  });

  it("accepts a rating on a clocked-out shift that was never confirmed complete", async () => {
    const task = await makeTask();
    const a = await assign(task.id, "clocked_out");

    await expect(
      assignments.rate(a.id, tenant.staff.membershipId, 5)
    ).resolves.toBeDefined();
  });

  it("refuses a shift that has not been worked", async () => {
    const task = await makeTask();
    const a = await assign(task.id, "accepted");

    await expect(assignments.rate(a.id, tenant.staff.membershipId, 5)).rejects.toThrow(
      "Can only rate a shift you have worked"
    );
  });

  it("refuses anyone but the assigned member", async () => {
    const a = await workedShift();
    await expect(assignments.rate(a.id, tenant.manager.membershipId, 5)).rejects.toThrow(
      "Not authorized"
    );
  });

  it("refuses a score outside 1–5", async () => {
    const a = await workedShift();
    for (const bad of [0, 6, -1, 2.5]) {
      await expect(assignments.rate(a.id, tenant.staff.membershipId, bad)).rejects.toThrow(
        "Rating must be"
      );
    }
  });

  it("replaces a previous rating rather than adding a second", async () => {
    const a = await workedShift();
    await assignments.rate(a.id, tenant.staff.membershipId, 2, "Rough night");
    await assignments.rate(a.id, tenant.staff.membershipId, 4);

    const after = await prisma.taskAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.satisfactionRating).toBe(4);
    // The old comment must go with the old score, or new reasoning is shown
    // beside a rating it was never about.
    expect(after.satisfactionComment).toBeNull();
  });

  it("keeps every submission in the audit log", async () => {
    const a = await workedShift();
    await assignments.rate(a.id, tenant.staff.membershipId, 2);
    await assignments.rate(a.id, tenant.staff.membershipId, 5);

    const logs = await prisma.auditLog.findMany({
      where: { entityId: a.id, action: "assignment.rated" },
    });
    expect(logs).toHaveLength(2);
  });

  it("notifies the assigning manager only when the score is low", async () => {
    const low = await workedShift();
    await assignments.rate(low.id, tenant.staff.membershipId, 2, "Understaffed");
    const high = await workedShift();
    await assignments.rate(high.id, tenant.staff.membershipId, 5);

    // Asserting the notification does NOT exist, so this is a pause rather
    // than a poll — see helpers/settle.
    await pauseForAbsence(300);

    const notifications = await prisma.notification.findMany({
      where: { userId: tenant.admin.userId, type: "shift_rated_low" },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain("Understaffed");
  });
});

describe("satisfaction statistics", () => {
  async function rated(rating: number, extra: Record<string, unknown> = {}) {
    const task = await makeTask(`Rated ${rating}`);
    return prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "completed",
        satisfactionRating: rating,
        ratedAt: new Date(),
        ...extra,
      },
    });
  }

  it("averages the ratings and keeps the distribution", async () => {
    for (const r of [5, 4, 4, 2]) await rated(r);

    const stats = await reporting.getSatisfactionStats(tenant.orgId, 30);
    expect(stats.responses).toBe(4);
    expect(stats.average).toBe(3.8);
    expect(stats.distribution[4]).toBe(2);
    // Every key present, so an absent score reads as a gap rather than as
    // missing data.
    expect(stats.distribution[1]).toBe(0);
  });

  // The denominator has to include the shift being rated. Counting only
  // scheduled shifts excluded unscheduled ones from the denominator while
  // their ratings still counted in the numerator, so an organisation that
  // does not schedule could report more responses than rateable shifts.
  it("counts every worked shift in the denominator, scheduled or not", async () => {
    await rated(5);
    const unrated = await makeTask("unrated", new Date(Date.now() - 2 * 24 * HOUR));
    await assign(unrated.id, "completed");

    const stats = await reporting.getSatisfactionStats(tenant.orgId, 30);
    expect(stats.responses).toBe(1);
    expect(stats.rateable).toBe(2);
  });

  it("does not count a shift that has not been worked as rateable", async () => {
    const upcoming = await makeTask("upcoming", new Date(Date.now() + 2 * 24 * HOUR));
    await assign(upcoming.id, "accepted");

    const stats = await reporting.getSatisfactionStats(tenant.orgId, 30);
    expect(stats.rateable).toBe(0);
  });

  // A department with two ratings can top or bottom a ranked list on one bad
  // night, and a manager acts on that list.
  it("suppresses a department with too few responses to mean anything", async () => {
    for (const r of [1, 1]) await rated(r);

    const stats = await reporting.getSatisfactionStats(tenant.orgId, 30);
    expect(stats.responses).toBe(2);
    expect(stats.byDepartment).toHaveLength(0);
  });

  it("breaks out a department once it has enough responses, worst first", async () => {
    for (const r of [5, 5, 5, 5, 1]) await rated(r);

    const stats = await reporting.getSatisfactionStats(tenant.orgId, 30);
    expect(stats.byDepartment).toHaveLength(1);
    expect(stats.byDepartment[0].responses).toBe(5);
  });

  it("compares the engine's top pick against its lower-ranked picks", async () => {
    for (const r of [5, 5, 4, 5, 5]) await rated(r, { allocationRank: 1 });
    for (const r of [2, 3, 2, 3, 2]) await rated(r, { allocationRank: 3 });

    const stats = await reporting.getSatisfactionStats(tenant.orgId, 30);
    expect(stats.engineComparison.topPickAverage).toBe(4.8);
    expect(stats.engineComparison.otherAverage).toBe(2.4);
  });

  // The failure mode of this comparison is a confident conclusion drawn from
  // four data points.
  it("withholds the comparison until each side has enough responses", async () => {
    for (const r of [5, 5]) await rated(r, { allocationRank: 1 });

    const stats = await reporting.getSatisfactionStats(tenant.orgId, 30);
    expect(stats.engineComparison.topPickAverage).toBeNull();
    expect(stats.engineComparison.topPickResponses).toBe(2);
  });

  it("returns comments, skipping the blank ones", async () => {
    await rated(2, { satisfactionComment: "Short-staffed all night" });
    await rated(4, { satisfactionComment: "   " });
    await rated(5);

    const stats = await reporting.getSatisfactionStats(tenant.orgId, 30);
    expect(stats.recentComments).toHaveLength(1);
    expect(stats.recentComments[0].comment).toBe("Short-staffed all night");
  });

  it("reports null rather than zero when nobody has rated anything", async () => {
    const stats = await reporting.getSatisfactionStats(tenant.orgId, 30);
    expect(stats.responses).toBe(0);
    expect(stats.average).toBeNull();
  });

  it("excludes another organisation's ratings", async () => {
    const other = await createTenant("sat-other");
    const foreign = await prisma.task.create({
      data: { title: "Theirs", organizationId: other.orgId, createdById: other.admin.userId },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: foreign.id,
        membershipId: other.staff.membershipId,
        assignedById: other.admin.userId,
        status: "completed",
        satisfactionRating: 1,
        ratedAt: new Date(),
      },
    });

    const stats = await reporting.getSatisfactionStats(tenant.orgId, 30);
    expect(stats.responses).toBe(0);
  });
});
