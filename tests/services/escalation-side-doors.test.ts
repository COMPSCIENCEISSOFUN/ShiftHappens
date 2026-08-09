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
import { RoleService } from "@/services/role.service";
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

/**
 * Editing yourself, without changing your role.
 *
 * The drawer sends the whole shape on every edit, so assigning yourself to a
 * department or setting your own employment type arrives carrying `role`
 * unchanged. The guard threw on the id comparison alone, so an admin could not
 * put themselves in a department at all — they got "You cannot change your own
 * role" for an action that changed no role.
 */
describe("a member editing their own record", () => {
  it("may put themselves in a department", async () => {
    await expect(
      service.updateMemberRole(
        tenant.admin.userId,
        tenant.orgId,
        { role: "company_admin", departmentIds: [tenant.departmentId] },
        tenant.admin.userId
      )
    ).resolves.toBeDefined();

    const memberships = await prisma.departmentMembership.findMany({
      where: { membershipId: tenant.admin.membershipId },
    });
    expect(memberships).toHaveLength(1);
  });

  it("may set their own employment type", async () => {
    await expect(
      service.updateMemberRole(
        tenant.manager.userId,
        tenant.orgId,
        { role: "manager", employmentType: "full_time" },
        tenant.manager.userId
      )
    ).resolves.toBeDefined();
  });

  /*
   * And the rule the guard is actually for still holds. Promoting yourself is
   * the escalation it exists to stop; demoting yourself is how the last admin
   * locks the organisation out of its own settings.
   */
  it("still cannot promote themselves", async () => {
    await expect(
      service.updateMemberRole(
        tenant.manager.userId,
        tenant.orgId,
        { role: "company_admin" },
        tenant.manager.userId
      )
    ).rejects.toThrow(/your own role/i);
  });

  it("still cannot demote themselves", async () => {
    await expect(
      service.updateMemberRole(
        tenant.admin.userId,
        tenant.orgId,
        { role: "staff" },
        tenant.admin.userId
      )
    ).rejects.toThrow(/your own role/i);
  });
});

/**
 * The side door that made all of the above optional.
 *
 * `assertCustomRoleAssignable` refuses to hand somebody a role carrying more
 * than the assigner holds. It runs on ASSIGN, and for eight months that was the
 * only place it ran — so nobody needed to assign anything. Give a manager
 * `roles:manage` and they open the role they are already wearing, tick
 * `billing:manage`, and save. `effectivePermissions` reads a role's permissions
 * live on every request, so they hold it on the next page load: no second
 * person, no assign call, not even a sign-out.
 *
 * These are written from the same side as the tests above — the actor holds
 * only what the screen would give them, and the assertion is that the SERVER
 * refuses, not that the picker greys the box out.
 */
