/**
 * Who gets told a shift no longer fits its people.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { taskWatcherUserIds } from "@/services/task-watchers";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

let tenant: Tenant;

async function giveCustomRole(membershipId: string, label: string, names: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { name: { in: names } },
    select: { id: true },
  });
  // The catalogue is seeded, not migrated — a silent miss here would compose an
  // empty role and every expectation below would hold for the wrong reason.
  expect(
    permissions.length,
    `missing one of ${names.join(", ")} — run npx prisma db seed against the test database`
  ).toBe(names.length);

  const role = await prisma.role.create({
    data: {
      organizationId: tenant.orgId,
      name: label.toLowerCase().replace(/\s+/g, "_"),
      displayLabel: label,
      rolePermissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
  });
  await prisma.membership.update({
    where: { id: membershipId },
    data: { customRoleId: role.id },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("watch");
});

describe("the system roles are notified as before", () => {
  it("tells an admin about a task in any department", async () => {
    const ids = await taskWatcherUserIds(tenant.orgId, tenant.departmentId);
    expect(ids).toContain(tenant.admin.userId);
  });

  it("tells the manager of that department", async () => {
    const ids = await taskWatcherUserIds(tenant.orgId, tenant.departmentId);
    expect(ids).toContain(tenant.manager.userId);
  });

  it("does not tell a plain staff member", async () => {
    const ids = await taskWatcherUserIds(tenant.orgId, tenant.departmentId);
    expect(ids).not.toContain(tenant.staff.userId);
  });

  it("does not tell a manager of a different department", async () => {
    const other = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
    });

    const ids = await taskWatcherUserIds(tenant.orgId, other.id);

    // The admin still hears about it, so this is the scope filter working
    // rather than the whole list coming back empty.
    expect(ids).toContain(tenant.admin.userId);
    expect(ids).not.toContain(tenant.manager.userId);
  });

  /*
   * A task belonging to no department reaches unrestricted members only. An
   * empty or non-matching scope means "nothing", not "everything" — the
   * permissive reading is how a manager of one kitchen quietly becomes a
   * manager of the whole organisation.
   */
  it("tells only unrestricted members about a department-less task", async () => {
    const ids = await taskWatcherUserIds(tenant.orgId, null);

    expect(ids).toContain(tenant.admin.userId);
    expect(ids).not.toContain(tenant.manager.userId);
  });

  it("does not tell a deactivated member", async () => {
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { status: "inactive" },
    });

    const ids = await taskWatcherUserIds(tenant.orgId, tenant.departmentId);
    expect(ids).not.toContain(tenant.manager.userId);
  });
});

describe("a custom role decides it now", () => {
  /*
   * The grant direction. This staff member is in the department and can assign
   * — they are precisely who should fix the shift — and the old rule skipped
   * them because their title was "staff".
   */
  it("tells a staff member whose role grants tasks:assign", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Shift Lead", ["tasks:assign"]);

    const ids = await taskWatcherUserIds(tenant.orgId, tenant.departmentId);
    expect(ids).toContain(tenant.staff.userId);
  });

  /*
   * A role cannot take the notification away, and this asserted the opposite
   * one commit ago — it is inverted rather than deleted, because "my role does
   * not mention assigning, so why am I still told" is the question a reader
   * will arrive with.
   *
   * A custom role adds. Silencing somebody is done by making them staff, which
   * the "does not tell a plain staff member" case above already covers, and
   * which is honest: a manager still holds `tasks:assign` from their bundle and
   * can still fix the shift, so telling them is correct.
   */
  it("keeps telling a manager whose role does not mention it", async () => {
    await giveCustomRole(tenant.manager.membershipId, "Rota Reader", [
      "reports:view",
    ]);

    const ids = await taskWatcherUserIds(tenant.orgId, tenant.departmentId);
    expect(ids).toContain(tenant.manager.userId);
  });

  /*
   * Permission is not scope. Granting the ability to assign does not widen the
   * departments whose data you may see, so a shift lead in the kitchen hears
   * about kitchen tasks and no others.
   */
  it("does not widen a granted member past their own departments", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Shift Lead", ["tasks:assign"]);
    const other = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
    });

    const ids = await taskWatcherUserIds(tenant.orgId, other.id);
    expect(ids).not.toContain(tenant.staff.userId);
  });

  it("does not tell a deactivated member who holds the permission", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Shift Lead", ["tasks:assign"]);
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { status: "inactive" },
    });

    const ids = await taskWatcherUserIds(tenant.orgId, tenant.departmentId);
    expect(ids).not.toContain(tenant.staff.userId);
  });
});
