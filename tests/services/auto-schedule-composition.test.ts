/**
 * Composition rules and the auto-scheduler.
 *
 * ## The bug
 *
 * `assignStaff` refuses an assignment that puts a composition rule beyond
 * reach. `confirmSchedule` writes assignments through its own path and did not
 * check at all, so a generated week could produce exactly the roster the manual
 * path refuses — two juniors on a shift whose rule says at most one.
 *
 * Neither draft strategy considered the rules either, so the fix has two halves
 * and both matter: the generator no longer proposes what cannot be written, and
 * the confirm step refuses it anyway. The second is not redundant — the draft
 * round-trips through the browser, so by the time it comes back it may be stale
 * or edited.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import {
  serialiseCompositionRules,
  type CompositionRule,
} from "@/lib/composition-rules";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { atHourSgt, nextMondaySgt } from "../helpers/time";

const service = new AutoScheduleService();

const AT_MOST_ONE_JUNIOR: CompositionRule = {
  kind: "seniority",
  value: "junior",
  comparator: "at_most",
  count: 1,
};

let orgId: string;
let adminUserId: string;
let deptId: string;
/** All three have no worked shifts, so all three derive as junior. */
let juniors: string[];

beforeEach(async () => {
  await cleanDatabase();

  const admin = await prisma.user.create({
    data: { name: "Admin", email: "admin@comp-sched.test", hashedPassword: "h" },
  });
  adminUserId = admin.id;

  const org = await prisma.organization.create({
    data: { name: "Comp Sched", slug: "comp-sched" },
  });
  orgId = org.id;

  await prisma.membership.create({
    data: { userId: admin.id, organizationId: orgId, role: "company_admin", status: "active" },
  });
  // Stated rather than inherited — see the note in auto-schedule.service.test.
  await prisma.companySettings.create({
    data: { organizationId: orgId, allocationMode: "suggested" },
  });

  const dept = await prisma.department.create({
    data: { name: "Kitchen", organizationId: orgId, color: "#EF4444" },
  });
  deptId = dept.id;

  juniors = [];
  for (const label of ["A", "B", "C"]) {
    const user = await prisma.user.create({
      data: { name: `Staff ${label}`, email: `${label}@comp-sched.test`, hashedPassword: "h" },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId: orgId, role: "staff", status: "active" },
    });
    juniors.push(membership.id);

    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: deptId },
    });
    for (let d = 1; d <= 5; d++) {
      await prisma.availability.create({
        data: {
          membershipId: membership.id,
          dayOfWeek: d,
          startTime: "06:00",
          endTime: "18:00",
          isAvailable: true,
        },
      });
    }
  }
});

async function makeTask(rules: CompositionRule[] | null, headcount = 2) {
  const weekStart = nextMondaySgt();
  const day = new Date(weekStart);
  day.setDate(day.getDate() + 1);

  return prisma.task.create({
    data: {
      title: "Evening shift",
      organizationId: orgId,
      departmentId: deptId,
      priority: "high",
      status: "open",
      requiredHeadcount: headcount,
      scheduledStart: atHourSgt(day, 8),
      scheduledEnd: atHourSgt(day, 12),
      createdById: adminUserId,
      compositionRules: rules ? serialiseCompositionRules(rules) : null,
    },
  });
}

function draftRow(taskId: string, membershipId: string) {
  return {
    taskId,
    taskTitle: "Evening shift",
    membershipId,
    staffName: "Staff",
    reasoning: "test",
  };
}