describe("a role cannot be built larger than its author", () => {
  const roles = new RoleService();

  /** The ids behind a set of permission names. */
  async function ids(...names: string[]) {
    const found = await prisma.permission.findMany({
      where: { name: { in: names } },
      select: { id: true },
    });
    if (found.length !== names.length) {
      throw new Error(`seed missing one of: ${names.join(", ")}`);
    }
    return found.map((p) => p.id);
  }

  describe("on create", () => {
    it("refuses a delegate writing in a permission they do not hold", async () => {
      await grant(tenant.manager.userId, ["roles:manage"]);

      await expect(
        roles.create(
          {
            displayLabel: "Overreach",
            permissionIds: await ids("tasks:create", "billing:manage"),
          },
          tenant.orgId,
          tenant.manager.userId
        )
      ).rejects.toThrow("You cannot grant permissions you do not hold");
    });

    it("names the permission that was refused", async () => {
      await grant(tenant.manager.userId, ["roles:manage"]);

      await expect(
        roles.create(
          {
            displayLabel: "Overreach",
            permissionIds: await ids("billing:manage"),
          },
          tenant.orgId,
          tenant.manager.userId
        )
      ).rejects.toThrow(/billing:manage/);
    });

    // Delegating a NARROWER role is what the permission is for, and a guard
    // that blocked this would leave `roles:manage` doing nothing.
    it("allows a delegate building within their own means", async () => {
      await grant(tenant.manager.userId, ["roles:manage"]);

      const role = await roles.create(
        {
          displayLabel: "Task Helper",
          permissionIds: await ids("tasks:create"),
        },
        tenant.orgId,
        tenant.manager.userId
      );

      expect(role.rolePermissions).toHaveLength(1);
    });

    it("never constrains a company admin", async () => {
      const all = await prisma.permission.findMany({ select: { id: true } });

      const role = await roles.create(
        { displayLabel: "Everything", permissionIds: all.map((p) => p.id) },
        tenant.orgId,
        tenant.admin.userId
      );

      expect(role.rolePermissions).toHaveLength(all.length);
    });

    /*
     * The seed builds roles with no human behind them, and would be unable to
     * create an admin role if an absent actor were treated as an actor holding
     * nothing.
     */
    it("skips the check when no actor is named", async () => {
      const role = await roles.create(
        { displayLabel: "Seeded", permissionIds: await ids("billing:manage") },
        tenant.orgId
      );

      expect(role.rolePermissions).toHaveLength(1);
    });

    it("refuses an actor who is not a member of the organisation", async () => {
      const outsider = await createTenant("outsider");

      await expect(
        roles.create(
          { displayLabel: "Foreign", permissionIds: await ids("tasks:create") },
          tenant.orgId,
          outsider.admin.userId
        )
      ).rejects.toThrow("Not authorized to manage roles");
    });
  });

  describe("on update", () => {
    /*
     * The attack itself, in the shape it would actually be carried out: the
     * role being edited is the one the editor is wearing, so the permission
     * they add lands on themselves.
     */
    it("refuses adding to the role the editor is wearing", async () => {
      const worn = await grant(tenant.manager.userId, ["roles:manage"]);

      await expect(
        roles.update(
          worn.id,
          tenant.orgId,
          { permissionIds: await ids("roles:manage", "billing:manage") },
          tenant.manager.userId
        )
      ).rejects.toThrow("You cannot grant permissions you do not hold");
    });

    it("leaves the role untouched when it refuses", async () => {
      const worn = await grant(tenant.manager.userId, ["roles:manage"]);

      await roles
        .update(
          worn.id,
          tenant.orgId,
          {
            displayLabel: "Renamed too",
            permissionIds: await ids("roles:manage", "billing:manage"),
          },
          tenant.manager.userId
        )
        .catch(() => {});

      const after = await roles.getById(worn.id, tenant.orgId);
      expect(after!.rolePermissions).toHaveLength(1);
      expect(after!.displayLabel).toBe("Custom");
    });

    it("refuses adding to somebody else's role just the same", async () => {
      await grant(tenant.manager.userId, ["roles:manage"]);
      const other = await roles.create(
        { displayLabel: "Helper", permissionIds: await ids("tasks:create") },
        tenant.orgId,
        tenant.admin.userId
      );

      await expect(
        roles.update(
          other.id,
          tenant.orgId,
          { permissionIds: await ids("tasks:create", "audit:view") },
          tenant.manager.userId
        )
      ).rejects.toThrow("You cannot grant permissions you do not hold");
    });

    /*
     * The form resends the whole permission list on every save, so judging an
     * edit on everything submitted would refuse a rename over permissions
     * nobody touched — the same failure the self-role guard had when it
     * compared ids instead of comparing the role to the role.
     */
    it("allows renaming a role that already reaches past its editor", async () => {
      await grant(tenant.manager.userId, ["roles:manage"]);
      const built = await roles.create(
        {
          displayLabel: "Auditor",
          permissionIds: await ids("audit:view", "tasks:create"),
        },
        tenant.orgId,
        tenant.admin.userId
      );

      const updated = await roles.update(
        built.id,
        tenant.orgId,
        {
          displayLabel: "Auditor (renamed)",
          permissionIds: built.rolePermissions.map((rp) => rp.permissionId),
        },
        tenant.manager.userId
      );

      expect(updated.displayLabel).toBe("Auditor (renamed)");
    });

    /*
     * Removal grants nobody anything. Checking it would trap a role in a state
     * its current editor is not allowed to reduce, which is the opposite of
     * what the guard is for.
     */
    it("allows removing a permission the editor does not hold", async () => {
      await grant(tenant.manager.userId, ["roles:manage"]);
      const built = await roles.create(
        {
          displayLabel: "Auditor",
          permissionIds: await ids("audit:view", "tasks:create"),
        },
        tenant.orgId,
        tenant.admin.userId
      );

      const updated = await roles.update(
        built.id,
        tenant.orgId,
        { permissionIds: await ids("tasks:create") },
        tenant.manager.userId
      );

      expect(updated.rolePermissions).toHaveLength(1);
    });

    // An edit that touches only the label sends no permission list at all, and
    // must not be judged against one.
    it("allows an edit that sends no permissions", async () => {
      await grant(tenant.manager.userId, ["roles:manage"]);
      const built = await roles.create(
        { displayLabel: "Auditor", permissionIds: await ids("audit:view") },
        tenant.orgId,
        tenant.admin.userId
      );

      const updated = await roles.update(
        built.id,
        tenant.orgId,
        { description: "Reads the log" },
        tenant.manager.userId
      );

      expect(updated.rolePermissions).toHaveLength(1);
    });
  });
});

