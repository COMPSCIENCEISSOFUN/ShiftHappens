/**
 * Four things that could be destroyed by somebody who had every right to try.
 *
 * None of these were permission gaps — the caller was always allowed to make
 * the request. They are places where the system agreed to something whose
 * consequences reached further than the action described.
 *
 * Deleting a task cascaded into completed assignments, which are the evidence
 * seniority is derived from — so removing last month's shifts silently demoted
 * people, changing who a composition rule would admit onto future ones.
 * Deleting a department left its tasks with no department, and a
 * department-less task means ORG-WIDE work, so blank came to mean two different
 * things. A member could delete leave a manager had granted. And the role
 * builder offered a permission the subscription plan can never honour.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { DELETE as deleteTask } from "@/app/api/organizations/[orgId]/tasks/[taskId]/route";
import { DELETE as deleteOverrideRoute } from "@/app/api/organizations/[orgId]/availability/overrides/[overrideId]/route";
import { TaskService } from "@/services/task.service";
import { DepartmentService } from "@/services/department.service";
import { AvailabilityService } from "@/services/availability.service";
import { RoleService } from "@/services/role.service";
import { asUser } from "../helpers/session";
import { ctx, req, bodyOf } from "../helpers/route";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const tasks = new TaskService();
const departments = new DepartmentService();
const availability = new AvailabilityService();
const roles = new RoleService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("guards");
});

async function makeTask(departmentId: string | null = tenant.departmentId) {
  return prisma.task.create({
    data: {
      organizationId: tenant.orgId,
      departmentId,
      createdById: tenant.admin.userId,
      title: "Evening service",
      status: "open",
      scheduledStart: new Date(Date.now() + 5 * 86_400_000),
      scheduledEnd: new Date(Date.now() + 5 * 86_400_000 + 4 * 3_600_000),
    },
  });
}

describe("deleting a task somebody worked", () => {
  async function assign(taskId: string, extra: Record<string, unknown> = {}) {
    return prisma.taskAssignment.create({
      data: {
        taskId,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "accepted",
        ...extra,
      },
    });
  }

  it("is refused when the shift was completed", async () => {
    const task = await makeTask();
    await assign(task.id, { status: "completed" });

    await expect(tasks.delete(task.id, tenant.orgId)).rejects.toThrow(
      /cancel it instead/
    );
  });

  /*
   * `clocked_out` counts as worked as well as `completed`. The final
   * confirmation is a button somebody has to remember to press, and the
   * seniority derivation already treats the two the same way — a guard that
   * disagreed with it would protect a different set of rows than the one that
   * matters.
   */
  it("is refused when the shift was clocked out but never confirmed", async () => {
    const task = await makeTask();
    await assign(task.id, { status: "clocked_out" });

    await expect(tasks.delete(task.id, tenant.orgId)).rejects.toThrow(
      /cancel it instead/
    );
  });

  // A shift in progress is `accepted` with a clock-in, not a status of its own.
  it("is refused while somebody is still on the shift", async () => {
    const task = await makeTask();
    await assign(task.id, { status: "accepted", clockInTime: new Date() });

    await expect(tasks.delete(task.id, tenant.orgId)).rejects.toThrow(
      /cancel it instead/
    );
  });

  it("leaves the task and its history in place when it refuses", async () => {
    const task = await makeTask();
    await assign(task.id, { status: "completed" });

    await tasks.delete(task.id, tenant.orgId).catch(() => {});

    expect(await prisma.task.findUnique({ where: { id: task.id } })).not.toBeNull();
    expect(await prisma.taskAssignment.count({ where: { taskId: task.id } })).toBe(1);
  });

  /*
   * The reason a guard was chosen over an archive column. A shift created by
   * mistake and never worked should stay deletable — a permanent record of
   * typos helps nobody.
   */
  it("still allows deleting a shift nobody worked", async () => {
    const task = await makeTask();
    await tasks.delete(task.id, tenant.orgId);

    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
  });

  it("still allows deleting a shift somebody merely accepted", async () => {
    const task = await makeTask();
    await assign(task.id);

    await tasks.delete(task.id, tenant.orgId);
    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
  });

  // A rejected assignment is not work; it is a refusal to do the work.
  it("still allows deleting a shift somebody turned down", async () => {
    const task = await makeTask();
    await assign(task.id, { status: "rejected" });

    await tasks.delete(task.id, tenant.orgId);
    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
  });

  /*
   * 409 rather than 400 or 500. The request is well-formed and the caller is
   * permitted; the shift's own history refuses it, and the message names the
   * action that does work.
   */
  it("answers 409 over HTTP, with the action that works", async () => {
    const task = await makeTask();
    await assign(task.id, { status: "completed" });
    asUser(tenant.admin.userId);

    const res = await deleteTask(
      req("DELETE"),
      ctx({ orgId: tenant.orgId, taskId: task.id })
    );

    expect(res.status).toBe(409);
    expect(String((await bodyOf(res)).error)).toMatch(/cancel/i);
  });
});

