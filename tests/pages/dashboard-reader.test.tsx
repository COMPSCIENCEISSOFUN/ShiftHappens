// @vitest-environment node
/**
 * What the dashboard page tells the screen about the caller.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import DashboardPage from "@/app/(app)/org/[orgId]/dashboard/page";
import { Dashboard, type DashboardProps } from "@/components/dashboard/dashboard";
import { cardsFor, type DashboardReader } from "@/lib/dashboard-cards";
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
 * The props the page handed the dashboard, IN A NAMED ORGANISATION.
 *
 * The org id is an argument rather than something the page works out for
 * itself. It used to take `orgs[0]`, so every case below was implicitly about
 * the user's oldest organisation and silently untestable for anyone in two —
 * the defect that moved this page under `/org/[orgId]`.
 */
async function propsFor(userId: string, orgId: string = tenant.orgId) {
  asUser(userId);
  const element = (await DashboardPage({
    params: Promise.resolve({ orgId }),
  })) as { type: unknown; props: DashboardProps };
  expect(element.type).toBe(Dashboard);
  return element.props;
}

/** The reader those props describe, in the shape the registry consumes. */
function readerOf(props: DashboardProps): DashboardReader {
  return {
    permissions: new Set(props.permissions),
    departmentScope: props.departmentScope,
    rosterable: props.rosterable,
  };
}

async function cardIdsFor(userId: string) {
  return cardsFor(readerOf(await propsFor(userId))).map((card) => card.id);
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("reader");
  vi.clearAllMocks();
});

describe("the three facts the page states", () => {
  it("gives an admin an unrestricted scope and no shifts of their own", async () => {
    const props = await propsFor(tenant.admin.userId);
    expect(props.departmentScope).toBeNull();
    expect(props.rosterable).toBe(false);
    expect(props.permissions).toContain("reports:view");
  });

  it("gives a manager their own departments and a place on the roster", async () => {
    const props = await propsFor(tenant.manager.userId);
    expect(props.departmentScope).toEqual([tenant.departmentId]);
    expect(props.rosterable).toBe(true);
  });

  it("gives a staff member no reporting", async () => {
    const props = await propsFor(tenant.staff.userId);
    expect(props.permissions).not.toContain("reports:view");
    expect(props.rosterable).toBe(true);
  });

  /*
   * A `Set` does not survive the server/client boundary — it arrives as `{}`,
   * every `.has()` answers false, and the reader qualifies for nothing while
   * the page looks correct in every server-side assertion. The failure would be
   * a blank dashboard in the browser and a green suite, so the array is pinned
   * here rather than left to the type.
   */
  it("sends the permissions as an array, not a Set", async () => {
    const props = await propsFor(tenant.admin.userId);
    expect(Array.isArray(props.permissions)).toBe(true);
  });
});

describe("a custom role reaches the screen", () => {
  /*
   * The defect the registry exists for, in its reachable form.
   *
   * `calendar:view_team` is grantable to a staff member, the endpoint returns
   * `teamRoster` for exactly this caller — permission plus a non-empty scope —
   * and the old switch sent them to the staff dashboard, which had no roster
   * on it. A granted permission, answered by the API, that the screen dropped.
   */
  it("shows a staff member the team roster their grant pays for", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Shift Lead", [
      "calendar:view_team",
    ]);
    expect(await cardIdsFor(tenant.staff.userId)).toContain("team-roster");
  });

  it("does not show it to a staff member without the grant", async () => {
    expect(await cardIdsFor(tenant.staff.userId)).not.toContain("team-roster");
  });

  /*
   * The other half of the same statement. Reporting granted to a staff member
   * opens the reporting cards, and does NOT carry the roster with it — a grant
   * is precise or it is not a grant.
   */
  it("opens the reporting cards for a staff member given reports:view", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Senior", ["reports:view"]);
    const ids = await cardIdsFor(tenant.staff.userId);
    expect(ids).toContain("key-metrics");
    expect(ids).toContain("coverage");
    expect(ids).not.toContain("team-roster");
  });

  /*
   * Scope, not permission, is what an admin has and a granted staff member does
   * not. `department-workload` compares departments against one another, so
   * handing it to somebody who can see one would be a number that is not
   * theirs. Without this, "give them every reporting permission" would quietly
   * become "make them an admin".
   */
  it("does not promote a granted staff member past a department boundary", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Senior", [
      "reports:view",
      "certifications:review",
      "calendar:view_team",
    ]);
    const props = await propsFor(tenant.staff.userId);
    expect(props.departmentScope).toEqual([tenant.departmentId]);

    const ids = cardsFor(readerOf(props)).map((card) => card.id);
    expect(ids).not.toContain("department-workload");
    expect(ids).not.toContain("certification-summary");
    expect(ids).not.toContain("engine");
  });

  /*
   * An admin cannot be given a custom role — `assignCustomRole` refuses — so
   * there is no path by which the person who edits roles narrows themselves out
   * of their own dashboard. Asserted rather than assumed, because it is the
   * guarantee that makes the feature safe to hand to an organisation.
   */
  it("cannot be narrowed by attaching a role to an admin", async () => {
    await giveCustomRole(tenant.admin.membershipId, "Nothing Much", [
      "tasks:assign",
    ]);
    const ids = await cardIdsFor(tenant.admin.userId);
    expect(ids).toContain("department-workload");
    expect(ids).toContain("engine");
  });
});

describe("who gets the self-service cards", () => {
  /*
   * Not a permission. An admin holds every grant in the catalogue and still
   * gets none of these, because `canBeRostered` says the engine will never
   * consider them for a shift — so "your next shift" would be empty by
   * construction rather than empty by circumstance.
   */
  it("withholds them from an admin who holds everything", async () => {
    const ids = await cardIdsFor(tenant.admin.userId);
    expect(ids).not.toContain("next-shift");
    expect(ids).not.toContain("pending-offers");
    expect(ids).not.toContain("my-stats");
  });

  it("gives them to a staff member holding nothing", async () => {
    const ids = await cardIdsFor(tenant.staff.userId);
    expect(ids).toContain("next-shift");
    expect(ids).toContain("pending-offers");
    expect(ids).toContain("my-stats");
  });
});

describe("a member who is no longer one", () => {
  /*
   * A deactivated member never reaches the question at all.
   *
   * `getMembership` is active-only, so the lookup comes back null and the page
   * answers `notFound()`. That answer is chosen, not incidental: a non-member
   * and a non-existent organisation must be indistinguishable, or the URL
   * becomes a way to discover which organisation ids are real.
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
   * A perfectly valid member of organisation A, asking for organisation B. The
   * old page had no way to be asked this — it read `orgs[0]` and answered about
   * whichever organisation that was — so the wrong-organisation question was
   * unaskable and therefore untested. It is the whole reason the id is in the
   * URL.
   */
  it("is not given another organisation's dashboard", async () => {
    const other = await createTenant("reader-other");

    asUser(tenant.admin.userId);
    await expect(
      DashboardPage({ params: Promise.resolve({ orgId: other.orgId }) })
    ).rejects.toThrow(/NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK/);
  });
});
