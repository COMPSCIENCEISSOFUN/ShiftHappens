/**
 * Findings from the org-scoping sweep, each pinned by the test that would have
 * caught it.
 *
 * Two shapes recur. An id arriving in a request BODY reached a write without
 * anyone proving it belonged to the caller's organisation — `departmentId` did
 * this on two separate paths. And a department-scoped caller reached a member
 * or a destination outside their departments, because the endpoint asked
 * "may you do this?" and never "to whom?".
 *
 * Out of scope reads as "not found" throughout. Answering "forbidden" would
 * confirm the row exists, which is the fact being protected.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { PATCH as patchTask } from "@/app/api/organizations/[orgId]/tasks/[taskId]/route";
import { PATCH as patchSettings } from "@/app/api/organizations/[orgId]/settings/route";
import { UserManagementService } from "@/services/user-management.service";
import { OrganizationService } from "@/services/organization.service";
import { AvailabilityService } from "@/services/availability.service";
import { asUser } from "../helpers/session";
import { ctx, jsonReq, bodyOf } from "../helpers/route";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const users = new UserManagementService();
const orgs = new OrganizationService();
const availability = new AvailabilityService();

let acme: Tenant;
let rival: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  acme = await createTenant("acme");
  rival = await createTenant("rival");
});

describe("a department id from a request body", () => {
  /*
   * `departmentMembership` carries a membership id and a department id and
   * nothing tying the pair to a tenant, so `assignDepartments` wrote whatever
   * it was handed. The victim organisation could then neither see the row nor
   * delete the department, because the headcount that blocks deletion counts
   * it.
   */
  it("cannot attach one org's member to another org's department", async () => {
    await expect(
      users.updateMemberRole(
        acme.staff.userId,
        acme.orgId,
        { role: "staff", departmentIds: [rival.departmentId] },
        acme.admin.userId
      )
    ).rejects.toThrow("Department not found");
  });

  it("writes nothing when it refuses", async () => {
    await users
      .updateMemberRole(
        acme.staff.userId,
        acme.orgId,
        { role: "staff", departmentIds: [rival.departmentId] },
        acme.admin.userId
      )
      .catch(() => {});

    // Rival's own members legitimately sit in that department — what must not
    // be there is an ACME membership.
    const rows = await prisma.departmentMembership.findMany({
      where: {
        departmentId: rival.departmentId,
        membership: { organizationId: acme.orgId },
      },
    });
    expect(rows).toHaveLength(0);
  });

  // A foreign id smuggled in beside a legitimate one.
  it("refuses a mixed list rather than taking the valid half", async () => {
    await expect(
      users.updateMemberRole(
        acme.staff.userId,
        acme.orgId,
        { role: "staff", departmentIds: [acme.departmentId, rival.departmentId] },
        acme.admin.userId
      )
    ).rejects.toThrow("Department not found");
  });

  it("still allows the organisation's own departments", async () => {
    await users.updateMemberRole(
      acme.staff.userId,
      acme.orgId,
      { role: "staff", departmentIds: [acme.departmentId] },
      acme.admin.userId
    );

    const rows = await prisma.departmentMembership.findMany({
      where: { membershipId: acme.staff.membershipId },
    });
    expect(rows).toHaveLength(1);
  });

  /*
   * The second, independent path. Fixing the PATCH route alone left this open —
   * the id is stored on the invitation and written on ACCEPT, in a flow no
   * admin reviews again.
   */
  it("cannot be smuggled through an invitation either", async () => {
    await expect(
      users.inviteUser(
        {
          email: "smuggled@acme.test",
          role: "staff",
          departmentId: rival.departmentId,
        },
        acme.orgId,
        acme.admin.userId
      )
    ).rejects.toThrow("Department not found");
  });

  it("issues the invitation for a department of its own", async () => {
    const invitation = await users.inviteUser(
      {
        email: "legit@acme.test",
        role: "staff",
        departmentId: acme.departmentId,
      },
      acme.orgId,
      acme.admin.userId
    );
    expect(invitation.departmentId).toBe(acme.departmentId);
  });
});