describe("deleting a department that still holds shifts", () => {
  async function archived() {
    const dept = await prisma.department.create({
      data: {
        name: "Closing down",
        organizationId: tenant.orgId,
        archivedAt: new Date(),
      },
    });
    return dept;
  }

  it("is refused, and says how many", async () => {
    const dept = await archived();
    await makeTask(dept.id);

    await expect(
      departments.delete(dept.id, tenant.orgId, tenant.admin.userId)
    ).rejects.toThrow(/1 task still belongs/);
  });

  it("counts them rather than naming them", async () => {
    const dept = await archived();
    await makeTask(dept.id);
    await makeTask(dept.id);

    await expect(
      departments.delete(dept.id, tenant.orgId, tenant.admin.userId)
    ).rejects.toThrow(/2 tasks/);
  });

  it("leaves the department and its tasks alone", async () => {
    const dept = await archived();
    const task = await makeTask(dept.id);

    await departments
      .delete(dept.id, tenant.orgId, tenant.admin.userId)
      .catch(() => {});

    expect(await prisma.department.findUnique({ where: { id: dept.id } })).not.toBeNull();
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    /*
     * THE assertion. Under `SetNull` the task survived with a null department —
     * and a department-less task means ORG-WIDE work, so it silently widened
     * eligibility to the whole organisation and switched seniority from
     * per-department to org-wide, with nothing saying it had happened.
     */
    expect(after.departmentId).toBe(dept.id);
  });

  it("allows deletion once the shifts have moved", async () => {
    const dept = await archived();
    const task = await makeTask(dept.id);
    await prisma.task.update({
      where: { id: task.id },
      data: { departmentId: tenant.departmentId },
    });

    await departments.delete(dept.id, tenant.orgId, tenant.admin.userId);
    expect(await prisma.department.findUnique({ where: { id: dept.id } })).toBeNull();
  });
});

