/**
 * The authorisation lookup every API route depends on.
 *
 * Exercised by the route contract suite, but tested directly here because the
 * two scope methods carry a caveat worth pinning: they answer "is this task in
 * the caller's DEPARTMENT scope", not "does it belong to their organisation".
 * A company admin gets `true` before the task is even loaded, so a cross-tenant
 * id passes unless the caller also does an org-scoped lookup.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AccessService } from "@/services/access.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const access = new AccessService();

let tenant: Tenant;
let other: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("acc");
  other = await createTenant("oth");
});

/** A task in `tenant`, optionally in a department. */
async function task(departmentId: string | null) {
  return prisma.task.create({
    data: {
      title: "Evening shift",
      organizationId: tenant.orgId,
      createdById: tenant.admin.userId,
      departmentId,
    },
  });
}

async function membershipOf(member: { membershipId: string }) {
  return prisma.membership.findFirstOrThrow({
    where: { id: member.membershipId },
    include: { departmentMemberships: { include: { department: true } } },
  });
}

describe("getMembership", () => {
  it("returns the membership for a member", async () => {
    const found = await access.getMembership(tenant.staff.userId, tenant.orgId);
    expect(found?.id).toBe(tenant.staff.membershipId);
  });

  it("returns null for a non-member", async () => {
    await expect(
      access.getMembership(tenant.outsider.userId, tenant.orgId)
    ).resolves.toBeNull();
  });

  it("returns null for a DEACTIVATED member", async () => {
    // The hole this service was created to close. Routes treat null as 403, so
    // a deactivated member must be indistinguishable from a stranger.
    await expect(
      access.getMembership(tenant.inactive.userId, tenant.orgId)
    ).resolves.toBeNull();
  });

  it("returns null when the user belongs to a different organisation", async () => {
    await expect(
      access.getMembership(other.staff.userId, tenant.orgId)
    ).resolves.toBeNull();
  });
});

describe("isOrgActive", () => {
  it("is true for an active organisation", async () => {
    await expect(access.isOrgActive(tenant.orgId)).resolves.toBe(true);
  });

  it("is false for a suspended organisation", async () => {
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { status: "suspended" },
    });
    await expect(access.isOrgActive(tenant.orgId)).resolves.toBe(false);
  });

  it("is false for an organisation that does not exist", async () => {
    // Reported as inactive rather than throwing, so a caller cannot tell
    // "suspended" from "never existed".
    await expect(access.isOrgActive("no-such-org")).resolves.toBe(false);
  });
});

describe("isTaskInScope", () => {
  it("allows a company admin anything", async () => {
    const t = await task(null);
    const admin = await membershipOf(tenant.admin);
    await expect(access.isTaskInScope(t.id, admin)).resolves.toBe(true);
  });

  it("allows a scoped manager a task in their department", async () => {
    const t = await task(tenant.departmentId);
    const manager = await membershipOf(tenant.manager);
    await expect(access.isTaskInScope(t.id, manager)).resolves.toBe(true);
  });

  it("refuses a scoped manager a task in another department", async () => {
    const elsewhere = await prisma.department.create({
      data: { name: "Front of house", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    const t = await task(elsewhere.id);
    const manager = await membershipOf(tenant.manager);
    await expect(access.isTaskInScope(t.id, manager)).resolves.toBe(false);
  });

  it("refuses a scoped manager a task with NO department", async () => {
    // A department-less task is nobody's, unless you are unscoped.
    const t = await task(null);
    const manager = await membershipOf(tenant.manager);
    await expect(access.isTaskInScope(t.id, manager)).resolves.toBe(false);
  });

  it("refuses a task that does not exist", async () => {
    const manager = await membershipOf(tenant.manager);
    await expect(access.isTaskInScope("no-such-task", manager)).resolves.toBe(false);
  });

  it("ALLOWS a company admin a task in another organisation", async () => {
    // Not a bug — this is a scope check, not a tenancy check, and it returns
    // before the task is loaded. Pinned so nobody mistakes it for one and drops
    // the org-scoped lookup that has to accompany it.
    const foreign = await prisma.task.create({
      data: {
        title: "Someone else's shift",
        organizationId: other.orgId,
        createdById: other.admin.userId,
      },
    });
    const admin = await membershipOf(tenant.admin);
    await expect(access.isTaskInScope(foreign.id, admin)).resolves.toBe(true);
  });
});

describe("isAssignmentTaskInScope", () => {
  async function assignment(departmentId: string | null) {
    const t = await task(departmentId);
    return prisma.taskAssignment.create({
      data: {
        taskId: t.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });
  }

  it("allows a company admin", async () => {
    const a = await assignment(null);
    const admin = await membershipOf(tenant.admin);
    await expect(access.isAssignmentTaskInScope(a.id, admin)).resolves.toBe(true);
  });

  it("resolves the scope through the assignment's task", async () => {
    const a = await assignment(tenant.departmentId);
    const manager = await membershipOf(tenant.manager);
    await expect(access.isAssignmentTaskInScope(a.id, manager)).resolves.toBe(true);
  });

  it("refuses when the assignment's task is out of scope", async () => {
    const a = await assignment(null);
    const manager = await membershipOf(tenant.manager);
    await expect(access.isAssignmentTaskInScope(a.id, manager)).resolves.toBe(false);
  });

  it("refuses an assignment that does not exist", async () => {
    const manager = await membershipOf(tenant.manager);
    await expect(
      access.isAssignmentTaskInScope("no-such-assignment", manager)
    ).resolves.toBe(false);
  });
});
