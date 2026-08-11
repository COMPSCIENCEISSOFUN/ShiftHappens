// @vitest-environment node
/**
 * Custom-role permissions, enforced at the route.
 *
 * ## What this is proving
 *
 * An audit of the whole `src/` tree found the permission catalogue was seeded,
 * displayed in a picker, stored in `RolePermission` — and read back by nothing.
 * Authorization was entirely the three-value `Membership.role` string. A custom
 * role with all 34 permissions granted nothing; one with none took nothing
 * away. The Roles screen was decoration.
 *
 * `contract.test.ts` already proves the system-role contract still holds for
 * every route, which is what makes this change safe. This file proves the part
 * that is new: that a custom role actually moves the line, in both directions,
 * and that it cannot move lines it has no business touching — the subscription
 * plan and the department scope.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { PERMISSION_FEATURE } from "@/lib/permissions";
import {
  getMinimumTierForFeature,
  isFeatureAvailable,
} from "@/lib/subscription-tiers";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { asUser } from "../helpers/session";
import { ctx, req, jsonReq } from "../helpers/route";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { requirePermission } from "@/lib/permission-guard";

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("perm");
});

/** Creates a custom role holding exactly `permissionNames` and assigns it. */
async function giveCustomRole(membershipId: string, permissionNames: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { name: { in: permissionNames } },
  });

  /*
   * The catalogue must be seeded, and the failure has to say so.
   *
   * A role built from missing rows would deny everything, and every assertion
   * in this file would then pass for the wrong reason — so this cannot be a
   * soft check. But the obvious form, `expect(permissions.length).toBe(n)`,
   * reports "expected 21 to be 26", which describes a symptom nobody can act
   * on: the real problem is that `Permission` was never seeded on this
   * database, and the fix is one command.
   */
  const found = new Set(permissions.map((p) => p.name));
  const missing = permissionNames.filter((name) => !found.has(name));
  expect(
    missing,
    `Permission rows missing from the test database: ${missing.join(", ")}. ` +
      "Seed it with `npx prisma db seed` against the test DATABASE_URL — the " +
      "catalogue lives in src/lib/permissions.ts and is not created by migrations."
  ).toEqual([]);

  const role = await prisma.role.create({
    data: {
      organizationId: tenant.orgId,
      name: `custom-${membershipId.slice(-6)}`,
      displayLabel: "Custom",
      rolePermissions: {
        create: permissions.map((p) => ({ permissionId: p.id })),
      },
    },
  });
  await prisma.membership.update({
    where: { id: membershipId },
    data: { customRoleId: role.id },
  });
  return role;
}

/**
 * POST a task as `userId`.
 *
 * The department is supplied deliberately. This route applies department scope
 * AFTER the permission gate, so a body without one makes a scoped manager fail
 * the scope check and return 403 for a reason that has nothing to do with
 * permissions — which is how the first draft of this file managed to "prove"
 * that a plain manager could not create a task.
 */
async function callTasksPost(userId: string) {
  asUser(userId);
  const { POST } = await import("@/app/api/organizations/[orgId]/tasks/route");
  return POST(
    jsonReq("POST", {
      title: "A shift",
      requiredHeadcount: 1,
      departmentId: tenant.departmentId,
    }),
    ctx({ orgId: tenant.orgId })
  );
}

async function callAuditLogs(userId: string) {
  asUser(userId);
  const { GET } = await import(
    "@/app/api/organizations/[orgId]/audit-logs/route"
  );
  return GET(req(), ctx({ orgId: tenant.orgId }));
}

