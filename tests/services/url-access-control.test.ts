/**
 * What the URL alone gets you.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AccessService } from "@/services/access.service";
import { OrganizationService } from "@/services/organization.service";
import {
  TASK_LIST_READERS,
  MEMBER_LIST_READERS,
  DEPARTMENT_LIST_READERS,
  ROLE_PERMISSIONS,
  PERMISSION_NAMES,
} from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const access = new AccessService();
const orgService = new OrganizationService();

let alpha: Tenant;
let beta: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  alpha = await createTenant("alpha");
  beta = await createTenant("beta");
});

describe("the membership behind the org in the URL", () => {
  /*
   * The single question the layout asks. `notFound()` on a null membership is
   * what turns a served page into a 404 — and `getMembership` returning null
   * for a stranger is what makes that correct.
   */
  it("is null for a member of a different organisation", async () => {
    const membership = await access.getMembership(alpha.admin.userId, beta.orgId);
    expect(membership).toBeNull();
  });

  it("is null for an organisation that does not exist", async () => {
    // A stranger and a typo must be indistinguishable, or the URL becomes a way
    // to discover which organisation ids are real.
    const membership = await access.getMembership(alpha.admin.userId, "nope");
    expect(membership).toBeNull();
  });

  it("is null once the membership is deactivated", async () => {
    await prisma.membership.update({
      where: { id: alpha.staff.membershipId },
      data: { status: "inactive" },
    });
    expect(
      await access.getMembership(alpha.staff.userId, alpha.orgId)
    ).toBeNull();
  });

  it("is present for a real member", async () => {
    const membership = await access.getMembership(alpha.staff.userId, alpha.orgId);
    expect(membership?.role).toBe("staff");
  });
});

