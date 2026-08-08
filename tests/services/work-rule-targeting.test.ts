/**
 * Which work rules apply to which member.
 *
 * A rule can name a department, a custom role, both, or neither. That choice is
 * the difference between "kitchen staff need eleven hours off" and "everybody
 * does", and it is made once in `filterApplicableRules` and shared by the
 * eligibility engine and the hour-limit alerting — so a fault here is a fault in
 * both at once.
 *
 * It had no test coverage. The rules themselves were checked from every angle;
 * the question of whether a given rule was ever consulted for a given person was
 * not asked. These go through `checkEligibilityForTask`, not the filter
 * directly, so they exercise rule loading and targeting the way the assign
 * screen does.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EligibilityService } from "@/services/eligibility.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { sgt } from "../helpers/time";

const eligibility = new EligibilityService();

let tenant: Tenant;
let otherDept: { id: string };
let trainees: { id: string };

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("ruletarget");

  otherDept = await prisma.department.create({
    data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
  });
  trainees = await prisma.role.create({
    data: {
      organizationId: tenant.orgId,
      name: "trainees",
      displayLabel: "Trainees",
    },
  });

  // Full-time so availability stays out of the way, and the org break rule
  // lifted so only the work rule under test can refuse anything.
  await prisma.membership.update({
    where: { id: tenant.staff.membershipId },
    data: { employmentType: "full_time" },
  });
  await prisma.companySettings.upsert({
    where: { organizationId: tenant.orgId },
    create: { organizationId: tenant.orgId, workingDayHours: 1000 },
    update: { workingDayHours: 1000 },
  });
});

/** A rule that refuses any shift longer than an hour, targeted as given. */
async function dailyCapRule(target: {
  departmentId?: string | null;
  roleId?: string | null;
}) {
  return prisma.workRule.create({
    data: {
      organizationId: tenant.orgId,
      name: `cap-${Math.random().toString(36).slice(2, 8)}`,
      type: "max_hours_daily",
      maxHours: 1,
      departmentId: target.departmentId ?? null,
      roleId: target.roleId ?? null,
      isActive: true,
    },
  });
}

/** An 8h shift in the fixture's department, and the staff member's verdict. */
async function verdictForStaff() {
  const task = await prisma.task.create({
    data: {
      title: "Long shift",
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: 1,
      status: "open",
      scheduledStart: sgt("2026-09-10T09:00"),
      scheduledEnd: sgt("2026-09-10T17:00"),
    },
  });
  const results = await eligibility.checkEligibilityForTask(task.id, tenant.orgId);
  const mine = results.find((r) => r.membershipId === tenant.staff.membershipId);
  if (!mine) throw new Error("staff member missing from eligibility result");
  return mine.checks.workRules;
}

async function giveStaffCustomRole(roleId: string | null) {
  await prisma.membership.update({
    where: { id: tenant.staff.membershipId },
    data: { customRoleId: roleId },
  });
}

describe("a rule naming nothing applies to everyone", () => {
  it("refuses the shift", async () => {
    await dailyCapRule({});
    expect((await verdictForStaff()).eligible).toBe(false);
  });
});

describe("a rule naming a department", () => {
  it("applies to a member of that department", async () => {
    await dailyCapRule({ departmentId: tenant.departmentId });
    expect((await verdictForStaff()).eligible).toBe(false);
  });

  it("does not apply to a member outside it", async () => {
    await dailyCapRule({ departmentId: otherDept.id });
    expect((await verdictForStaff()).eligible).toBe(true);
  });

  // A member may hold several departments, and holding ONE named by the rule is
  // enough — the same union semantics as department scoping everywhere else.
  it("applies to a member who holds it alongside another", async () => {
    await prisma.departmentMembership.create({
      data: {
        membershipId: tenant.staff.membershipId,
        departmentId: otherDept.id,
      },
    });
    await dailyCapRule({ departmentId: otherDept.id });
    expect((await verdictForStaff()).eligible).toBe(false);
  });
});

describe("a rule naming a custom role", () => {
  it("applies to a member holding it", async () => {
    await giveStaffCustomRole(trainees.id);
    await dailyCapRule({ roleId: trainees.id });
    expect((await verdictForStaff()).eligible).toBe(false);
  });

  it("does not apply to a member with no custom role", async () => {
    await dailyCapRule({ roleId: trainees.id });
    expect((await verdictForStaff()).eligible).toBe(true);
  });

  it("does not apply to a member holding a different custom role", async () => {
    const other = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "seniors",
        displayLabel: "Seniors",
      },
    });
    await giveStaffCustomRole(other.id);
    await dailyCapRule({ roleId: trainees.id });
    expect((await verdictForStaff()).eligible).toBe(true);
  });
});

describe("a rule naming both", () => {
  // AND, not OR. Matching one of the two must not be enough, or a rule written
  // for "trainees in the kitchen" quietly becomes one for every trainee.
  it("applies only when the member matches both", async () => {
    await giveStaffCustomRole(trainees.id);
    await dailyCapRule({ departmentId: tenant.departmentId, roleId: trainees.id });
    expect((await verdictForStaff()).eligible).toBe(false);
  });

  it("does not apply on the role alone", async () => {
    await giveStaffCustomRole(trainees.id);
    await dailyCapRule({ departmentId: otherDept.id, roleId: trainees.id });
    expect((await verdictForStaff()).eligible).toBe(true);
  });

  it("does not apply on the department alone", async () => {
    await dailyCapRule({ departmentId: tenant.departmentId, roleId: trainees.id });
    expect((await verdictForStaff()).eligible).toBe(true);
  });
});

describe("an inactive rule is not consulted", () => {
  it("allows the shift a paused rule would refuse", async () => {
    const rule = await dailyCapRule({});
    await prisma.workRule.update({
      where: { id: rule.id },
      data: { isActive: false },
    });
    expect((await verdictForStaff()).eligible).toBe(true);
  });
});

/*
 * What USED to happen when a rule's target was deleted lived here.
 *
 * `WorkRule.roleId` and `departmentId` were `onDelete: SetNull`, and a rule with
 * neither target set reads as GLOBAL — so deleting a role silently promoted
 * every rule that named it to the whole organisation. These tests pinned that
 * as observed behaviour, with a comment saying it was not the behaviour anyone
 * would choose.
 *
 * Both foreign keys are `Restrict` now, so the delete is refused instead and
 * the ambiguity cannot arise. The replacement lives in
 * `work-rule-target-deletion.test.ts`, which asserts the refusal at both layers
 * — the service message and the database constraint — and, from the other side,
 * that a targeted rule never comes to apply to someone outside its target.
 */