describe("deleting leave", () => {
  const DATE = new Date(Date.now() + 10 * 86_400_000).toISOString();

  async function fullTimer() {
    const user = await prisma.user.create({
      data: { name: "Sam", email: "sam@guards.test", hashedPassword: "h" },
    });
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: tenant.orgId,
        role: "staff",
        status: "active",
        employmentType: "full_time",
      },
    });
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: tenant.departmentId },
    });
    return { userId: user.id, membershipId: membership.id };
  }

  it("a member may withdraw a request nobody has answered", async () => {
    const sam = await fullTimer();
    const request = await availability.createOverride(sam.membershipId, {
      date: DATE,
      isAvailable: false,
    });

    await availability.deleteOverride(request.id, sam.membershipId);
    expect(
      await prisma.availabilityOverride.findUnique({ where: { id: request.id } })
    ).toBeNull();
  });

  it("but not leave a manager granted", async () => {
    const sam = await fullTimer();
    const request = await availability.createOverride(sam.membershipId, {
      date: DATE,
      isAvailable: false,
    });
    await availability.reviewLeave(
      request.id,
      "approved",
      tenant.admin.userId,
      tenant.orgId
    );

    await expect(
      availability.deleteOverride(request.id, sam.membershipId)
    ).rejects.toThrow(/only be changed by a manager/);
  });

  it("leaves the approval in place when it refuses", async () => {
    const sam = await fullTimer();
    const request = await availability.createOverride(sam.membershipId, {
      date: DATE,
      isAvailable: false,
    });
    await availability.reviewLeave(
      request.id,
      "approved",
      tenant.admin.userId,
      tenant.orgId
    );

    await availability.deleteOverride(request.id, sam.membershipId).catch(() => {});
    const after = await prisma.availabilityOverride.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.status).toBe("approved");
  });

  /*
   * The case the first version of this guard got wrong. A CASUAL member's
   * override is written `approved` the moment they save it, so testing the
   * status would have locked every casual out of their own date overrides —
   * taking back an offer is exactly what the endpoint is for. `reviewedById` is
   * the fact that matters: somebody else decided.
   */
  it("does not lock a casual out of their own dates", async () => {
    const override = await availability.createOverride(
      tenant.staff.membershipId,
      { date: DATE, isAvailable: false }
    );
    expect(override.status).toBe("approved");

    await availability.deleteOverride(override.id, tenant.staff.membershipId);
    expect(
      await prisma.availabilityOverride.findUnique({ where: { id: override.id } })
    ).toBeNull();
  });

  it("a refusal cannot be erased by the person it was told to", async () => {
    const sam = await fullTimer();
    const request = await availability.createOverride(sam.membershipId, {
      date: DATE,
      isAvailable: false,
    });
    await availability.reviewLeave(
      request.id,
      "rejected",
      tenant.admin.userId,
      tenant.orgId
    );

    /*
     * Refused, not because the row does anything — a rejected override is inert
     * — but because a manager DID decide, and the member erasing it removes the
     * record of having been told no. Asserted explicitly so the behaviour is a
     * choice rather than a side effect of testing `reviewedById`.
     */
    await expect(
      availability.deleteOverride(request.id, sam.membershipId)
    ).rejects.toThrow(/only be changed by a manager/);
  });

  it("answers 409 over HTTP", async () => {
    const sam = await fullTimer();
    const request = await availability.createOverride(sam.membershipId, {
      date: DATE,
      isAvailable: false,
    });
    await availability.reviewLeave(
      request.id,
      "approved",
      tenant.admin.userId,
      tenant.orgId
    );
    asUser(sam.userId);

    const res = await deleteOverrideRoute(
      req("DELETE"),
      ctx({ orgId: tenant.orgId, overrideId: request.id })
    );
    expect(res.status).toBe(409);
  });
});

describe("permissions the plan cannot honour", () => {
  /*
   * Enforcement was always correct — the route guard checks the plan BEFORE the
   * permission. The role builder just did not know, and rendered the entry as
   * an ordinary checkbox. Since custom roles are Pro-and-above while the audit
   * log is Enterprise-only, that box was a guaranteed no-op for every
   * organisation able to see it.
   */
  it("are marked unavailable on a plan that cannot honour them", async () => {
    // The fixture defaults to enterprise so feature gates do not mask
    // authorisation results elsewhere; this is the case that needs a lower one.
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { subscriptionTier: "pro" },
    });

    const catalogue = await roles.getAllPermissions(tenant.orgId);
    const audit = catalogue.find(
      (p: { name: string }) => p.name === "audit:view"
    ) as { available?: boolean; requiredTier?: string } | undefined;

    expect(audit?.available).toBe(false);
    expect(audit?.requiredTier).toBe("enterprise");
  });

  it("are available once the plan carries the feature", async () => {
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { subscriptionTier: "enterprise" },
    });

    const catalogue = await roles.getAllPermissions(tenant.orgId);
    const audit = catalogue.find(
      (p: { name: string }) => p.name === "audit:view"
    ) as { available?: boolean } | undefined;

    expect(audit?.available).toBe(true);
  });

  /*
   * Absent means "no plan question here", which is a different statement from
   * "your plan allows it" — so an ungated permission must not carry
   * `available: true` and invite the screen to treat the two the same.
   */
  it("say nothing at all about permissions no plan gates", async () => {
    const catalogue = await roles.getAllPermissions(tenant.orgId);
    const ordinary = catalogue.find(
      (p: { name: string }) => p.name === "tasks:create"
    ) as Record<string, unknown> | undefined;

    expect(ordinary).toBeDefined();
    expect(ordinary).not.toHaveProperty("available");
  });

  // The catalogue is still usable without an organisation — the shape only
  // gains the plan verdict when there is a plan to read.
  it("are returned unannotated when no organisation is named", async () => {
    const catalogue = await roles.getAllPermissions();
    expect(catalogue.length).toBeGreaterThan(0);
  });
});