describe("a scoped caller administering a member", () => {
  let outsider: { userId: string; membershipId: string };
  let otherDeptId: string;

  beforeEach(async () => {
    const dept = await prisma.department.create({
      data: { name: "Front of House", organizationId: acme.orgId },
    });
    otherDeptId = dept.id;

    const user = await prisma.user.create({
      data: { name: "Front Desk", email: "fd@acme.test", hashedPassword: "h" },
    });
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: acme.orgId,
        role: "staff",
        status: "active",
      },
    });
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: otherDeptId },
    });
    outsider = { userId: user.id, membershipId: membership.id };
  });

  /*
   * `members:update_role` is admin-only by DEFAULT, which is why this was
   * missed — but an admin can put it in a custom role, and `permission-guard`
   * states outright that a custom role can never widen a manager's department
   * scope.
   */
  it("cannot change the role of somebody in another department", async () => {
    await expect(
      users.updateMemberRole(
        outsider.userId,
        acme.orgId,
        { role: "staff", departmentIds: [] },
        acme.manager.userId,
        [acme.departmentId]
      )
    ).rejects.toThrow("Membership not found");
  });

  // Stripping departments is the damaging version: it makes somebody silently
  // unrosterable rather than visibly changed.
  it("leaves their departments alone when it refuses", async () => {
    await users
      .updateMemberRole(
        outsider.userId,
        acme.orgId,
        { role: "staff", departmentIds: [] },
        acme.manager.userId,
        [acme.departmentId]
      )
      .catch(() => {});

    const rows = await prisma.departmentMembership.findMany({
      where: { membershipId: outsider.membershipId },
    });
    expect(rows).toHaveLength(1);
  });

  it("cannot deactivate them either", async () => {
    await expect(
      users.toggleMemberStatus(outsider.userId, acme.orgId, acme.manager.userId, [
        acme.departmentId,
      ])
    ).rejects.toThrow("Membership not found");
  });

  it("leaves them active when it refuses", async () => {
    await users
      .toggleMemberStatus(outsider.userId, acme.orgId, acme.manager.userId, [
        acme.departmentId,
      ])
      .catch(() => {});

    const membership = await prisma.membership.findUniqueOrThrow({
      where: { id: outsider.membershipId },
    });
    expect(membership.status).toBe("active");
  });

  it("allows a caller whose scope covers them", async () => {
    const updated = await users.toggleMemberStatus(
      outsider.userId,
      acme.orgId,
      acme.manager.userId,
      [otherDeptId]
    );
    expect(updated.status).toBe("inactive");
  });

  // An unscoped caller is a company admin.
  it("allows an unscoped caller", async () => {
    const updated = await users.toggleMemberStatus(
      outsider.userId,
      acme.orgId,
      acme.admin.userId,
      null
    );
    expect(updated.status).toBe("inactive");
  });
});

describe("what an ordinary member may read about their organisation", () => {
  /*
   * `GET /organizations/[orgId]` is gated on bare membership rather than a
   * permission, and returned an unselected row — so plain staff, who hold no
   * permissions at all, could read the company's Stripe identifiers and learn
   * its card was failing, while being refused the settings and billing screens
   * that say so on purpose.
   */
  it("not the billing columns", async () => {
    await prisma.organization.update({
      where: { id: acme.orgId },
      data: {
        stripeCustomerId: "cus_secret",
        stripeSubscriptionId: "sub_secret",
        subscriptionStatus: "past_due",
        billingInterval: "month",
        address: "1 Private Road",
      },
    });

    const org = (await orgs.getOrganization(acme.orgId)) as Record<string, unknown>;

    expect(org).not.toHaveProperty("stripeCustomerId");
    expect(org).not.toHaveProperty("stripeSubscriptionId");
    expect(org).not.toHaveProperty("subscriptionStatus");
    expect(org).not.toHaveProperty("billingInterval");
    expect(org).not.toHaveProperty("address");
  });

  it("but still everything the app renders", async () => {
    const org = (await orgs.getOrganization(acme.orgId)) as Record<string, unknown>;
    expect(org).toMatchObject({ id: acme.orgId });
    for (const field of ["name", "slug", "status", "subscriptionTier"]) {
      expect(org).toHaveProperty(field);
    }
  });
});