/**
 * Deleting the role you are wearing.
 *
 * `Membership.customRoleId` is `onDelete: SetNull`, so this is survivable by
 * construction: the membership stays, the link blanks, and the holder falls
 * back to their system bundle. It is allowed — stripping the role from its
 * holders is what deleting one MEANS — but it is irreversible for the person
 * doing it if `roles:manage` was what the role granted, which is why the count
 * is recorded and the confirmation now says so.
 */
describe("deleting a role that people are wearing", () => {
  const roles = new RoleService();

  it("blanks the link without removing anybody from the organisation", async () => {
    const worn = await grant(tenant.manager.userId, ["roles:manage"]);

    await roles.delete(worn.id, tenant.orgId, tenant.manager.userId);

    const after = await access.getMembership(tenant.manager.userId, tenant.orgId);
    expect(after).not.toBeNull();
    expect(after!.customRoleId).toBeNull();
  });

  // The permissions the role carried go with it — including, here, the one
  // that allowed the deletion in the first place.
  it("takes back what the role granted", async () => {
    const worn = await grant(tenant.manager.userId, ["roles:manage"]);

    await roles.delete(worn.id, tenant.orgId, tenant.manager.userId);

    const after = await access.getMembership(tenant.manager.userId, tenant.orgId);
    expect(access.permissionsFor(after!).has("roles:manage")).toBe(false);
  });

  /*
   * Counted before the delete, which is the only moment it can be counted:
   * afterwards every row that pointed at the role has been blanked and there
   * is no record anywhere of who lost what.
   */
  it("records how many people lost it", async () => {
    const role = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "shared",
        displayLabel: "Shared",
        rolePermissions: {
          create: (
            await prisma.permission.findMany({
              where: { name: "tasks:create" },
              select: { id: true },
            })
          ).map((p) => ({ permissionId: p.id })),
        },
      },
    });
    for (const userId of [tenant.manager.userId, tenant.staff.userId]) {
      await service.assignCustomRole(userId, tenant.orgId, role.id, tenant.admin.userId);
    }

    await roles.delete(role.id, tenant.orgId, tenant.admin.userId);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: tenant.orgId, action: "role.deleted" },
      orderBy: { createdAt: "desc" },
    });
    expect((entry.details as { holderCount: number }).holderCount).toBe(2);
  });

  it("records zero for a role nobody was wearing", async () => {
    const role = await roles.create(
      {
        displayLabel: "Unworn",
        permissionIds: (
          await prisma.permission.findMany({
            where: { name: "tasks:create" },
            select: { id: true },
          })
        ).map((p) => p.id),
      },
      tenant.orgId,
      tenant.admin.userId
    );

    await roles.delete(role.id, tenant.orgId, tenant.admin.userId);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: tenant.orgId, action: "role.deleted" },
      orderBy: { createdAt: "desc" },
    });
    expect((entry.details as { holderCount: number }).holderCount).toBe(0);
  });
});
