/**
 * Deleting a role or department that work rules target.
 *
 * ## The bug this closes
 *
 * A rule with NEITHER target set means "everybody" — that is how a global rule
 * is expressed. Both foreign keys were `onDelete: SetNull`, so deleting the
 * role or department a rule pointed at blanked the reference and the rule
 * silently became org-wide. "Trainees need 11 hours off after a long shift"
 * quietly turned into "everyone does".
 *
 * The ambiguity is the fault: blank cannot mean both "I meant everyone" and "my
 * target was deleted". It failed in the safe direction — a widened rule refuses
 * MORE rostering, never less — but it surfaced as managers unable to roster
 * people for reasons that made no sense, with nothing in the data explaining
 * why. `work-rule-targeting.test.ts` pinned that behaviour as it stood; this
 * file replaces it.
 *
 * ## Two layers, deliberately
 *
 * The service checks first and refuses with a message naming the rules, so an
 * admin gets a sentence they can act on. The database constraint is Restrict as
 * well, so a path that forgets the check still cannot produce the ambiguity.
 * Both are tested — the second is what makes the first a convenience rather
 * than the only thing standing between the data and a silent widening.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RoleService } from "@/services/role.service";
import { DepartmentService } from "@/services/department.service";
import { EligibilityService } from "@/services/eligibility.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { sgt } from "../helpers/time";

const roleService = new RoleService();
const deptService = new DepartmentService();
const eligibility = new EligibilityService();

let tenant: Tenant;
let trainees: { id: string };
let bar: { id: string };

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("targetdel");

  trainees = await prisma.role.create({
    data: {
      organizationId: tenant.orgId,
      name: "trainees",
      displayLabel: "Trainees",
    },
  });
  bar = await prisma.department.create({
    data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
  });
});

async function rule(
  name: string,
  target: { roleId?: string; departmentId?: string }
) {
  return prisma.workRule.create({
    data: {
      organizationId: tenant.orgId,
      name,
      type: "max_hours_daily",
      maxHours: 1,
      roleId: target.roleId ?? null,
      departmentId: target.departmentId ?? null,
      isActive: true,
    },
  });
}

/** `bar` archived, which department deletion requires first. */
async function archiveBar() {
  await deptService.archive(bar.id, tenant.orgId, tenant.admin.userId);
}

describe("deleting a role that work rules target", () => {
  it("is refused", async () => {
    await rule("Trainee rest", { roleId: trainees.id });

    await expect(
      roleService.delete(trainees.id, tenant.orgId, tenant.admin.userId)
    ).rejects.toThrow(/Cannot delete/);
  });

  // Names, not a count. "3 work rules target this role" says there is a problem
  // and nothing about how to solve it.
  it("names the rules standing in the way", async () => {
    await rule("Trainee rest", { roleId: trainees.id });
    await rule("Trainee daily cap", { roleId: trainees.id });

    const message = await roleService
      .delete(trainees.id, tenant.orgId, tenant.admin.userId)
      .catch((e: Error) => e.message);

    expect(message).toContain("Trainee rest");
    expect(message).toContain("Trainee daily cap");
    expect(message).toContain("2 work rules");
  });

  it("reads correctly for a single rule", async () => {
    await rule("Trainee rest", { roleId: trainees.id });

    const message = await roleService
      .delete(trainees.id, tenant.orgId, tenant.admin.userId)
      .catch((e: Error) => e.message);

    expect(message).toContain("1 work rule targets");
    expect(message).not.toContain("work rules");
  });

  it("leaves the role in place", async () => {
    await rule("Trainee rest", { roleId: trainees.id });
    await roleService
      .delete(trainees.id, tenant.orgId, tenant.admin.userId)
      .catch(() => undefined);

    expect(await prisma.role.findUnique({ where: { id: trainees.id } })).not.toBeNull();
  });

  it("allows the delete once the rule is retargeted", async () => {
    const r = await rule("Trainee rest", { roleId: trainees.id });
    await prisma.workRule.update({
      where: { id: r.id },
      data: { roleId: null, departmentId: bar.id },
    });

    await roleService.delete(trainees.id, tenant.orgId, tenant.admin.userId);
    expect(await prisma.role.findUnique({ where: { id: trainees.id } })).toBeNull();
  });

  it("still deletes a role nothing targets", async () => {
    await roleService.delete(trainees.id, tenant.orgId, tenant.admin.userId);
    expect(await prisma.role.findUnique({ where: { id: trainees.id } })).toBeNull();
  });

  // A rule targeting a DIFFERENT role must not block this one.
  it("ignores rules pointing elsewhere", async () => {
    const other = await prisma.role.create({
      data: { organizationId: tenant.orgId, name: "seniors", displayLabel: "Seniors" },
    });
    await rule("Senior rest", { roleId: other.id });

    await roleService.delete(trainees.id, tenant.orgId, tenant.admin.userId);
    expect(await prisma.role.findUnique({ where: { id: trainees.id } })).toBeNull();
  });
});

