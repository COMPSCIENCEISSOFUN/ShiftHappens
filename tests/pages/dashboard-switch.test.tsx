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

import DashboardPage from "@/app/(app)/org/[orgId]/dashboard/page";
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

/**
 * The component the page chose for this user, IN A NAMED ORGANISATION.
 *
 * The org id is now an argument rather than something the page works out for
 * itself. It used to take `orgs[0]`, so every case below was implicitly about
 * the user's oldest organisation and silently untestable for anyone in two —
 * which is the defect that moved this page under `/org/[orgId]`.
 */
async function dashboardFor(userId: string, orgId: string = tenant.orgId) {
  asUser(userId);
  const element = (await DashboardPage({
    params: Promise.resolve({ orgId }),
  })) as { type: unknown };
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
   * `getMembership` is active-only, so the membership lookup comes back null
   * and the page answers `notFound()`. That answer is chosen, not incidental:
   * a non-member and a non-existent organisation must be indistinguishable, or
   * the URL becomes a way to discover which organisation ids are real.
   *
   * The old code's `default:` arm sent every unrecognised role to the ADMIN
   * dashboard. Nothing reached it, but it was the wrong direction to fail in.
   */
  it("is not given a dashboard", async () => {
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { status: "inactive" },
    });

    asUser(tenant.manager.userId);
    await expect(
      DashboardPage({ params: Promise.resolve({ orgId: tenant.orgId }) })
    ).rejects.toThrow(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK/);
  });

  /*
   * The case that could not exist before this page moved.
   *
   * A perfectly valid member of organisation A, asking for organisation B. The
   * old page had no way to be asked this — it read `orgs[0]` and answered about
   * whichever organisation that was — so the wrong-organisation question was
   * unaskable and therefore untested. It is the whole reason the id belongs in
   * the URL.
   */
  it("is not given another organisation's dashboard", async () => {
    const other = await createTenant("switch-other");

    asUser(tenant.admin.userId);
    await expect(
      DashboardPage({ params: Promise.resolve({ orgId: other.orgId }) })
    ).rejects.toThrow(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK/);
  });
});
