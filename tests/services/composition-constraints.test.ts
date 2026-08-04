/**
 * Composition constraints, end to end through the database.
 *
 * The pure rules are covered in tests/lib/composition-rules.test.ts. What is
 * asserted here is everything that only breaks once real data is involved:
 * that seniority is derived from shifts actually worked, that the candidate
 * set includes the people already on the shift, that the gate refuses at the
 * right moment rather than the first one, and that an override releases it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CompositionService } from "@/services/composition.service";
import { SeniorityService } from "@/services/seniority.service";
import { TaskService } from "@/services/task.service";
import { serialiseCompositionRules, type CompositionRule } from "@/lib/composition-rules";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const composition = new CompositionService();
const seniority = new SeniorityService();
const taskService = new TaskService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("comp");
});

const AT_MOST_ONE_JUNIOR: CompositionRule = {
  kind: "seniority",
  value: "junior",
  comparator: "at_most",
  count: 1,
};

const AT_LEAST_ONE_FIRST_AID: CompositionRule = {
  kind: "certification",
  value: "First Aid",
  comparator: "at_least",
  count: 1,
};

async function addStaff(label: string, employmentType = "casual") {
  const user = await prisma.user.create({
    data: { name: label, email: `${label}-${Date.now()}-${Math.random()}@x.test`, hashedPassword: "h" },
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: tenant.orgId,
      role: "staff",
      status: "active",
      employmentType,
    },
  });
  await prisma.departmentMembership.create({
    data: { membershipId: membership.id, departmentId: tenant.departmentId },
  });
  return membership.id;
}

/** Completed shifts are the evidence seniority is derived from. */
async function giveWorkedShifts(
  membershipId: string,
  count: number,
  departmentId: string | null = tenant.departmentId
) {
  for (let i = 0; i < count; i++) {
    const task = await prisma.task.create({
      data: {
        title: `Worked ${i}`,
        organizationId: tenant.orgId,
        departmentId,
        createdById: tenant.admin.userId,
        status: "completed",
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId,
        assignedById: tenant.admin.userId,
        status: "completed",
      },
    });
  }
}

async function certify(membershipId: string, name: string, expiryDate?: Date | null) {
  await prisma.certification.create({
    data: {
      membershipId,
      name,
      issuedDate: new Date("2026-01-01"),
      expiryDate: expiryDate ?? null,
      status: "verified",
    },
  });
}

async function makeTask(rules: CompositionRule[], headcount = 2) {
  return prisma.task.create({
    data: {
      title: "Evening shift",
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: headcount,
      compositionRules: serialiseCompositionRules(rules),
    },
  });
}

