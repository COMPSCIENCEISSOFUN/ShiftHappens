// @vitest-environment node
/**
 * The dashboard endpoint, and the permission it never asked for.
 *
 * ## The hole
 *
 * This route decided everything it returned from `membership.role`. Permissions
 * were not consulted at all, on the largest data surface in the product — so
 * the custom-role feature was untrue in both directions here:
 *
 *   - an admin who composed a role deliberately WITHOUT `reports:view`, and
 *     gave it to a manager, still sent them key metrics, staff utilisation,
 *     rejection trends, coverage and tomorrow's schedule. The removal did not
 *     merely go unmentioned in the UI. It did not happen;
 *   - a senior staff member granted `reports:view` received nothing, because
 *     the branch asked their title instead.
 *
 * ## What is pinned here
 *
 * Both directions, and — the half that is easy to forget — that the three
 * system roles still get exactly what they got before. A permissions fix that
 * quietly changes what a plain manager sees is a regression wearing a fix's
 * clothes, and `certificationSummary` is where that nearly happened: managers
 * hold `certifications:review` in their bundle, so gating that section on the
 * permission alone would have handed every manager an org-wide figure.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET } from "@/app/api/organizations/[orgId]/dashboard/route";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { asUser } from "../helpers/session";
import { ctx, req, bodyOf } from "../helpers/route";

let tenant: Tenant;

/** The eight sections that describe other people's work. */
const ORG_SECTIONS = [
  "needsAttention",
  "keyMetrics",
  "tomorrowsSchedule",
  "completionChart",
  "staffUtilization",
  "rejectionTrends",
  "taskSummary",
  "coverageSummary",
] as const;

/**
 * Gives `membershipId` a custom role holding exactly `permissionNames`.
 *
 * The permissions are looked up rather than created, and the lookup is asserted
 * — `Permission` rows come from `npx prisma db seed`, not from a migration, so
 * on an unseeded test database a silent miss would compose an empty role and
 * every expectation below would pass for the wrong reason.
 */
async function giveCustomRole(
  membershipId: string,
  label: string,
  permissionNames: string[]
) {
  const permissions = await prisma.permission.findMany({
    where: { name: { in: permissionNames } },
    select: { id: true },
  });
  expect(
    permissions.length,
    `permission catalogue is missing one of ${permissionNames.join(", ")} — run npx prisma db seed against the test database`
  ).toBe(permissionNames.length);

  const role = await prisma.role.create({
    data: {
      organizationId: tenant.orgId,
      name: label.toLowerCase().replace(/\s+/g, "_"),
      displayLabel: label,
      rolePermissions: {
        create: permissions.map((p) => ({ permissionId: p.id })),
      },
    },
  });

  await prisma.membership.update({
    where: { id: membershipId },
    data: { customRoleId: role.id },
  });
}

async function dashboardFor(userId: string) {
  asUser(userId);
  const res = await GET(req(), ctx({ orgId: tenant.orgId }));
  expect(res.status).toBe(200);
  return (await bodyOf(res)) as Record<string, unknown>;
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("dash");
  vi.clearAllMocks();
});

describe("the system roles get what they always got", () => {
  it("gives an admin the org sections and both org-wide ones", async () => {
    const body = await dashboardFor(tenant.admin.userId);

    for (const section of ORG_SECTIONS) expect(body).toHaveProperty(section);
    expect(body).toHaveProperty("departmentWorkload");
    expect(body).toHaveProperty("certificationSummary");
    // An admin has no "own team" — they are unscoped, so a roster of their
    // departments would be the whole organisation under a misleading heading.
    expect(body).not.toHaveProperty("teamRoster");
    // And no personal section: an admin cannot be rostered, so it would render
    // empty by construction.
    expect(body).not.toHaveProperty("staffData");
  });

  it("gives a manager the org sections and their team, but nothing org-wide", async () => {
    const body = await dashboardFor(tenant.manager.userId);

    for (const section of ORG_SECTIONS) expect(body).toHaveProperty(section);
    expect(body).toHaveProperty("teamRoster");
    /*
     * The near-miss. `certifications:review` IS in the manager bundle, so a
     * section gated on the permission alone would newly leak an org-wide count
     * to every manager in every organisation — a scoping regression arriving
     * inside a permissions fix.
     */
    expect(body).not.toHaveProperty("certificationSummary");
    expect(body).not.toHaveProperty("departmentWorkload");
  });

  it("gives a plain staff member their own data and nothing else", async () => {
    const body = await dashboardFor(tenant.staff.userId);

    expect(body).toHaveProperty("staffData");
    for (const section of ORG_SECTIONS) expect(body).not.toHaveProperty(section);
    expect(body).not.toHaveProperty("teamRoster");
  });
});

