/**
 * Foreign ids written INTO a local row.
 *
 * The audit of by-id handlers came back clean: every route that reads or
 * mutates a resource proves it belongs to the caller's organisation first. This
 * is the other direction, and it had no checks at all — ids arriving in a
 * request BODY, written straight through as foreign keys.
 *
 * A scoped manager is stopped by `isDepartmentInScope` at the route, so the
 * reachable case is a company admin, whose scope is null. Not remotely
 * exploitable — it needs a cuid from another tenant — but the consequences are
 * real, and the check costs one lookup:
 *
 *   task.departmentId  → every task read select includes the department's name
 *                        and colour, so ANOTHER TENANT'S department name comes
 *                        back inside this org's task payloads. The task also
 *                        falls out of every department-scoped view and is
 *                        judged against the wrong department's work rules.
 *
 *   workRule.roleId /   → the rule matches nobody, so it looks broken. Worse,
 *   workRule.departmentId  both FKs are `onDelete: SetNull` and a rule with no
 *                        target reads as GLOBAL — so if the foreign row is ever
 *                        deleted, the inert rule silently becomes a rule for
 *                        everybody here.
 *
 * `EligibilityService.createOverride` already did this for `membershipId`.
 * These were the paths still missing it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskService } from "@/services/task.service";
import { WorkRuleService } from "@/services/work-rule.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const taskService = new TaskService();
const workRuleService = new WorkRuleService();

let ours: Tenant;
let theirs: Tenant;
/** A custom role belonging to the OTHER tenant. */
let foreignRole: { id: string };

beforeEach(async () => {
  await cleanDatabase();
  ours = await createTenant("ours");
  theirs = await createTenant("theirs");
  foreignRole = await prisma.role.create({
    data: {
      organizationId: theirs.orgId,
      name: "their-role",
      displayLabel: "Their Role",
    },
  });
});

describe("a task cannot be filed under another tenant's department", () => {
  it("refuses it on create", async () => {
    await expect(
      taskService.create(
        {
          title: "Evening service",
          departmentId: theirs.departmentId,
          requiredHeadcount: 1,
        } as Parameters<typeof taskService.create>[0],
        ours.orgId,
        ours.admin.userId
      )
    ).rejects.toThrow("Department not found");
  });

  it("refuses it on update", async () => {
    const task = await taskService.create(
      { title: "Evening service", requiredHeadcount: 1 } as Parameters<
        typeof taskService.create
      >[0],
      ours.orgId,
      ours.admin.userId
    );

    await expect(
      taskService.update(task.id, ours.orgId, {
        departmentId: theirs.departmentId,
      } as Parameters<typeof taskService.update>[2])
    ).rejects.toThrow("Department not found");
  });

  // Reported as missing, not forbidden — otherwise the endpoint answers
  // "does this id exist in some other organisation?"
  it("gives the same answer as a department that does not exist", async () => {
    const forForeign = await taskService
      .create(
        { title: "A", departmentId: theirs.departmentId, requiredHeadcount: 1 } as Parameters<
          typeof taskService.create
        >[0],
        ours.orgId,
        ours.admin.userId
      )
      .catch((e: Error) => e.message);
    const forFake = await taskService
      .create(
        { title: "B", departmentId: "nope", requiredHeadcount: 1 } as Parameters<
          typeof taskService.create
        >[0],
        ours.orgId,
        ours.admin.userId
      )
      .catch((e: Error) => e.message);

    expect(forForeign).toBe(forFake);
  });

  it("still accepts our own department", async () => {
    const task = await taskService.create(
      {
        title: "Evening service",
        departmentId: ours.departmentId,
        requiredHeadcount: 1,
      } as Parameters<typeof taskService.create>[0],
      ours.orgId,
      ours.admin.userId
    );
    expect(task.departmentId).toBe(ours.departmentId);
  });

  // Clearing the department is not a foreign write and must stay possible.
  it("still allows clearing the department", async () => {
    const task = await taskService.create(
      {
        title: "Evening service",
        departmentId: ours.departmentId,
        requiredHeadcount: 1,
      } as Parameters<typeof taskService.create>[0],
      ours.orgId,
      ours.admin.userId
    );

    const updated = await taskService.update(task.id, ours.orgId, {
      departmentId: null,
    } as Parameters<typeof taskService.update>[2]);
    expect(updated.departmentId).toBeNull();
  });
});

describe("a work rule cannot target another tenant's department or role", () => {
  const base = {
    name: "Daily rest",
    type: "break_interval" as const,
    hoursThreshold: 8,
    breakHours: 11,
  };

  it("refuses a foreign department on create", async () => {
    await expect(
      workRuleService.create(
        { ...base, departmentId: theirs.departmentId } as Parameters<
          typeof workRuleService.create
        >[0],
        ours.orgId,
        ours.admin.userId
      )
    ).rejects.toThrow("Department not found");
  });

  it("refuses a foreign role on create", async () => {
    await expect(
      workRuleService.create(
        { ...base, roleId: foreignRole.id } as Parameters<
          typeof workRuleService.create
        >[0],
        ours.orgId,
        ours.admin.userId
      )
    ).rejects.toThrow("Role not found");
  });

  it("refuses a foreign target on update", async () => {
    const rule = await workRuleService.create(
      base as Parameters<typeof workRuleService.create>[0],
      ours.orgId,
      ours.admin.userId
    );

    await expect(
      workRuleService.update(
        rule.id,
        ours.orgId,
        { departmentId: theirs.departmentId } as Parameters<
          typeof workRuleService.update
        >[2],
        ours.admin.userId
      )
    ).rejects.toThrow("Department not found");
  });

  it("still accepts our own targets", async () => {
    const ownRole = await prisma.role.create({
      data: {
        organizationId: ours.orgId,
        name: "trainees",
        displayLabel: "Trainees",
      },
    });

    const rule = await workRuleService.create(
      {
        ...base,
        departmentId: ours.departmentId,
        roleId: ownRole.id,
      } as Parameters<typeof workRuleService.create>[0],
      ours.orgId,
      ours.admin.userId
    );

    expect(rule.departmentId).toBe(ours.departmentId);
    expect(rule.roleId).toBe(ownRole.id);
  });

  // A global rule names neither, which must not be mistaken for a missing one.
  it("still accepts a rule that targets nothing", async () => {
    const rule = await workRuleService.create(
      base as Parameters<typeof workRuleService.create>[0],
      ours.orgId,
      ours.admin.userId
    );
    expect(rule.departmentId).toBeNull();
    expect(rule.roleId).toBeNull();
  });
});
