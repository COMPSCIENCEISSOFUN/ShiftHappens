/**
 * The escalation paths that do NOT go through the role picker.
 *
 * `assertMayChangeRole` guards `updateMemberRole`, and for a while that was the
 * whole defence. It covers exactly one of the five ways authority moves:
 *
 *   updateMemberRole      — guarded from the start
 *   inviteUser            — creates a membership at any role
 *   batchImportMembers    — the same, a hundred rows at a time
 *   assignCustomRole      — hands over permissions rather than a title
 *   toggleMemberStatus    — takes authority away instead of granting it
 *
 * Each of the last four is reachable with a single permission an admin might
 * reasonably delegate, and each ends somewhere the role picker refuses to go.
 * The tests below are written from the attacker's side: the actor holds only
 * what the screen offers them, and the assertion is that the request is
 * refused, not that the UI hides it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { UserManagementService } from "@/services/user-management.service";
import { AccessService } from "@/services/access.service";
import { prisma } from "@/lib/prisma";
import { inviteUserSchema } from "@/lib/validations";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new UserManagementService();
const access = new AccessService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("sidedoor");
});

/** A custom role holding exactly the named permissions, given to `userId`. */
async function grant(userId: string, permissionNames: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { name: { in: permissionNames } },
  });
  if (permissions.length !== permissionNames.length) {
    throw new Error(
      `seed missing: wanted ${permissionNames.join(", ")}, found ${permissions
        .map((p) => p.name)
        .join(", ")}`
    );
  }
  const role = await prisma.role.create({
    data: {
      organizationId: tenant.orgId,
      name: `custom-${permissionNames.join("-")}-${userId.slice(0, 6)}`,
      displayLabel: "Custom",
      rolePermissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
  });
  await service.assignCustomRole(userId, tenant.orgId, role.id, tenant.admin.userId);
  return role;
}

describe("an invitation cannot reach above the inviter", () => {
  it("refuses a staff recruiter inviting a manager", async () => {
    await grant(tenant.staff.userId, ["members:invite"]);

    await expect(
      service.inviteUser(
        { email: "new@example.com", role: "manager" },
        tenant.orgId,
        tenant.staff.userId
      )
    ).rejects.toThrow("You cannot grant a role above your own");
  });

  /*
   * `company_admin` is not in `inviteUserSchema`, so the boundary refuses it
   * before the service is reached. Asserted here rather than assumed: the
   * service guard is the second line, and if that enum ever widened, the guard
   * above is what would still hold. The cast is deliberate — it is what a
   * request bypassing validation would look like.
   */
  it("refuses a manager inviting a company admin, even past validation", async () => {
    await expect(
      service.inviteUser(
        { email: "new@example.com", role: "company_admin" } as unknown as Parameters<
          typeof service.inviteUser
        >[0],
        tenant.orgId,
        tenant.manager.userId
      )
    ).rejects.toThrow("You cannot grant a role above your own");
  });

  it("does not accept company_admin at the boundary at all", () => {
    const parsed = inviteUserSchema.safeParse({
      email: "new@example.com",
      role: "company_admin",
    });
    expect(parsed.success).toBe(false);
  });

  // The permission still does what it says — only the ceiling is new.
  it("allows a manager inviting staff", async () => {
    const invitation = await service.inviteUser(
      { email: "fine@example.com", role: "staff" },
      tenant.orgId,
      tenant.manager.userId
    );
    expect(invitation.role).toBe("staff");
  });

  it("allows an admin inviting a manager", async () => {
    const invitation = await service.inviteUser(
      { email: "mgr@example.com", role: "manager" },
      tenant.orgId,
      tenant.admin.userId
    );
    expect(invitation.role).toBe("manager");
  });

  it("refuses an actor with no membership in the organisation", async () => {
    await expect(
      service.inviteUser(
        { email: "x@example.com", role: "staff" },
        tenant.orgId,
        tenant.outsider.userId
      )
    ).rejects.toThrow("Not authorized to change roles");
  });
});

describe("batch import carries the same ceiling", () => {
  const row = (email: string, role: string) => ({
    name: "Imported",
    email,
    role,
    departmentName: null,
    employmentType: "casual",
  });

  it("refuses the row that reaches above the importer", async () => {
    const result = await service.batchImportMembers(
      tenant.orgId,
      [row("boss@example.com", "company_admin")],
      tenant.manager.userId
    );

    expect(result.created).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("above your own");
  });

  /*
   * Per row, not per file. A spreadsheet with one mistyped role should not
   * discard the rows that were fine — that turns a correctable typo into a
   * re-upload, and the partial-success contract is the whole point of this
   * method.
   */
  it("keeps the rows that were within the importer's authority", async () => {
    const result = await service.batchImportMembers(
      tenant.orgId,
      [
        row("ok1@example.com", "staff"),
        row("boss@example.com", "company_admin"),
        row("ok2@example.com", "staff"),
      ],
      tenant.manager.userId
    );

    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
  });

  it("lets an admin import a manager", async () => {
    const result = await service.batchImportMembers(
      tenant.orgId,
      [row("mgr@example.com", "manager")],
      tenant.admin.userId
    );
    expect(result.created).toBe(1);
  });
});

