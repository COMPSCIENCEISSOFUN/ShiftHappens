/**
 * What the log says when somebody's custom role changes.
 *
 * ## Two events under one name
 *
 * Assigning a custom role and changing a system role both wrote
 * `member.role_changed`. They are different acts on different fields carrying
 * different details — `{previousRole, newRole, …}` for one and a bare
 * `{customRoleId}` for the other — so the filter could not separate them and no
 * reader could tell which had happened without inspecting the shape of the
 * details. They are now two actions, and the old name is kept in the page's
 * label map because rows written before the split still carry it.
 *
 * ## An id is not a record
 *
 * The entry stored a cuid and nothing else. Deleting a custom role is allowed
 * and silently strips its holders, so the moment the role went the entry
 * pointed at nothing and nobody could say what the member had been granted —
 * the log recorded that something changed and destroyed the evidence of what.
 * The label is captured before the write, for the same reason the role-delete
 * entry counts its holders before deleting them.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { UserManagementService } from "@/services/user-management.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { eventuallyMatching } from "../helpers/settle";

const users = new UserManagementService();

let tenant: Tenant;

async function makeRole(label: string) {
  return prisma.role.create({
    data: {
      organizationId: tenant.orgId,
      name: label.toLowerCase().replace(/\s+/g, "_"),
      displayLabel: label,
    },
  });
}

function roleEntries() {
  return prisma.auditLog.findMany({
    where: {
      organizationId: tenant.orgId,
      action: { in: ["member.custom_role_assigned", "member.custom_role_cleared"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("audit-role");
});

describe("assigning a custom role", () => {
  it("records it under its own action, with the role's name", async () => {
    const role = await makeRole("Shift Lead");

    await users.assignCustomRole(
      tenant.staff.userId,
      tenant.orgId,
      role.id,
      tenant.admin.userId
    );

    const entries = await eventuallyMatching(roleEntries, () => true);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("member.custom_role_assigned");
    expect(entries[0].entityId).toBe(tenant.staff.userId);

    const details = entries[0].details as Record<string, unknown>;
    expect(details.customRoleId).toBe(role.id);
    /*
     * The NAME, which is the whole point. Delete the role afterwards and the id
     * resolves to nothing — this is the only part of the entry that still means
     * something to a reader a month later.
     */
    expect(details.roleLabel).toBe("Shift Lead");
  });

  it("survives the role being deleted afterwards", async () => {
    const role = await makeRole("Rota Manager");
    await users.assignCustomRole(
      tenant.staff.userId,
      tenant.orgId,
      role.id,
      tenant.admin.userId
    );
    await eventuallyMatching(roleEntries, () => true);

    await prisma.role.delete({ where: { id: role.id } });

    const [entry] = await roleEntries();
    expect((entry.details as Record<string, unknown>).roleLabel).toBe(
      "Rota Manager"
    );
  });

  it("names what they held before, when they held something", async () => {
    const first = await makeRole("Shift Lead");
    const second = await makeRole("Rota Manager");

    await users.assignCustomRole(
      tenant.staff.userId,
      tenant.orgId,
      first.id,
      tenant.admin.userId
    );
    await eventuallyMatching(roleEntries, (e) => e.action.endsWith("assigned"));

    await users.assignCustomRole(
      tenant.staff.userId,
      tenant.orgId,
      second.id,
      tenant.admin.userId
    );

    const entries = await eventuallyMatching(
      roleEntries,
      (e) =>
        (e.details as Record<string, unknown>)?.previousRoleLabel === "Shift Lead"
    );
    const latest = entries[entries.length - 1].details as Record<string, unknown>;

    // "Assigned Rota Manager" and "moved from Shift Lead to Rota Manager" are
    // different facts, and only the second says what the member lost.
    expect(latest.roleLabel).toBe("Rota Manager");
    expect(latest.previousRoleLabel).toBe("Shift Lead");
  });
});

describe("removing a custom role", () => {
  it("records a removal, not an assignment", async () => {
    const role = await makeRole("Shift Lead");
    await users.assignCustomRole(
      tenant.staff.userId,
      tenant.orgId,
      role.id,
      tenant.admin.userId
    );
    await eventuallyMatching(roleEntries, (e) => e.action.endsWith("assigned"));

    await users.assignCustomRole(
      tenant.staff.userId,
      tenant.orgId,
      null,
      tenant.admin.userId
    );

    const entries = await eventuallyMatching(roleEntries, (e) =>
      e.action.endsWith("cleared")
    );
    const cleared = entries.find((e) => e.action.endsWith("cleared"));

    expect(cleared).toBeDefined();
    const details = cleared!.details as Record<string, unknown>;
    expect(details.customRoleId).toBeNull();
    // What they lost is the only interesting fact about a removal.
    expect(details.previousRoleLabel).toBe("Shift Lead");
  });
});

describe("the system role keeps its own action", () => {
  /*
   * The split must not have moved system-role changes onto the new name.
   * Existing rows and existing readers depend on `member.role_changed` meaning
   * what it always meant.
   */
  it("still writes member.role_changed", async () => {
    await users.updateMemberRole(
      tenant.staff.userId,
      tenant.orgId,
      { role: "manager" },
      tenant.admin.userId
    );

    const entries = await eventuallyMatching(
      () =>
        prisma.auditLog.findMany({
          where: { organizationId: tenant.orgId, action: "member.role_changed" },
        }),
      () => true
    );

    expect(entries.length).toBeGreaterThan(0);
    expect(
      (entries[0].details as Record<string, unknown>).newRole
    ).toBe("manager");
  });
});