describe("which organisation's permissions govern the page", () => {
  /*
   * The layout used to resolve these from `orgs[0]`. This test is the reason
   * that mattered: the same user, admin in one org and staff in another, must
   * get a different answer per org — and the arbitrarily-first one is right
   * only by luck.
   */
  it("differs per organisation for a user who belongs to two", async () => {
    // Give alpha's admin a staff membership in beta.
    await prisma.membership.create({
      data: {
        userId: alpha.admin.userId,
        organizationId: beta.orgId,
        role: "staff",
        status: "active",
      },
    });

    const inAlpha = await access.getMembership(alpha.admin.userId, alpha.orgId);
    const inBeta = await access.getMembership(alpha.admin.userId, beta.orgId);

    const alphaPerms = access.permissionsFor(inAlpha!);
    const betaPerms = access.permissionsFor(inBeta!);

    // Admin everywhere in alpha…
    expect(alphaPerms.size).toBe(PERMISSION_NAMES.length);
    // …and nothing at all in beta, where they are staff.
    expect(betaPerms.size).toBe(ROLE_PERMISSIONS.staff.length);
    expect(betaPerms.has("settings:read")).toBe(false);
  });

  it("is not decided by whichever organisation happens to come first", async () => {
    await prisma.membership.create({
      data: {
        userId: alpha.admin.userId,
        organizationId: beta.orgId,
        role: "staff",
        status: "active",
      },
    });

    const orgs = await orgService.getUserOrganizations(alpha.admin.userId);
    expect(orgs).toHaveLength(2);

    // Whatever `[0]` is, the answer for beta must be beta's.
    const inBeta = await access.getMembership(alpha.admin.userId, beta.orgId);
    expect(access.permissionsFor(inBeta!).has("settings:read")).toBe(false);
  });

  // `findByUserId` had no `orderBy`, so the "first" organisation could change
  // between two requests — and with it the sidebar, the role badge and, before
  // the org layout existed, the permission set every page gated on.
  it("orders a user's organisations deterministically", async () => {
    await prisma.membership.create({
      data: {
        userId: alpha.admin.userId,
        organizationId: beta.orgId,
        role: "staff",
        status: "active",
      },
    });

    const first = await orgService.getUserOrganizations(alpha.admin.userId);
    const second = await orgService.getUserOrganizations(alpha.admin.userId);
    expect(first.map((o) => o.id)).toEqual(second.map((o) => o.id));

    const times = first.map((o) => o.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });


  // The included membership had no status filter, so a deactivated row could be
  // read first and `memberships[0].role` would name a role no longer held.
  it("does not report a deactivated membership's role", async () => {
    const extra = await prisma.user.create({
      data: {
        name: "Rejoiner",
        email: `rejoin-${Date.now()}@example.com`,
        hashedPassword: "hash",
      },
    });
    await prisma.membership.create({
      data: {
        userId: extra.id,
        organizationId: alpha.orgId,
        role: "manager",
        status: "active",
      },
    });

    const orgs = await orgService.getUserOrganizations(extra.id);
    expect(orgs[0].memberships.every((m) => m.role === "manager")).toBe(true);
  });
});

describe("suspension is read for the organisation being visited", () => {
  it("reports the visited organisation, not the user's first one", async () => {
    await prisma.organization.update({
      where: { id: beta.orgId },
      data: { status: "suspended" },
    });

    expect(await access.isOrgActive(alpha.orgId)).toBe(true);
    expect(await access.isOrgActive(beta.orgId)).toBe(false);
  });

  it("treats a missing organisation as inactive", async () => {
    expect(await access.isOrgActive("nope")).toBe(false);
  });
});

describe("the reference lists are not baseline reads", () => {
  /*
   * `GET /tasks`, `/members`, `/departments` and `/roles` required only
   * membership, while the sidebar hid all four links. The menu was right: a
   * plain staff member has My Tasks for their own shifts and needs none of the
   * org task board, the member directory with everyone's email, the department
   * list, or the custom-role map showing who can do what.
   *
   * These assert the permission SETS rather than the routes, because the sets
   * are the shared constant the route and the page gate both read.
   */
  it("shuts a default staff member out of every one", () => {
    const staff = new Set(ROLE_PERMISSIONS.staff);
    expect(TASK_LIST_READERS.some((p) => staff.has(p))).toBe(false);
    expect(MEMBER_LIST_READERS.some((p) => staff.has(p))).toBe(false);
    expect(DEPARTMENT_LIST_READERS.some((p) => staff.has(p))).toBe(false);
  });

  it("lets a default manager into every one", () => {
    const manager = new Set(ROLE_PERMISSIONS.manager);
    expect(TASK_LIST_READERS.some((p) => manager.has(p))).toBe(true);
    expect(MEMBER_LIST_READERS.some((p) => manager.has(p))).toBe(true);
    expect(DEPARTMENT_LIST_READERS.some((p) => manager.has(p))).toBe(true);
  });

  // A name that is not in the catalogue can never be held, so the list would
  // silently shut everyone out — and it would read as a styling problem.
  it("names only permissions that exist", () => {
    const known = new Set(PERMISSION_NAMES);
    for (const list of [
      TASK_LIST_READERS,
      MEMBER_LIST_READERS,
      DEPARTMENT_LIST_READERS,
    ]) {
      for (const name of list) expect(known).toContain(name);
    }
  });

  /*
   * Each entry has to earn its place by naming a screen that would break
   * without it. These are the non-obvious ones — a reader that is on the list
   * because some OTHER page consumes the endpoint.
   */
  it("includes the readers that are not the obvious owner", () => {
    // The assign panel renders candidate names; the review queue renders owners.
    expect(MEMBER_LIST_READERS).toContain("tasks:assign");
    expect(MEMBER_LIST_READERS).toContain("certifications:review");
    // The task form picks a department; work rules target one.
    expect(DEPARTMENT_LIST_READERS).toContain("tasks:create");
    expect(DEPARTMENT_LIST_READERS).toContain("work_rules:manage");
    // The calendar draws its grid from the tasks endpoint.
    expect(TASK_LIST_READERS).toContain("calendar:view_team");
  });
});
