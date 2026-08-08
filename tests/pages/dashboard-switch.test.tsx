// @vitest-environment node
/**
 * Which dashboard a member is given.
 *
 * The page ran `switch (role)` while the API route ran `if (role === …)`: one
 * decision made twice, neither consulting the permission catalogue. Fixing only
 * the route would have left this half in place, and the visible symptom would
 * have been worse than the bug — a narrowed manager still routed to the manager
 * dashboard, now rendering eight empty panels because the endpoint had
 * correctly stopped filling them.
 *
 * This asserts the CHOICE, not the rendering. The three dashboard components
 * are large and already have their own coverage; what was never pinned is which
 * one a given member reaches, which is the thing that just changed.
 *
 * The server component is awaited and its returned element inspected, rather
 * than rendered — there is no DOM question here, and rendering three
 * chart-heavy trees to answer "which function did it pick" would be slower and
 * would fail for reasons that have nothing to do with the rule under test.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import DashboardPage from "@/app/(app)/dashboard/page";
import AdminDashboard from "@/components/dashboard/admin-dashboard";
import ManagerDashboard from "@/components/dashboard/manager-dashboard";
import StaffDashboard from "@/components/dashboard/staff-dashboard";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { asUser } from "../helpers/session";

let tenant: Tenant;

async function giveCustomRole(membershipId: string, label: string, names: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { name: { in: names } },
    select: { id: true },
  });
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

/** The component the page chose for this user. */
async function dashboardFor(userId: string) {
  asUser(userId);
  const element = (await DashboardPage()) as { type: unknown };
  return element.type;
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("switch");
  vi.clearAllMocks();
});

describe("the three system roles land where they always did", () => {
  it("sends an admin to the admin dashboard", async () => {
    expect(await dashboardFor(tenant.admin.userId)).toBe(AdminDashboard);
  });

  it("sends a manager to the manager dashboard", async () => {
    expect(await dashboardFor(tenant.manager.userId)).toBe(ManagerDashboard);
  });

  it("sends a staff member to the staff dashboard", async () => {
    expect(await dashboardFor(tenant.staff.userId)).toBe(StaffDashboard);
  });
});

describe("a custom role moves them", () => {
  /*
   * A role cannot move somebody DOWN, and this asserted that it could one
   * commit ago. Inverted rather than deleted: the manager keeps `reports:view`
   * from their bundle, so the manager dashboard is where they belong, and the
   * way to move them is to change their system role.
   */
  it("does not move a manager off the manager dashboard", async () => {
    await giveCustomRole(tenant.manager.membershipId, "Shift Lead", [
      "tasks:assign",
    ]);
    expect(await dashboardFor(tenant.manager.userId)).toBe(ManagerDashboard);
  });

  /*
   * And the narrowing path, so the pair reads as one statement: the same role
   * on a staff member yields the personal dashboard. This is what "restrict a
   * manager" now means — change what they are, then say what they may do.
   */
  it("leaves a staff member holding that same role on the staff dashboard", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Shift Lead", [
      "tasks:assign",
    ]);
    expect(await dashboardFor(tenant.staff.userId)).toBe(StaffDashboard);
  });

  /*
   * The grant direction, and the reason the feature exists. A senior staff
   * member given reporting reaches the manager dashboard — scoped to their own
   * departments by the route, because a permission changes what you may do and
   * never whose data you may do it to.
   */
  it("sends a staff member with reports:view to the manager dashboard", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Senior", ["reports:view"]);
    expect(await dashboardFor(tenant.staff.userId)).toBe(ManagerDashboard);
  });

  /*
   * Scope, not permission, is what separates the manager dashboard from the
   * admin one — it is the only one that renders the two org-wide sections, and
   * those mean nothing to somebody who can see one department. Granting every
   * reporting permission in the catalogue must not promote a staff member past
   * a department boundary.
   */
  it("does not send a granted staff member to the admin dashboard", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Senior", [
      "reports:view",
      "certifications:review",
      "calendar:view_team",
    ]);
    expect(await dashboardFor(tenant.staff.userId)).toBe(ManagerDashboard);
  });

  /*
   * An admin cannot be given a custom role — `assignCustomRole` refuses — so
   * there is no path by which the person who edits roles narrows themselves
   * out of the admin dashboard. Asserted rather than assumed, because it is the
   * guarantee that makes the whole feature safe to hand to an organisation.
   */
  it("keeps an admin on the admin dashboard even with a role attached", async () => {
    await giveCustomRole(tenant.admin.membershipId, "Nothing Much", [
      "tasks:assign",
    ]);
    expect(await dashboardFor(tenant.admin.userId)).toBe(AdminDashboard);
  });
});

describe("a member who is no longer one", () => {
  /*
   * A deactivated member never reaches the choice at all.
   *
   * Worth pinning because it is the reason the page's `!membership` fallback
   * looks unreachable: `getUserOrganizations` is active-only, so a deactivated
   * member has no organisations and is redirected before any permission is
   * read. The fallback covers the narrower case of a deactivation landing
   * between that query and the membership lookup — a race no test can stage
   * without instrumenting the gap between two awaits, which is why it is
   * documented in the page rather than asserted here.
   *
   * The old code's `default:` arm sent every unrecognised role to the ADMIN
   * dashboard. Nothing reached it, but it was the wrong direction to fail in.
   */
  it("is redirected away rather than given a dashboard", async () => {
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { status: "inactive" },
    });

    asUser(tenant.manager.userId);
    await expect(DashboardPage()).rejects.toThrow(/NEXT_REDIRECT/);
  });
});