describe("a custom role can take the org sections away", () => {
  /*
   * The bug, stated as a test. This manager's role does not include
   * `reports:view`; before this change they received all eight sections
   * regardless, because the route asked their title.
   */
  it("stops sending them to a manager whose role omits reports:view", async () => {
    await giveCustomRole(tenant.manager.membershipId, "Shift Lead", [
      "tasks:assign",
      "eligibility:view",
    ]);

    const body = await dashboardFor(tenant.manager.userId);

    for (const section of ORG_SECTIONS) expect(body).not.toHaveProperty(section);
  });

  it("takes the team roster with it when the role omits calendar:view_team", async () => {
    await giveCustomRole(tenant.manager.membershipId, "Shift Lead", [
      "reports:view",
    ]);

    const body = await dashboardFor(tenant.manager.userId);

    // Reporting survives — it was granted — so this is not the whole payload
    // collapsing, which is what makes the absence below mean something.
    expect(body).toHaveProperty("keyMetrics");
    expect(body).not.toHaveProperty("teamRoster");
  });

  /*
   * A narrowed manager is still rostered — `canBeRostered` admits them — so
   * they keep their own shifts. Removing a reporting permission must not take
   * away the person's view of their own work, which is not a permission at all.
   */
  it("leaves the member's own data alone", async () => {
    await giveCustomRole(tenant.manager.membershipId, "Shift Lead", [
      "tasks:assign",
    ]);

    expect(await dashboardFor(tenant.manager.userId)).toHaveProperty("staffData");
  });
});

describe("a custom role can hand the org sections to a staff member", () => {
  it("gives a staff member with reports:view the org sections", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Senior", ["reports:view"]);

    const body = await dashboardFor(tenant.staff.userId);

    for (const section of ORG_SECTIONS) expect(body).toHaveProperty(section);
  });

  /*
   * Scoped, not org-wide. A grant changes WHAT you may do; it never changes
   * WHOSE data you may do it to — `departmentScopeFor` keys off
   * `company_admin`, and a staff member is not one. Without this, "promote a
   * staff member to reporting" would quietly be "promote them past every
   * department boundary in the organisation".
   */
  it("does not make them unrestricted", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Senior", [
      "reports:view",
      "certifications:review",
    ]);

    const body = await dashboardFor(tenant.staff.userId);

    expect(body).not.toHaveProperty("departmentWorkload");
    expect(body).not.toHaveProperty("certificationSummary");
  });

  it("gives them their own team once calendar:view_team is granted too", async () => {
    await giveCustomRole(tenant.staff.membershipId, "Senior", [
      "reports:view",
      "calendar:view_team",
    ]);

    expect(await dashboardFor(tenant.staff.userId)).toHaveProperty("teamRoster");
  });

  /*
   * A member in no department has an EMPTY scope, which means "nothing" and not
   * "everything" — the distinction that separates a manager of one kitchen from
   * a manager of the whole company. They keep the sections they were granted;
   * those sections just describe nobody.
   */
  it("gives no team roster to a member with the permission and no department", async () => {
    const loner = await prisma.membership.findFirstOrThrow({
      where: { id: tenant.manager.membershipId },
    });
    await prisma.departmentMembership.deleteMany({
      where: { membershipId: loner.id },
    });

    const body = await dashboardFor(tenant.manager.userId);

    expect(body).toHaveProperty("keyMetrics");
    expect(body).not.toHaveProperty("teamRoster");
  });
});

describe("an empty custom role", () => {
  /*
   * Composed with nothing in it, it must mean nothing — that is the difference
   * between "no custom role" (fall back to the bundle) and "a role granting
   * nothing", and collapsing the two would make an empty role behave like no
   * role at all.
   *
   * Worth pinning here because this is the behaviour that changes in the next
   * commit: once a role ADDS to the system bundle instead of replacing it, this
   * manager keeps their sections and this test is the one that should fail and
   * be rewritten, rather than a surprise found later.
   */
  it("currently leaves a manager with no org sections at all", async () => {
    const role = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "empty",
        displayLabel: "Empty",
      },
    });
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { customRoleId: role.id },
    });

    const body = await dashboardFor(tenant.manager.userId);

    for (const section of ORG_SECTIONS) expect(body).not.toHaveProperty(section);
    expect(body).not.toHaveProperty("teamRoster");
    expect(body).toHaveProperty("staffData");
  });
});