describe("confirmSchedule refuses what assignStaff would refuse", () => {
  it("writes the first junior and skips the second", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);

    const result = await service.confirmSchedule(
      orgId,
      [draftRow(task.id, juniors[0]), draftRow(task.id, juniors[1])],
      adminUserId
    );

    expect(result.created).toBe(1);
    expect(result.brokeComposition).toBe(1);

    const written = await prisma.taskAssignment.findMany({ where: { taskId: task.id } });
    expect(written).toHaveLength(1);
  });

  /*
   * The skip is a decision, not a failed write. Reported apart from
   * `writeErrors` because they call for different responses: one is a database
   * problem worth retrying, the other is a roster the rules will never accept.
   */
  it("does not report the skip as a database failure", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);

    const result = await service.confirmSchedule(
      orgId,
      [draftRow(task.id, juniors[0]), draftRow(task.id, juniors[1])],
      adminUserId
    );

    expect(result.writeErrors).toBe(0);
  });

  it("leaves an unconstrained task alone", async () => {
    const task = await makeTask(null);

    const result = await service.confirmSchedule(
      orgId,
      [draftRow(task.id, juniors[0]), draftRow(task.id, juniors[1])],
      adminUserId
    );

    expect(result.created).toBe(2);
    expect(result.brokeComposition).toBe(0);
  });

  // The people already on the shift are part of the roster the rule judges —
  // checking only the incoming rows would let a second junior in one draft at a
  // time.
  it("counts assignees already on the task", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 3);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: juniors[0],
        assignedById: adminUserId,
        status: "accepted",
      },
    });

    const result = await service.confirmSchedule(
      orgId,
      [draftRow(task.id, juniors[1])],
      adminUserId
    );

    expect(result.created).toBe(0);
    expect(result.brokeComposition).toBe(1);
  });

  /*
   * Same escape hatch the manual path offers. A rule with no way through is one
   * a manager deletes the first time it is inconvenient, and then it protects
   * nothing at all.
   */
  it("lets a documented override through", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);
    await prisma.eligibilityOverride.create({
      data: {
        taskId: task.id,
        membershipId: juniors[1],
        overriddenById: adminUserId,
        ruleOverridden: "composition",
        reason: "Trainee shadowing",
      },
    });

    const result = await service.confirmSchedule(
      orgId,
      [draftRow(task.id, juniors[0]), draftRow(task.id, juniors[1])],
      adminUserId
    );

    expect(result.created).toBe(2);
    expect(result.brokeComposition).toBe(0);
  });

  it("does not let an override for a different person through", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);
    await prisma.eligibilityOverride.create({
      data: {
        taskId: task.id,
        membershipId: juniors[2],
        overriddenById: adminUserId,
        ruleOverridden: "composition",
        reason: "Someone else entirely",
      },
    });

    const result = await service.confirmSchedule(
      orgId,
      [draftRow(task.id, juniors[0]), draftRow(task.id, juniors[1])],
      adminUserId
    );

    expect(result.created).toBe(1);
    expect(result.brokeComposition).toBe(1);
  });
});

describe("the counts partition", () => {
  /*
   * Every row lands in exactly one bucket, and they sum to `failed`.
   *
   * Asserted because `failed` used to be the only number reported and the UI
   * printed it alongside `rejected`, which is a subset — one bad row read as two
   * problems. A category added later without its own counter would vanish back
   * into `failed` and the same thing would happen again.
   */
  it("accounts for every row exactly once", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await service.confirmSchedule(
        orgId,
        [
          draftRow(task.id, juniors[0]), // written
          draftRow(task.id, juniors[0]), // duplicate pair
          draftRow(task.id, juniors[1]), // breaks the rule
          draftRow("not-this-org", juniors[2]), // cross-tenant
        ],
        adminUserId
      );

      expect(result.created).toBe(1);
      expect(result.duplicates).toBe(1);
      expect(result.brokeComposition).toBe(1);
      expect(result.rejected).toBe(1);
      expect(result.writeErrors).toBe(0);

      expect(result.created + result.failed).toBe(4);
      expect(result.failed).toBe(
        result.rejected +
          result.overCapacity +
          result.brokeComposition +
          result.duplicates +
          result.writeErrors
      );
    } finally {
      logged.mockRestore();
    }
  });
});

describe("the draft no longer proposes what confirm will refuse", () => {
  /*
   * The half that keeps the numbers honest. Without it a manager is shown
   * twenty assignments, confirms, and gets seventeen — the generator and the
   * writer disagreeing in a way only the result message reveals.
   */
  it("proposes one junior for a two-person shift that allows one", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);

    const draft = await service.generateSchedule(orgId, nextMondaySgt());
    const forTask = draft.assignments.filter((a) => a.taskId === task.id);

    expect(forTask).toHaveLength(1);
  });

  it("says the composition rules are why, not that nobody was left", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);

    const draft = await service.generateSchedule(orgId, nextMondaySgt());
    const unfilled = draft.unfilledTasks.find((u) => u.taskId === task.id);

    // Three available staff and one slot empty: "no eligible staff remaining"
    // would send a manager looking for more people when the problem is the mix.
    expect(unfilled?.reason).toContain("composition");
  });

  it("still fills an unconstrained shift completely", async () => {
    const task = await makeTask(null, 2);

    const draft = await service.generateSchedule(orgId, nextMondaySgt());
    const forTask = draft.assignments.filter((a) => a.taskId === task.id);

    expect(forTask).toHaveLength(2);
  });

  // The draft and the writer agree, which is the point of doing both halves.
  it("confirms its own draft with nothing skipped", async () => {
    await makeTask([AT_MOST_ONE_JUNIOR], 2);

    const draft = await service.generateSchedule(orgId, nextMondaySgt());
    const result = await service.confirmSchedule(
      orgId,
      draft.assignments,
      adminUserId
    );

    expect(result.created).toBe(draft.assignments.length);
    expect(result.brokeComposition).toBe(0);
  });
});