describe("deleting a department that work rules target", () => {
  it("is refused", async () => {
    await rule("Bar rest", { departmentId: bar.id });
    await archiveBar();

    await expect(
      deptService.delete(bar.id, tenant.orgId, tenant.admin.userId)
    ).rejects.toThrow(/Cannot delete/);
  });

  it("names the rule", async () => {
    await rule("Bar rest", { departmentId: bar.id });
    await archiveBar();

    const message = await deptService
      .delete(bar.id, tenant.orgId, tenant.admin.userId)
      .catch((e: Error) => e.message);

    expect(message).toContain("Bar rest");
  });

  it("still deletes a department nothing targets", async () => {
    await archiveBar();
    await deptService.delete(bar.id, tenant.orgId, tenant.admin.userId);

    expect(await prisma.department.findUnique({ where: { id: bar.id } })).toBeNull();
  });
});

describe("the database refuses it too", () => {
  /*
   * The service check is a courtesy — it exists so an admin sees a sentence
   * instead of a 500. This is the guarantee: a path that skips the check, or a
   * hand-run DELETE, still cannot leave a rule pointing at nothing.
   */
  it("refuses a raw delete of a targeted role", async () => {
    await rule("Trainee rest", { roleId: trainees.id });

    await expect(
      prisma.role.delete({ where: { id: trainees.id } })
    ).rejects.toThrow();
  });

  it("refuses a raw delete of a targeted department", async () => {
    await rule("Bar rest", { departmentId: bar.id });

    await expect(
      prisma.department.delete({ where: { id: bar.id } })
    ).rejects.toThrow();
  });
});

describe("the widening this prevents", () => {
  /*
   * The behaviour the old schema produced, asserted from the other side: a
   * targeted rule must never come to apply to someone it was not written for.
   *
   * Under `SetNull`, deleting Trainees left the rule with no role — which
   * `filterApplicableRules` reads as global — and this staff member, who holds
   * no custom role at all, became subject to it. The rule now cannot be
   * orphaned, so they stay outside it.
   */
  it("never makes a targeted rule apply to someone outside the target", async () => {
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { employmentType: "full_time" },
    });
    await prisma.companySettings.upsert({
      where: { organizationId: tenant.orgId },
      create: { organizationId: tenant.orgId, workingDayHours: 1000 },
      update: { workingDayHours: 1000 },
    });
    await rule("Trainee daily cap", { roleId: trainees.id });

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

    const before = await eligibility.checkEligibilityForTask(task.id, tenant.orgId);
    expect(
      before.find((r) => r.membershipId === tenant.staff.membershipId)?.checks
        .workRules.eligible
    ).toBe(true);

    // The delete that used to orphan the rule is now refused outright.
    await expect(
      roleService.delete(trainees.id, tenant.orgId, tenant.admin.userId)
    ).rejects.toThrow(/Cannot delete/);

    const after = await eligibility.checkEligibilityForTask(task.id, tenant.orgId);
    expect(
      after.find((r) => r.membershipId === tenant.staff.membershipId)?.checks
        .workRules.eligible
    ).toBe(true);
  });
});