describe("pending leave on a shift", () => {
  /*
   * The rows carry a free-text `reason`. This passed a hardcoded unrestricted
   * scope while both siblings on the same panel narrowed to the task's
   * population, so a manager was reading why members of other departments had
   * asked for time off.
   */
  it("is limited to the caller's departments", async () => {
    const otherDept = await prisma.department.create({
      data: { name: "Security", organizationId: acme.orgId },
    });
    const user = await prisma.user.create({
      data: { name: "Guard", email: "guard@acme.test", hashedPassword: "h" },
    });
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: acme.orgId,
        role: "staff",
        status: "active",
        employmentType: "full_time",
      },
    });
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: otherDept.id },
    });

    const start = new Date(Date.now() + 10 * 86_400_000);
    start.setUTCHours(10, 0, 0, 0);
    const task = await prisma.task.create({
      data: {
        organizationId: acme.orgId,
        departmentId: acme.departmentId,
        createdById: acme.admin.userId,
        title: "Dinner",
        status: "open",
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 4 * 3_600_000),
      },
    });

    await availability.createOverride(membership.id, {
      date: start.toISOString(),
      isAvailable: false,
      reason: "Chemotherapy",
    });

    const scoped = await availability.getPendingLeaveForTask(task.id, acme.orgId, [
      acme.departmentId,
    ]);
    expect(scoped.map((r) => r.membershipId)).not.toContain(membership.id);

    // The same call unrestricted still sees it — proving the row exists and the
    // scope is what excluded it, rather than the fixture being empty.
    const unscoped = await availability.getPendingLeaveForTask(
      task.id,
      acme.orgId,
      null
    );
    expect(unscoped.map((r) => r.membershipId)).toContain(membership.id);
  });
});

describe("moving a task between departments", () => {
  async function moveTo(departmentId: string | null) {
    const task = await prisma.task.create({
      data: {
        organizationId: acme.orgId,
        departmentId: acme.departmentId,
        createdById: acme.admin.userId,
        title: "Kitchen shift",
        status: "open",
      },
    });
    asUser(acme.manager.userId);
    const res = await patchTask(
      jsonReq("PATCH", { departmentId }),
      ctx({ orgId: acme.orgId, taskId: task.id })
    );
    return { res, taskId: task.id };
  }

  it("refuses a destination outside the caller's scope", async () => {
    const other = await prisma.department.create({
      data: { name: "Security", organizationId: acme.orgId },
    });
    const { res } = await moveTo(other.id);
    expect(res.status).toBe(404);
  });

  /*
   * `isDepartmentInScope` treats a department-less resource as out of scope for
   * every non-admin, so clearing the field would make the task invisible and
   * unmanageable to all managers at once — a write no manager could have made
   * through the create endpoint.
   */
  it("refuses clearing the department entirely", async () => {
    const { res } = await moveTo(null);
    expect(res.status).toBe(404);
  });

  it("allows a destination inside it", async () => {
    const { res } = await moveTo(acme.departmentId);
    expect(res.status).toBe(200);
  });
});

describe("the settings endpoint answering about an org you are not in", () => {
  /*
   * `checkOrgActive` returns false both for a suspended organisation and for
   * one that does not exist, so running it before the permission gate made the
   * reply distinguish "real but suspended" from "real and active" from
   * "yours" — an existence-and-status oracle reachable by iterating ids.
   */
  it("says Forbidden, not Suspended", async () => {
    await prisma.organization.update({
      where: { id: rival.orgId },
      data: { status: "suspended" },
    });

    asUser(acme.admin.userId);
    const res = await patchSettings(
      jsonReq("PATCH", { allocationMode: "auto" }),
      ctx({ orgId: rival.orgId })
    );

    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ error: "Forbidden" });
  });

  it("still tells a real member their org is suspended", async () => {
    await prisma.organization.update({
      where: { id: acme.orgId },
      data: { status: "suspended" },
    });

    asUser(acme.admin.userId);
    const res = await patchSettings(
      jsonReq("PATCH", { allocationMode: "auto" }),
      ctx({ orgId: acme.orgId })
    );

    expect(res.status).toBe(403);
    expect(String((await bodyOf(res)).error)).toMatch(/suspended/i);
  });
});