describe("derived seniority", () => {
  it("counts completed shifts, not assignments merely accepted", async () => {
    const member = await addStaff("derive");
    await giveWorkedShifts(member, 12);

    // An accepted-but-unworked shift must not count, or being rostered would
    // become evidence of the experience the roster was supposed to require.
    const pending = await prisma.task.create({
      data: {
        title: "Upcoming",
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: pending.id,
        membershipId: member,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    const result = await seniority.assessOne(tenant.orgId, member, tenant.departmentId);
    expect(result.completedShifts).toBe(12);
    expect(result.level).toBe("experienced");
  });

  // A kitchen veteran is a novice behind the bar, and an org-wide count would
  // confidently say otherwise.
  it("counts within the department the shift belongs to", async () => {
    const other = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    const member = await addStaff("kitchen-veteran");
    await giveWorkedShifts(member, 20, tenant.departmentId);

    const inKitchen = await seniority.assessOne(tenant.orgId, member, tenant.departmentId);
    const atBar = await seniority.assessOne(tenant.orgId, member, other.id);

    expect(inKitchen.level).toBe("experienced");
    expect(atBar.level).toBe("junior");
    expect(atBar.completedShifts).toBe(0);
  });

  it("counts org-wide when the shift has no department", async () => {
    const member = await addStaff("everywhere");
    await giveWorkedShifts(member, 11);

    const result = await seniority.assessOne(tenant.orgId, member, null);
    expect(result.completedShifts).toBe(11);
    expect(result.scopeDepartmentId).toBeNull();
  });

  it("uses the organisation's own thresholds", async () => {
    const member = await addStaff("threshold");
    await giveWorkedShifts(member, 3);

    expect((await seniority.assessOne(tenant.orgId, member, tenant.departmentId)).level).toBe(
      "junior"
    );

    await prisma.companySettings.update({
      where: { organizationId: tenant.orgId },
      data: { experiencedShiftThreshold: 2, seniorShiftThreshold: 3 },
    });

    expect((await seniority.assessOne(tenant.orgId, member, tenant.departmentId)).level).toBe(
      "senior"
    );
  });

  it("never counts another organisation's shifts", async () => {
    const other = await createTenant("other-org");
    const member = await addStaff("shared");

    // A shift in a different tenant, assigned to our member. Impossible through
    // the API, written directly here because the guard is what is under test.
    const foreignTask = await prisma.task.create({
      data: {
        title: "Elsewhere",
        organizationId: other.orgId,
        createdById: other.admin.userId,
        status: "completed",
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: foreignTask.id,
        membershipId: member,
        assignedById: other.admin.userId,
        status: "completed",
      },
    });

    const result = await seniority.assessOne(tenant.orgId, member, null);
    expect(result.completedShifts).toBe(0);
  });

  it("assesses many members in one call", async () => {
    const a = await addStaff("many-a");
    const b = await addStaff("many-b");
    await giveWorkedShifts(a, 10);

    const result = await seniority.assessMany(tenant.orgId, [a, b], tenant.departmentId);
    expect(result[a].level).toBe("experienced");
    expect(result[b].level).toBe("junior");
  });

  it("returns nothing for an empty request rather than querying", async () => {
    expect(await seniority.assessMany(tenant.orgId, [])).toEqual({});
  });
});

describe("seniority override", () => {
  // The failure derivation cannot fix on its own: an experienced external hire
  // has no history here, so the count keeps them off the shifts that would
  // build it.
  it("lets a manager pin a level a new joiner could not have earned", async () => {
    const member = await addStaff("new-hire");
    await seniority.setOverride(tenant.orgId, member, "senior", tenant.admin.userId);

    const result = await seniority.assessOne(tenant.orgId, member, tenant.departmentId);
    expect(result.level).toBe("senior");
    expect(result.overridden).toBe(true);
    expect(result.completedShifts).toBe(0);
  });

  it("releases back to derivation when cleared", async () => {
    const member = await addStaff("release");
    await giveWorkedShifts(member, 10);
    await seniority.setOverride(tenant.orgId, member, "junior", tenant.admin.userId);
    expect((await seniority.assessOne(tenant.orgId, member, tenant.departmentId)).level).toBe(
      "junior"
    );

    await seniority.setOverride(tenant.orgId, member, null, tenant.admin.userId);
    const released = await seniority.assessOne(tenant.orgId, member, tenant.departmentId);
    expect(released.level).toBe("experienced");
    expect(released.overridden).toBe(false);
  });

  it("records who changed it and what it was before", async () => {
    const member = await addStaff("audited");
    await seniority.setOverride(tenant.orgId, member, "senior", tenant.admin.userId);
    await seniority.setOverride(tenant.orgId, member, "experienced", tenant.admin.userId);

    const logs = await prisma.auditLog.findMany({
      where: { entityId: member, action: "membership.seniority_overridden" },
      orderBy: { createdAt: "asc" },
    });

    expect(logs).toHaveLength(2);
    expect(logs[1].details).toMatchObject({ from: "senior", to: "experienced" });
  });

  it("refuses a level that is not one of the three", async () => {
    const member = await addStaff("bad-level");
    await expect(
      seniority.setOverride(tenant.orgId, member, "principal", tenant.admin.userId)
    ).rejects.toThrow("Invalid seniority level");
  });

  // The membership id arrives in a request body, so belonging to the caller's
  // organisation has to be proved rather than assumed.
  it("refuses a member belonging to another organisation", async () => {
    const other = await createTenant("victim");
    await expect(
      seniority.setOverride(tenant.orgId, other.staff.membershipId, "senior", tenant.admin.userId)
    ).rejects.toThrow("Member not found");

    const untouched = await prisma.membership.findUniqueOrThrow({
      where: { id: other.staff.membershipId },
    });
    expect(untouched.seniorityOverride).toBeNull();
  });
});

describe("building the candidate set", () => {
  it("carries seniority, valid certificates and employment type", async () => {
    const member = await addStaff("full", "full_time");
    await giveWorkedShifts(member, 10);
    await certify(member, "First Aid");

    const [candidate] = await composition.buildCandidates(
      tenant.orgId,
      [member],
      tenant.departmentId
    );

    expect(candidate.seniority).toBe("experienced");
    expect(candidate.certifications).toEqual(["First Aid"]);
    expect(candidate.employmentType).toBe("full_time");
  });

  it("ignores an expired or unverified certificate", async () => {
    const member = await addStaff("stale-certs");
    await certify(member, "Expired", new Date("2020-01-01"));
    await prisma.certification.create({
      data: {
        membershipId: member,
        name: "Pending",
        issuedDate: new Date("2026-01-01"),
        status: "pending",
      },
    });

    const [candidate] = await composition.buildCandidates(
      tenant.orgId,
      [member],
      tenant.departmentId
    );
    expect(candidate.certifications).toEqual([]);
  });

  it("keeps a certificate with no expiry date", async () => {
    const member = await addStaff("perpetual");
    await certify(member, "Food Safety", null);

    const [candidate] = await composition.buildCandidates(
      tenant.orgId,
      [member],
      tenant.departmentId
    );
    expect(candidate.certifications).toEqual(["Food Safety"]);
  });

  it("does not duplicate a member named twice", async () => {
    const member = await addStaff("dupe");
    const candidates = await composition.buildCandidates(
      tenant.orgId,
      [member, member],
      tenant.departmentId
    );
    expect(candidates).toHaveLength(1);
  });
});

describe("evaluating a task", () => {
  it("includes the people already assigned, not only the proposed addition", async () => {
    const junior = await addStaff("already-on");
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 3);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: junior,
        assignedById: tenant.admin.userId,
        status: "pending",
      },
    });

    const second = await addStaff("proposed");
    const result = await composition.evaluateForTask(task.id, [second]);

    expect(result.candidates).toHaveLength(2);
    expect(result.rules[0].matched).toBe(2);
    expect(result.feasible).toBe(false);
  });

  it("ignores a rejected assignment, which no longer occupies a slot", async () => {
    const gone = await addStaff("rejected");
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: gone,
        assignedById: tenant.admin.userId,
        status: "rejected",
      },
    });

    const result = await composition.evaluateForTask(task.id, [await addStaff("live")]);
    expect(result.candidates).toHaveLength(1);
  });

  // Still on the shift until a manager resolves the request — treating them as
  // gone would let a replacement be assigned into a seat that is not free.
  it("counts a member with a pending withdrawal request", async () => {
    const leaving = await addStaff("withdrawing");
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 3);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: leaving,
        assignedById: tenant.admin.userId,
        status: "withdrawal_requested",
      },
    });

    const result = await composition.evaluateForTask(task.id, []);
    expect(result.candidates).toHaveLength(1);
  });

  // Scoping proved through the gate, not just through the seniority service:
  // experience earned in the kitchen must not qualify someone for a bar rule.
  // Evaluated org-wide this member reads senior and the rule passes.
  it("scopes seniority to the task's own department", async () => {
    const bar = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    const veteran = await addStaff("bar-newcomer");
    await giveWorkedShifts(veteran, 40, tenant.departmentId);

    const barTask = await prisma.task.create({
      data: {
        title: "Bar shift",
        organizationId: tenant.orgId,
        departmentId: bar.id,
        createdById: tenant.admin.userId,
        requiredHeadcount: 2,
        compositionRules: serialiseCompositionRules([AT_MOST_ONE_JUNIOR]),
      },
    });

    const other = await addStaff("bar-junior");
    await taskService.assignStaff(barTask.id, tenant.orgId, [other], tenant.admin.userId);

    await expect(
      taskService.assignStaff(barTask.id, tenant.orgId, [veteran], tenant.admin.userId)
    ).rejects.toThrow(/Junior or below/);
  });

  it("treats a task with no rules as satisfied", async () => {
    const task = await makeTask([], 2);
    const result = await composition.evaluateForTask(task.id, [await addStaff("free")]);
    expect(result.satisfied).toBe(true);
    expect(result.rules).toEqual([]);
  });
});