describe("a custom role cannot carry more than the person assigning it", () => {
  it("refuses granting a permission the actor does not hold", async () => {
    await grant(tenant.manager.userId, ["members:update_role"]);

    const powerful = await prisma.permission.findMany({
      where: { name: { in: ["billing:manage", "audit:view"] } },
    });
    const role = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "everything",
        displayLabel: "Everything",
        rolePermissions: {
          create: powerful.map((p) => ({ permissionId: p.id })),
        },
      },
    });

    await expect(
      service.assignCustomRole(
        tenant.staff.userId,
        tenant.orgId,
        role.id,
        tenant.manager.userId
      )
    ).rejects.toThrow("You cannot grant permissions you do not hold");
  });

  // The delegation the permission exists for: a NARROWER role, freely.
  it("allows granting a subset of what the actor holds", async () => {
    await grant(tenant.manager.userId, [
      "members:update_role",
      "tasks:create",
      "tasks:delete",
    ]);

    const narrower = await prisma.permission.findMany({
      where: { name: { in: ["tasks:create"] } },
    });
    const role = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "task-creator",
        displayLabel: "Task creator",
        rolePermissions: {
          create: narrower.map((p) => ({ permissionId: p.id })),
        },
      },
    });

    await service.assignCustomRole(
      tenant.staff.userId,
      tenant.orgId,
      role.id,
      tenant.manager.userId
    );

    const membership = await access.getMembership(tenant.staff.userId, tenant.orgId);
    expect(access.permissionsFor(membership!).has("tasks:create")).toBe(true);
  });

  // A company admin holds the whole catalogue, so the subset test can never
  // constrain one. Worth pinning: the guard must not become an admin tax.
  it("never constrains a company admin", async () => {
    const all = await prisma.permission.findMany();
    const role = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "all",
        displayLabel: "All",
        rolePermissions: { create: all.map((p) => ({ permissionId: p.id })) },
      },
    });

    await service.assignCustomRole(
      tenant.staff.userId,
      tenant.orgId,
      role.id,
      tenant.admin.userId
    );

    const membership = await access.getMembership(tenant.staff.userId, tenant.orgId);
    expect(access.permissionsFor(membership!).size).toBe(all.length);
  });
});

describe("deactivation is an authority switch and is ranked like one", () => {
  /*
   * The most damaging of the four, because it needs no target role at all.
   * `findByUserAndOrg` filters on `status: "active"`, so a deactivated
   * membership fails every guard in the product — one permission, applied in a
   * loop, locks the organisation out of itself.
   */
  it("refuses a staff holder of members:deactivate deactivating an admin", async () => {
    await grant(tenant.staff.userId, ["members:deactivate"]);

    await expect(
      service.toggleMemberStatus(
        tenant.admin.userId,
        tenant.orgId,
        tenant.staff.userId
      )
    ).rejects.toThrow("above your own");
  });

  it("refuses a manager deactivating a company admin", async () => {
    await expect(
      service.toggleMemberStatus(
        tenant.admin.userId,
        tenant.orgId,
        tenant.manager.userId
      )
    ).rejects.toThrow("above your own");
  });

  // Not vanity: an admin who deactivates themselves while other admins remain
  // passes the last-admin guard and cannot undo it.
  it("refuses deactivating yourself", async () => {
    await expect(
      service.toggleMemberStatus(
        tenant.manager.userId,
        tenant.orgId,
        tenant.manager.userId
      )
    ).rejects.toThrow("your own status");
  });

  it("still lets a manager deactivate staff", async () => {
    const updated = await service.toggleMemberStatus(
      tenant.staff.userId,
      tenant.orgId,
      tenant.manager.userId
    );
    expect(updated.status).toBe("inactive");
  });

  // Reactivation goes through the same method, so the guards must not block it.
  it("still lets a manager reactivate staff", async () => {
    await service.toggleMemberStatus(
      tenant.staff.userId,
      tenant.orgId,
      tenant.manager.userId
    );
    const back = await service.toggleMemberStatus(
      tenant.staff.userId,
      tenant.orgId,
      tenant.manager.userId
    );
    expect(back.status).toBe("active");
  });
});

describe("the two halves of a role change succeed or fail together", () => {
  /*
   * The route applied the system role first and the custom role second. A
   * custom role from another org made the second half throw 404 — after the
   * first had written a promotion and audit-logged it. The screen reported a
   * failure; the database held a new manager.
   */
  it("does not promote when the custom role in the same request is invalid", async () => {
    const other = await createTenant("other");
    const foreign = await prisma.role.create({
      data: {
        organizationId: other.orgId,
        name: "foreign",
        displayLabel: "Foreign",
      },
    });

    await expect(
      service.updateMemberRole(
        tenant.staff.userId,
        tenant.orgId,
        { role: "manager", customRoleId: foreign.id },
        tenant.admin.userId
      )
    ).rejects.toThrow("Custom role not found");

    const membership = await access.getMembership(tenant.staff.userId, tenant.orgId);
    expect(membership?.role).toBe("staff");
  });
});
