/**
 * A member may belong to more than one department.
 *
 * The engine always allowed it — `departmentIds` is an array through the API
 * and the service, `departmentScopeFor` returns an array, and
 * `isDepartmentInScope` tests membership of it. Only the screen insisted on
 * one: the control was a single select that replaced the whole set, and the row
 * rendered `departmentMemberships[0]`, so a second department would have been
 * invisible even if something else had created it.
 *
 * It matters for real rosters. A small venue has one manager covering Kitchen
 * and Bar, and without it the only ways to express that were a second account
 * or promotion to company admin — which removes department scoping altogether
 * and hands over billing and settings.
 *
 * These tests pin the behaviour the UI can now reach: the union, and nothing
 * outside it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { UserManagementService } from "@/services/user-management.service";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor, isDepartmentInScope } from "@/lib/department-scope";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const userMgmt = new UserManagementService();
const access = new AccessService();

let tenant: Tenant;
let bar: { id: string };
let floor: { id: string };

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("multidept");
  bar = await prisma.department.create({
    data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
  });
  floor = await prisma.department.create({
    data: { name: "Front of House", organizationId: tenant.orgId, color: "#22C55E" },
  });
});

/** Sets a manager's departments, as the members screen now does. */
async function setDepartments(departmentIds: string[]) {
  await userMgmt.updateMemberRole(
    tenant.manager.userId,
    tenant.orgId,
    { role: "manager", departmentIds },
    tenant.admin.userId
  );
  const membership = await access.getMembership(tenant.manager.userId, tenant.orgId);
  if (!membership) throw new Error("manager membership vanished");
  return membership;
}

describe("a manager scoped to two departments", () => {
  it("holds both", async () => {
    const membership = await setDepartments([bar.id, floor.id]);

    const scope = departmentScopeFor(membership);
    expect(scope).toHaveLength(2);
    expect(scope).toEqual(expect.arrayContaining([bar.id, floor.id]));
  });

  it("is in scope for either one", async () => {
    const membership = await setDepartments([bar.id, floor.id]);
    const scope = departmentScopeFor(membership);

    expect(isDepartmentInScope(bar.id, scope)).toBe(true);
    expect(isDepartmentInScope(floor.id, scope)).toBe(true);
  });

  // The union, not everything. A third department stays out.
  it("is still out of scope for a department they do not hold", async () => {
    const membership = await setDepartments([bar.id, floor.id]);
    const scope = departmentScopeFor(membership);

    expect(isDepartmentInScope(tenant.departmentId, scope)).toBe(false);
  });

  it("loses one without losing the other", async () => {
    await setDepartments([bar.id, floor.id]);
    const membership = await setDepartments([bar.id]);

    const scope = departmentScopeFor(membership);
    expect(scope).toEqual([bar.id]);
  });
});

describe("the edges of the set", () => {
  /**
   * Already covered for the reporting routes, asserted here on the scope
   * itself: an empty array is "no departments", which must not read as "all
   * departments". The distinction is the difference between a manager seeing
   * nothing and a manager seeing the whole organisation.
   */
  it("gives a manager with no departments an empty scope, not an open one", async () => {
    const membership = await setDepartments([]);

    const scope = departmentScopeFor(membership);
    expect(scope).toEqual([]);
    expect(isDepartmentInScope(bar.id, scope)).toBe(false);
  });

  it("leaves a company admin unscoped whatever departments they hold", async () => {
    const membership = await access.getMembership(tenant.admin.userId, tenant.orgId);
    expect(departmentScopeFor(membership!)).toBeNull();
  });
});

describe("permissions and scope stay independent", () => {
  /**
   * A custom role changes WHAT a manager may do; it must never change WHOSE
   * data they may do it to. `departmentScopeFor` keys off the system role, so
   * no permission set can widen the scope.
   */
  it("does not widen scope when a custom role grants everything", async () => {
    const permissions = await prisma.permission.findMany();
    const role = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "everything",
        displayLabel: "Everything",
        rolePermissions: {
          create: permissions.map((p) => ({ permissionId: p.id })),
        },
      },
    });
    await setDepartments([bar.id]);
    await userMgmt.assignCustomRole(
      tenant.manager.userId,
      tenant.orgId,
      role.id,
      tenant.admin.userId
    );

    const membership = await access.getMembership(tenant.manager.userId, tenant.orgId);
    const scope = departmentScopeFor(membership!);

    expect(scope).toEqual([bar.id]);
    expect(isDepartmentInScope(floor.id, scope)).toBe(false);
    // And they really do hold the permissions — so the scope is holding on its
    // own, not because the role failed to apply.
    expect(access.permissionsFor(membership!).size).toBe(permissions.length);
  });
});