describe("the assignment gate", () => {
  it("allows the first of two juniors and refuses the second", async () => {
    const a = await addStaff("junior-a");
    const b = await addStaff("junior-b");
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);

    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [a], tenant.admin.userId)
    ).resolves.toBeDefined();

    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [b], tenant.admin.userId)
    ).rejects.toThrow(/At most 1 assignee at Junior or below/);
  });

  it("refuses a single batch that breaks the rule outright", async () => {
    const a = await addStaff("batch-a");
    const b = await addStaff("batch-b");
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);

    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [a, b], tenant.admin.userId)
    ).rejects.toThrow(/composition rule/);

    expect(await prisma.taskAssignment.count({ where: { taskId: task.id } })).toBe(0);
  });

  it("allows a junior alongside an experienced colleague", async () => {
    const junior = await addStaff("mixed-junior");
    const senior = await addStaff("mixed-senior");
    await giveWorkedShifts(senior, 40);
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);

    await taskService.assignStaff(task.id, tenant.orgId, [junior], tenant.admin.userId);
    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [senior], tenant.admin.userId)
    ).resolves.toBeDefined();
  });

  // The reason feasibility is not satisfaction: filling a shift one person at a
  // time must not be refused on the first person for a rule the second meets.
  it("does not refuse the first assignment on an unmet at_least rule", async () => {
    const plain = await addStaff("no-cert");
    const task = await makeTask([AT_LEAST_ONE_FIRST_AID], 2);

    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [plain], tenant.admin.userId)
    ).resolves.toBeDefined();
  });

  it("refuses the assignment that would leave no slot for an at_least rule", async () => {
    const first = await addStaff("plain-1");
    const second = await addStaff("plain-2");
    const task = await makeTask([AT_LEAST_ONE_FIRST_AID], 2);

    await taskService.assignStaff(task.id, tenant.orgId, [first], tenant.admin.userId);
    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [second], tenant.admin.userId)
    ).rejects.toThrow(/First Aid/);
  });

  it("allows the last slot to be filled by someone who meets the rule", async () => {
    const first = await addStaff("plain-3");
    const holder = await addStaff("holder");
    await certify(holder, "first aid");
    const task = await makeTask([AT_LEAST_ONE_FIRST_AID], 2);

    await taskService.assignStaff(task.id, tenant.orgId, [first], tenant.admin.userId);
    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [holder], tenant.admin.userId)
    ).resolves.toBeDefined();
  });

  it("enforces an employment type rule", async () => {
    const casual = await addStaff("casual-1", "casual");
    const second = await addStaff("casual-2", "casual");
    const task = await makeTask(
      [{ kind: "employment_type", value: "full_time", comparator: "at_least", count: 1 }],
      2
    );

    await taskService.assignStaff(task.id, tenant.orgId, [casual], tenant.admin.userId);
    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [second], tenant.admin.userId)
    ).rejects.toThrow(/Full-time/);
  });

  it("does not gate a task that carries no rules", async () => {
    const a = await addStaff("ungated-a");
    const b = await addStaff("ungated-b");
    const task = await makeTask([], 2);

    await taskService.assignStaff(task.id, tenant.orgId, [a], tenant.admin.userId);
    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [b], tenant.admin.userId)
    ).resolves.toBeDefined();
  });

  it("honours a pinned seniority over the shift count", async () => {
    const junior = await addStaff("pinned-junior");
    const pinned = await addStaff("pinned-senior");
    await seniority.setOverride(tenant.orgId, pinned, "senior", tenant.admin.userId);
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);

    await taskService.assignStaff(task.id, tenant.orgId, [junior], tenant.admin.userId);
    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [pinned], tenant.admin.userId)
    ).resolves.toBeDefined();
  });
});

