/**
 * Who works in a department.
 *
 * The rule worth holding is that this list and the count on the card in front
 * of it describe the same population. The card counts every department
 * membership row; so does this.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { prisma } from "@/lib/prisma";
import { DepartmentService } from "@/services/department.service";

import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const departments = new DepartmentService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("dept-members");
});

describe("reading a department's people", () => {
  it("returns everyone the card counts, deactivated included", async () => {
    // The fixture's staff and manager are already in the department; put the
    // deactivated member there too, which is what the card would count.
    await prisma.departmentMembership.create({
      data: {
        membershipId: tenant.inactive.membershipId,
        departmentId: tenant.departmentId,
      },
    });

    const result = await departments.getMembers(tenant.departmentId, tenant.orgId);

    const counted = await prisma.departmentMembership.count({
      where: { departmentId: tenant.departmentId },
    });
    expect(result?.total).toBe(counted);
    expect(result?.members.map((m) => m.id)).toContain(
      tenant.inactive.membershipId
    );
  });

  /*
   * Both figures, because they answer different questions. The card only ever
   * answered the first, which is why a roster built from it came up short.
   */
  it("reports active separately from total", async () => {
    await prisma.departmentMembership.create({
      data: {
        membershipId: tenant.inactive.membershipId,
        departmentId: tenant.departmentId,
      },
    });

    const result = await departments.getMembers(tenant.departmentId, tenant.orgId);

    expect(result?.active).toBe((result?.total ?? 0) - 1);
  });

  it("carries what the drawer prints beside each name", async () => {
    const result = await departments.getMembers(tenant.departmentId, tenant.orgId);
    const staff = result?.members.find(
      (member) => member.id === tenant.staff.membershipId
    );

    expect(staff?.role).toBe("staff");
    expect(staff?.status).toBe("active");
    expect(staff?.user.email).toBeTruthy();
    // Present as a key even when nobody holds a custom role, so the drawer can
    // branch on it rather than on undefined.
    expect(staff).toHaveProperty("customRole");
  });

  it("returns an empty list for a department nobody is in", async () => {
    const empty = await prisma.department.create({
      data: { name: "Nobody here", organizationId: tenant.orgId },
    });

    const result = await departments.getMembers(empty.id, tenant.orgId);

    expect(result?.members).toEqual([]);
    expect(result?.total).toBe(0);
    expect(result?.active).toBe(0);
  });
});

describe("who may read it", () => {
  /*
   * Null rather than a throw, and the same null for both cases: another
   * organisation's department and one outside the caller's scope answer
   * identically, or the id becomes a way to discover what exists elsewhere.
   */
  it("refuses a department belonging to another organisation", async () => {
    const other = await createTenant("dept-other");

    const result = await departments.getMembers(other.departmentId, tenant.orgId);

    expect(result).toBeNull();
  });

  it("refuses a department outside a scoped caller's departments", async () => {
    const bar = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId },
    });

    const result = await departments.getMembers(bar.id, tenant.orgId, [
      tenant.departmentId,
    ]);

    expect(result).toBeNull();
  });

  it("allows a scoped caller their own department", async () => {
    const result = await departments.getMembers(tenant.departmentId, tenant.orgId, [
      tenant.departmentId,
    ]);

    expect(result?.department.id).toBe(tenant.departmentId);
  });

  /* An unrestricted caller is null scope, and must not be read as "no access". */
  it("allows an unrestricted caller every department", async () => {
    const bar = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId },
    });

    expect(await departments.getMembers(bar.id, tenant.orgId, null)).not.toBeNull();
  });

  /* A manager assigned to nothing is scoped to nothing, which is not everything. */
  it("refuses a caller scoped to no departments at all", async () => {
    const result = await departments.getMembers(tenant.departmentId, tenant.orgId, []);

    expect(result).toBeNull();
  });
});
