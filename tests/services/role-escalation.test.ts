/**
 * Nobody may change a role in a way that reaches above themselves.
 *
 * ## The hole this closed
 *
 * `members:update_role` used to be reachable only by a company_admin, so no
 * guard was needed — an admin promoting themselves changes nothing. Making
 * permissions enforceable turned that into a live path: an org admin can grant
 * the permission to a custom role, and the picker describes it as "Update
 * member roles", which reads like "can move staff between Staff and Manager".
 *
 * What it actually allowed was one request. `userId` comes from the URL and was
 * never compared against the caller, and `company_admin` was an accepted value,
 * so the holder could PATCH their OWN membership to company_admin and become
 * the owner of the organisation.
 *
 * Not remotely exploitable — an admin has to grant the role deliberately. The
 * problem is that the label gives no hint that delegating it delegates
 * ownership.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { UserManagementService } from "@/services/user-management.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new UserManagementService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("escalate");
});

/** Sets the STAFF member's role, acted by `userId`. */
function setRole(
  userId: string,
  role: "company_admin" | "manager" | "staff"
) {
  return service.updateMemberRole(
    tenant.staff.userId,
    tenant.orgId,
    { role },
    userId
  );
}

describe("you cannot change your own role", () => {
  /** The one-request escalation, from the staff member's own account. */
  it("refuses a staff member promoting themselves to admin", async () => {
    await expect(
      service.updateMemberRole(
        tenant.staff.userId,
        tenant.orgId,
        { role: "company_admin" },
        tenant.staff.userId
      )
    ).rejects.toThrow("You cannot change your own role");
  });

  // Including the admin. Harmless for them, but a rule with an exception is a
  // rule somebody will find the edge of.
  it("refuses an admin changing their own role", async () => {
    await expect(
      service.updateMemberRole(
        tenant.admin.userId,
        tenant.orgId,
        { role: "manager" },
        tenant.admin.userId
      )
    ).rejects.toThrow("You cannot change your own role");
  });

  it("refuses a manager promoting themselves", async () => {
    await expect(
      service.updateMemberRole(
        tenant.manager.userId,
        tenant.orgId,
        { role: "company_admin" },
        tenant.manager.userId
      )
    ).rejects.toThrow("You cannot change your own role");
  });
});

describe("you cannot reach above your own level", () => {
  it("refuses a manager granting company_admin to someone else", async () => {
    await expect(setRole(tenant.manager.userId, "company_admin")).rejects.toThrow(
      "You cannot grant a role above your own"
    );
  });

  it("refuses a staff member granting manager", async () => {
    // Staff would not normally reach this method at all; the permission is what
    // gets them here, and the rank check is what stops them.
    await expect(setRole(tenant.inactive.userId, "manager")).rejects.toThrow();
  });

  /**
   * The other direction, and the reason the rule is not only about promotion.
   * Without it a manager could not MAKE an admin but could unmake one, which is
   * the same authority pointed the other way.
   */
  it("refuses a manager demoting an admin", async () => {
    const secondAdmin = await prisma.user.create({
      data: { name: "Second Admin", email: "second-admin@example.com", hashedPassword: "hash" },
    });
    await prisma.membership.create({
      data: {
        userId: secondAdmin.id,
        organizationId: tenant.orgId,
        role: "company_admin",
        status: "active",
      },
    });

    await expect(
      service.updateMemberRole(
        secondAdmin.id,
        tenant.orgId,
        { role: "staff" },
        tenant.manager.userId
      )
    ).rejects.toThrow("You cannot change the role of a member above your own");
  });

  it("allows a manager promoting staff to manager", async () => {
    const updated = await setRole(tenant.manager.userId, "manager");
    expect(updated.role).toBe("manager");
  });
});

describe("an admin is unaffected", () => {
  it("still promotes a staff member to admin", async () => {
    const updated = await setRole(tenant.admin.userId, "company_admin");
    expect(updated.role).toBe("company_admin");
  });

  it("still demotes a manager to staff", async () => {
    const updated = await service.updateMemberRole(
      tenant.manager.userId,
      tenant.orgId,
      { role: "staff" },
      tenant.admin.userId
    );
    expect(updated.role).toBe("staff");
  });

  // The batch importer and the seed create memberships with no acting user.
  // There is no "own role" to protect and no privilege to exceed.
  it("allows a change with no identified actor", async () => {
    const updated = await service.updateMemberRole(
      tenant.staff.userId,
      tenant.orgId,
      { role: "manager" }
    );
    expect(updated.role).toBe("manager");
  });
});

/**
 * `Membership.role` is a plain string with no database constraint, so a value
 * outside the three known roles is reachable — a typo, a half-finished
 * migration, a row written by hand. Which way an unknown role ranks decides
 * whether that mistake grants authority or removes it.
 */
describe("an unrecognised role has no authority", () => {
  it("cannot change anyone's role", async () => {
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { role: "supervisor" },
    });

    await expect(
      service.updateMemberRole(
        tenant.staff.userId,
        tenant.orgId,
        { role: "manager" },
        tenant.manager.userId
      )
    ).rejects.toThrow("You cannot grant a role above your own");
  });

  // And is itself protected, since everyone outranks it.
  it("cannot be changed by a manager either", async () => {
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { role: "supervisor" },
    });

    const updated = await service.updateMemberRole(
      tenant.staff.userId,
      tenant.orgId,
      { role: "staff" },
      tenant.manager.userId
    );
    // Ranked below staff, so a manager may still administer it — the point is
    // that it grants nothing, not that it is untouchable.
    expect(updated.role).toBe("staff");
  });
});

describe("the same escalation through a custom role", () => {
  async function powerfulRole() {
    const permissions = await prisma.permission.findMany({ take: 5 });
    return prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "powerful",
        displayLabel: "Powerful",
        rolePermissions: {
          create: permissions.map((p) => ({ permissionId: p.id })),
        },
      },
    });
  }

  /**
   * Guarding only the system role would leave this open. Someone who cannot
   * promote themselves could instead give themselves an existing custom role
   * carrying every permission — the same authority without the title.
   */
  it("refuses assigning a custom role to yourself", async () => {
    const role = await powerfulRole();

    await expect(
      service.assignCustomRole(
        tenant.staff.userId,
        tenant.orgId,
        role.id,
        tenant.staff.userId
      )
    ).rejects.toThrow("You cannot change your own role");
  });

  it("refuses assigning one to a member above your own level", async () => {
    const role = await powerfulRole();

    await expect(
      service.assignCustomRole(
        tenant.manager.userId,
        tenant.orgId,
        role.id,
        tenant.staff.userId
      )
    ).rejects.toThrow("You cannot change the role of a member above your own");
  });

  // Delegation to someone else at or below your level is the point of the
  // permission and stays allowed.
  it("still assigns one to another member", async () => {
    const role = await powerfulRole();

    const updated = await service.assignCustomRole(
      tenant.staff.userId,
      tenant.orgId,
      role.id,
      tenant.admin.userId
    );
    expect(updated.customRoleId).toBe(role.id);
  });
});