describe("a custom role does not narrow", () => {
  /**
   * These two asserted the opposite until custom roles became additive, and
   * they are inverted rather than deleted because "the role does not mention
   * `tasks:create`, so why can they still create one" is what a reader will
   * come here asking.
   *
   * The answer is that a role adds to the system bundle. The "Shift Lead" who
   * runs shifts but may not reshape the roster is still expressible — as a
   * STAFF member with `tasks:assign`, which the widening block below covers.
   * What changed is that building one out of a manager no longer silently
   * strips the other fourteen permissions off them.
   */
  it("leaves a manager the actions their custom role omits", async () => {
    await giveCustomRole(tenant.manager.membershipId, [
      "tasks:assign",
      "reports:view",
    ]);

    const res = await callTasksPost(tenant.manager.userId);
    expect(res.status).not.toBe(403);
  });

  it("still allows the actions the custom role does include", async () => {
    await giveCustomRole(tenant.manager.membershipId, [
      ...ROLE_PERMISSIONS.manager,
    ]);

    const res = await callTasksPost(tenant.manager.userId);
    expect(res.status).not.toBe(403);
  });

  /**
   * An empty role contributes nothing, so the manager keeps their bundle.
   *
   * Under the old semantics this same fixture left them unable to do anything:
   * an admin could empty a colleague's access by creating a role and forgetting
   * to tick a box, from a screen whose chip read like an addition. That is the
   * failure mode the change removes, and it is worth a test of its own because
   * a role literally named "Empty" is the artefact somebody will find in a
   * database and reason wrongly about.
   */
  it("leaves a manager untouched by an empty custom role", async () => {
    const role = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "empty-role",
        displayLabel: "Empty",
      },
    });
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { customRoleId: role.id },
    });

    const res = await callTasksPost(tenant.manager.userId);
    expect(res.status).not.toBe(403);
  });

  /**
   * The narrowing path, asserted here so the block is a complete statement
   * rather than a list of things that no longer happen: the same role on a
   * staff member yields exactly what it grants, because the staff bundle is
   * empty. This is what restricting somebody now means.
   */
  it("gives a staff member holding the same role only what it grants", async () => {
    await giveCustomRole(tenant.staff.membershipId, [
      "tasks:assign",
      "reports:view",
    ]);

    const res = await callTasksPost(tenant.staff.userId);
    expect(res.status).toBe(403);
  });
});

describe("a custom role widens", () => {
  /**
   * The other half of the feature, and the reason a custom role REPLACES the
   * system bundle rather than intersecting with it: an organisation may want a
   * senior staff member who can create shifts without making them a manager.
   */
  it("allows a staff member an action their system role does not include", async () => {
    // Baseline: plain staff cannot.
    asUser(tenant.staff.userId);
    const before = await callTasksPost(tenant.staff.userId);
    expect(before.status).toBe(403);

    await giveCustomRole(tenant.staff.membershipId, ["tasks:create"]);

    const after = await callTasksPost(tenant.staff.userId);
    expect(after.status).not.toBe(403);
  });
});

describe("members without a custom role are unaffected", () => {
  // The safety property of the whole change. contract.test.ts asserts this
  // across every route; these two are the sanity check in this file's terms.
  it("keeps a plain manager's access", async () => {
    const res = await callTasksPost(tenant.manager.userId);
    expect(res.status).not.toBe(403);
  });

  it("keeps a plain staff member's refusal", async () => {
    const res = await callTasksPost(tenant.staff.userId);
    expect(res.status).toBe(403);
  });
});

describe("the subscription plan overrules the permission", () => {
  /**
   * The case worth being explicit about: `audit:view` is a real permission an
   * admin can tick, and the audit log is plan-gated. If the permission gate ran
   * first, or ran alone, an organisation could grant itself a paid feature by
   * ticking a box.
   *
   * Note the caller is the ADMIN — who holds every permission by definition —
   * so nothing here is refused for lack of permission. Only the plan says no.
   *
   * ## Why this is a FREE organisation, when it used to be a Pro one
   *
   * `audit_log` moved from Enterprise to Pro on 2026-08-11. The demonstration
   * needs a tier that HOLDS the permission and LACKS the feature, and Free is
   * now the only one.
   */
  it("refuses audit access on a plan without it, though the caller holds audit:view", async () => {
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { subscriptionTier: "free" },
    });

    const res = await callAuditLogs(tenant.admin.userId);
    expect(res.status).toBe(403);

    // The plan's message, not a bare "Forbidden" — an admin refused on plan
    // needs an upgrade button, not a permissions bug hunt. It names the tier
    // that would work, which is Pro now rather than Enterprise.
    const body = await res.json();
    expect(body.error).toMatch(/pro/i);
  });

  it("allows it on Pro", async () => {
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { subscriptionTier: "pro" },
    });

    const res = await callAuditLogs(tenant.admin.userId);
    expect(res.status).toBe(200);
  });

  it("allows it on Enterprise", async () => {
    const res = await callAuditLogs(tenant.admin.userId);
    expect(res.status).toBe(200);
  });

  /**
   * ## The two tests that used to live here, and why they cannot
   *
   * They proved that an admin could not hand a paid feature to somebody else
   * by composing a custom role: a Pro organisation granted `audit:view`
   * through a custom role, and the plan refused anyway.
   *
   * That scenario is now unreachable. Custom roles require Pro, and every
   * permission in `PERMISSION_FEATURE` maps to a feature available at Pro — so
   * there is no organisation that can BUILD a custom role and still be refused
   * by the plan for anything it could grant.
   *
   * The guard is untouched and still correct; the configuration simply no
   * longer produces the case. Deleting the tests silently would leave that as
   * folklore, so this is the test that replaces them: it pins the property
   * that makes the escalation impossible.
   *
   * **If this goes red, the escalation path exists again** — somebody has gated
   * a feature above Pro and mapped a permission to it — and the two deleted
   * tests should be written back against that feature.
   */
  it("has no plan-gated permission a custom role could reach but not use", () => {
    const CUSTOM_ROLE_TIER = getMinimumTierForFeature("custom_roles");

    const unreachable = Object.entries(PERMISSION_FEATURE).filter(
      ([, feature]) => !isFeatureAvailable(CUSTOM_ROLE_TIER, feature)
    );

    expect(
      unreachable,
      "a permission gated above the tier that custom roles require means an " +
        "admin can tick a box that can never work — restore the escalation tests"
    ).toEqual([]);
  });
});