describe("the override escape hatch", () => {
  async function override(taskId: string, membershipId: string, rule: string) {
    await prisma.eligibilityOverride.create({
      data: {
        taskId,
        membershipId,
        overriddenById: tenant.admin.userId,
        ruleOverridden: rule,
        reason: "Trainee shadowing a supervisor",
      },
    });
  }

  it("lets a documented override through", async () => {
    const a = await addStaff("ov-a");
    const b = await addStaff("ov-b");
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);

    await taskService.assignStaff(task.id, tenant.orgId, [a], tenant.admin.userId);
    await override(task.id, b, "composition");

    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [b], tenant.admin.userId)
    ).resolves.toBeDefined();
  });

  it("accepts a blanket 'all' override too", async () => {
    const a = await addStaff("all-a");
    const b = await addStaff("all-b");
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);

    await taskService.assignStaff(task.id, tenant.orgId, [a], tenant.admin.userId);
    await override(task.id, b, "all");

    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [b], tenant.admin.userId)
    ).resolves.toBeDefined();
  });

  // An override is granted for a person on a task. One waived elsewhere must
  // not travel.
  it("does not accept an override recorded against a different rule", async () => {
    const a = await addStaff("wrong-rule-a");
    const b = await addStaff("wrong-rule-b");
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);

    await taskService.assignStaff(task.id, tenant.orgId, [a], tenant.admin.userId);
    await override(task.id, b, "availability");

    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [b], tenant.admin.userId)
    ).rejects.toThrow(/composition rule|Junior or below/);
  });

  it("does not accept an override belonging to another task", async () => {
    const a = await addStaff("other-task-a");
    const b = await addStaff("other-task-b");
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);
    const elsewhere = await makeTask([AT_MOST_ONE_JUNIOR], 2);

    await taskService.assignStaff(task.id, tenant.orgId, [a], tenant.admin.userId);
    await override(elsewhere.id, b, "composition");

    await expect(
      taskService.assignStaff(task.id, tenant.orgId, [b], tenant.admin.userId)
    ).rejects.toThrow(/composition rule|Junior or below/);
  });
});

describe("storing rules on a task", () => {
  it("keeps rules through a partial update that does not mention them", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);
    await taskService.update(task.id, tenant.orgId, { priority: "high" });

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.compositionRules).toContain("at_most");
  });

  it("clears rules when an empty list is sent", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);
    await taskService.update(task.id, tenant.orgId, { compositionRules: [] });

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.compositionRules).toBeNull();
  });

  it("replaces rules wholesale when a new list is sent", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR], 2);
    await taskService.update(task.id, tenant.orgId, {
      compositionRules: [AT_LEAST_ONE_FIRST_AID],
    });

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.compositionRules).toContain("First Aid");
    expect(after.compositionRules).not.toContain("at_most");
  });
});
