/**
 * What `describeForTask` sends the assign panel.
 *
 * The pure half is in tests/lib/composition-annotations.test.ts. What only
 * breaks with real data is the POPULATION: this method and the eligibility
 * engine each decide who a task's candidates are, and they must agree. Two
 * implementations of one rule is the drift risk, and this file is the thing
 * that catches it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CompositionService } from "@/services/composition.service";
import { EligibilityService } from "@/services/eligibility.service";
import {
  serialiseCompositionRules,
  type CompositionRule,
} from "@/lib/composition-rules";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const composition = new CompositionService();
const eligibility = new EligibilityService();

const AT_MOST_ONE_JUNIOR: CompositionRule = {
  kind: "seniority",
  value: "junior",
  comparator: "at_most",
  count: 1,
};

let tenant: Tenant;
let otherDeptId: string;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("annot");

  const other = await prisma.department.create({
    data: { name: "Front of House", organizationId: tenant.orgId, color: "#3B82F6" },
  });
  otherDeptId = other.id;
});

async function addStaff(label: string, departmentId: string | null) {
  const user = await prisma.user.create({
    data: { name: label, email: `${label}@annot.test`, hashedPassword: "h" },
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: tenant.orgId,
      role: "staff",
      status: "active",
    },
  });
  if (departmentId) {
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId },
    });
  }
  return membership.id;
}

async function makeTask(rules: CompositionRule[] | null, headcount = 2) {
  return prisma.task.create({
    data: {
      title: "Evening shift",
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: headcount,
      compositionRules: rules ? serialiseCompositionRules(rules) : null,
    },
  });
}

describe("describeForTask", () => {
  it("returns the task's rules parsed, so the panel need not re-parse them", async () => {
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);

    const described = await composition.describeForTask(task.id, tenant.orgId);

    expect(described.rules).toHaveLength(1);
    expect(described.rules[0].kind).toBe("seniority");
    expect(described.requiredHeadcount).toBe(2);
  });

  it("describes each candidate with what the rules look at", async () => {
    const member = await addStaff("kitchen", tenant.departmentId);
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);

    const described = await composition.describeForTask(task.id, tenant.orgId);
    const described_member = described.members.find(
      (m) => m.membershipId === member
    );

    expect(described_member).toBeDefined();
    expect(described_member!.seniority).toBe("junior");
    expect(described_member!.certifications).toEqual([]);
  });

  it("names who is already occupying a slot", async () => {
    const member = await addStaff("kitchen", tenant.departmentId);
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: member,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    const described = await composition.describeForTask(task.id, tenant.orgId);
    expect(described.assignedMembershipIds).toEqual([member]);
  });

  // Rejected and withdrawn rows do not hold a seat, so a rule judging the shift
  // must not count the people on them.
  it("leaves out somebody who turned the shift down", async () => {
    const member = await addStaff("kitchen", tenant.departmentId);
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: member,
        assignedById: tenant.admin.userId,
        status: "rejected",
      },
    });

    const described = await composition.describeForTask(task.id, tenant.orgId);
    expect(described.assignedMembershipIds).toEqual([]);
  });

  /*
   * Describing every member of a rule-less task would be three queries for a
   * panel that renders none of it, and the panel hides the section on an empty
   * rule list anyway.
   */
  it("does no work for a task with no rules", async () => {
    await addStaff("kitchen", tenant.departmentId);
    const task = await makeTask(null);

    const described = await composition.describeForTask(task.id, tenant.orgId);

    expect(described.rules).toEqual([]);
    expect(described.members).toEqual([]);
  });

  it("refuses another organisation's task", async () => {
    const other = await createTenant("annot-other");
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);

    await expect(
      composition.describeForTask(task.id, other.orgId)
    ).rejects.toThrow("Task not found");
  });
});

describe("the population matches the eligibility engine's", () => {
  /*
   * Two implementations of one rule, asserted equal rather than shared.
   *
   * Extracting the filter would have meant refactoring the middle of a heavily
   * tested engine; pinning the agreement costs nothing and fails loudly if
   * either side moves. If this goes red, the engine's filter changed and
   * `describeForTask` has to follow it.
   */
  async function bothPopulations(taskId: string) {
    const described = await composition.describeForTask(taskId, tenant.orgId);
    const verdicts = await eligibility.checkEligibilityForTask(
      taskId,
      tenant.orgId
    );
    return {
      annotated: described.members.map((m) => m.membershipId).sort(),
      evaluated: verdicts.map((v) => v.membershipId).sort(),
    };
  }

  it("agrees on a department-scoped task", async () => {
    await addStaff("kitchen-a", tenant.departmentId);
    await addStaff("kitchen-b", tenant.departmentId);
    await addStaff("front", otherDeptId);
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);

    const { annotated, evaluated } = await bothPopulations(task.id);
    expect(annotated).toEqual(evaluated);
  });

  // The case that made the engine widen its filter: a task moved between
  // departments leaves its assignees behind, and a rule judging the shift has
  // to see them even though they are now out of scope.
  it("agrees when somebody outside the department is already assigned", async () => {
    await addStaff("kitchen-a", tenant.departmentId);
    const outsider = await addStaff("front", otherDeptId);
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: outsider,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    const { annotated, evaluated } = await bothPopulations(task.id);
    expect(annotated).toEqual(evaluated);
    expect(annotated).toContain(outsider);
  });

  it("agrees on a task with no department", async () => {
    await addStaff("kitchen-a", tenant.departmentId);
    await addStaff("front", otherDeptId);
    const task = await prisma.task.create({
      data: {
        title: "Org-wide shift",
        organizationId: tenant.orgId,
        departmentId: null,
        createdById: tenant.admin.userId,
        requiredHeadcount: 2,
        compositionRules: serialiseCompositionRules([AT_MOST_ONE_JUNIOR]),
      },
    });

    const { annotated, evaluated } = await bothPopulations(task.id);
    expect(annotated).toEqual(evaluated);
  });

  it("agrees that a deactivated member is in neither", async () => {
    const gone = await addStaff("left", tenant.departmentId);
    await prisma.membership.update({
      where: { id: gone },
      data: { status: "inactive" },
    });
    const task = await makeTask([AT_MOST_ONE_JUNIOR]);

    const { annotated, evaluated } = await bothPopulations(task.id);
    expect(annotated).toEqual(evaluated);
    expect(annotated).not.toContain(gone);
  });
});