describe("a custom role cannot widen department scope", () => {
  /**
   * Permissions answer WHAT may be done; department scope answers WHOSE data it
   * may be done to. `departmentScopeFor` keys off `role === "company_admin"`,
   * so no permission set can turn a scoped manager into an unscoped one.
   */
  it("still scopes a manager holding every manager permission", async () => {
    const other = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    const outsideTask = await prisma.task.create({
      data: {
        title: "Bar shift",
        organizationId: tenant.orgId,
        departmentId: other.id,
        createdById: tenant.admin.userId,
        requiredHeadcount: 1,
        status: "open",
      },
    });
    await giveCustomRole(tenant.manager.membershipId, [
      ...ROLE_PERMISSIONS.manager,
    ]);

    asUser(tenant.manager.userId);
    const { PATCH } = await import(
      "@/app/api/organizations/[orgId]/tasks/[taskId]/route"
    );
    const res = await PATCH(
      jsonReq("PATCH", { title: "Renamed" }),
      ctx({ orgId: tenant.orgId, taskId: outsideTask.id })
    );

    // Out of scope, despite holding tasks:update.
    expect([403, 404]).toContain(res.status);
  });
});

describe("an admin cannot be narrowed", () => {
  /**
   * `assignCustomRole` refuses to attach a role to a company_admin, and
   * `effectivePermissions` ignores one if it somehow got there. Both belts
   * matter: the person who edits roles must not be able to lock themselves out
   * of the screen where roles are edited.
   */
  it("keeps every permission even with a custom role attached directly", async () => {
    const role = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "locked-out",
        displayLabel: "Locked out",
      },
    });
    await prisma.membership.update({
      where: { id: tenant.admin.membershipId },
      data: { customRoleId: role.id },
    });

    asUser(tenant.admin.userId);
    const { GET } = await import(
      "@/app/api/organizations/[orgId]/permissions/route"
    );
    const res = await GET(req(), ctx({ orgId: tenant.orgId }));
    expect(res.status).toBe(200);
  });
});

describe("the guard's own tier veto", () => {
  /**
   * Tested directly rather than through a route, and here is why.
   *
   * Mutation testing deleted the tier check from `requirePermission` and the
   * whole suite stayed green — because `audit-logs/route.ts` calls
   * `enforceFeatureAccess` itself, so the guard's copy never decides anything
   * today. That makes it defence in depth rather than dead code: it is what
   * protects the NEXT plan-gated route, whose author forgets the explicit
   * call. Defence in depth that nothing tests is just an untested claim, so the
   * guard is exercised on its own terms below.
   *
   * On FREE, not Pro. `audit_log` moved down to Pro on 2026-08-11, and this
   * needs a tier that holds the permission and lacks the feature.
   */
  it("refuses a gated permission on a plan that does not include it", async () => {
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { subscriptionTier: "free" },
    });

    const result = await requirePermission(
      tenant.admin.userId,
      tenant.orgId,
      "audit:view"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      // The plan's wording, so the caller learns it is a plan problem — and it
      // names the tier that would work, which is Pro now.
      expect(body.error).toMatch(/pro/i);
    }
  });

  it("allows the same permission on a plan that does include it", async () => {
    const result = await requirePermission(
      tenant.admin.userId,
      tenant.orgId,
      "audit:view"
    );
    expect(result.ok).toBe(true);
  });

  // An ungated permission must not be dragged through the plan lookup and
  // refused by accident on a Free organisation.
  it("leaves ungated permissions alone on the lowest plan", async () => {
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { subscriptionTier: "free" },
    });

    const result = await requirePermission(
      tenant.manager.userId,
      tenant.orgId,
      "tasks:create"
    );
    expect(result.ok).toBe(true);
  });
});
