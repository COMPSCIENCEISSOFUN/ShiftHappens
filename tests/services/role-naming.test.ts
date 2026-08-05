/**
 * One name field, and uniqueness on the one people read.
 *
 * ## The bug
 *
 * `@@unique([organizationId, name])` put the uniqueness rule on the stored
 * `name` — a field the form asked a manager to invent, annotated "Used in code.
 * Lowercase, no spaces." Nothing read it, the format was never validated, and
 * it could not be changed after creation.
 *
 * So two roles could both be labelled "Shift Lead" — stored as `shift_lead` and
 * `shiftlead` — and appear as two identical entries in the roles list, the
 * members dropdown and the work-rule targeting picker, with nothing on screen
 * distinguishing them. The constraint guarded the invisible field and left the
 * visible one open.
 *
 * The form now asks for one name. The slug is derived, and the LABEL is what
 * uniqueness applies to.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RoleService } from "@/services/role.service";
import { createRoleSchema, updateRoleSchema } from "@/lib/validations";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const roleService = new RoleService();

let tenant: Tenant;
let permissionIds: string[];

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("rolename");
  const permissions = await prisma.permission.findMany({ take: 2 });
  permissionIds = permissions.map((p) => p.id);
});

function make(displayLabel: string, description?: string) {
  return roleService.create(
    { displayLabel, description, permissionIds },
    tenant.orgId,
    tenant.admin.userId
  );
}

describe("the stored name is derived", () => {
  it("comes from the label the user typed", async () => {
    const role = await make("Shift Lead");
    expect(role.name).toBe("shift_lead");
    expect(role.displayLabel).toBe("Shift Lead");
  });

  it("survives punctuation the old field claimed to forbid but allowed", async () => {
    const role = await make("Front-of-House Supervisor");
    expect(role.name).toBe("front_of_house_supervisor");
  });

  it("trims the label rather than storing the whitespace", async () => {
    const role = await make("  Shift Lead  ");
    expect(role.displayLabel).toBe("Shift Lead");
    expect(role.name).toBe("shift_lead");
  });

  /*
   * Two genuinely different labels can still slug identically, and both must be
   * creatable: the label check passes — "Shift Lead" and "Shift-Lead" differ
   * even case-insensitively — so the slug suffix is what keeps the database
   * index satisfied. Case variants are NOT this case; those are refused as the
   * same label, which the block below covers.
   */
  it("suffixes the slug when two different labels collide on it", async () => {
    const first = await make("Shift Lead");
    const second = await make("Shift-Lead");

    expect(first.name).toBe("shift_lead");
    expect(second.name).toBe("shift_lead_2");
    // Both are visible and distinguishable, which is the point.
    expect(second.displayLabel).toBe("Shift-Lead");
  });
});

describe("two roles cannot look identical", () => {
  it("refuses a second role with the same label", async () => {
    await make("Shift Lead");

    await expect(make("Shift Lead")).rejects.toThrow(
      'A role called "Shift Lead" already exists'
    );
  });

  // Case-insensitive: "Shift Lead" and "SHIFT LEAD" are the same role to
  // anybody reading a dropdown, and refusing only the exact match would let the
  // list fill with near-duplicates.
  it("refuses one differing only in case", async () => {
    await make("Shift Lead");
    await expect(make("SHIFT LEAD")).rejects.toThrow(/already exists/);
  });

  it("refuses one differing only in surrounding whitespace", async () => {
    await make("Shift Lead");
    await expect(make("  Shift Lead ")).rejects.toThrow(/already exists/);
  });

  it("names the label in the message, not the derived slug", async () => {
    await make("Shift Lead");
    const message = await make("Shift Lead").catch((e: Error) => e.message);

    expect(message).toContain("Shift Lead");
    expect(message).not.toContain("shift_lead");
  });

  it("allows the same label in a different organisation", async () => {
    const other = await createTenant("otherorg");
    await make("Shift Lead");

    const theirs = await roleService.create(
      { displayLabel: "Shift Lead", permissionIds },
      other.orgId,
      other.admin.userId
    );
    expect(theirs.displayLabel).toBe("Shift Lead");
  });
});

describe("renaming", () => {
  it("is possible at all, which it was not for the stored name", async () => {
    const role = await make("Shift Lead");

    const updated = await roleService.update(
      role.id,
      tenant.orgId,
      { displayLabel: "Shift Supervisor" },
      tenant.admin.userId
    );
    expect(updated.displayLabel).toBe("Shift Supervisor");
  });

  it("respects the same uniqueness the create path does", async () => {
    await make("Shift Lead");
    const other = await make("Bar Lead");

    await expect(
      roleService.update(
        other.id,
        tenant.orgId,
        { displayLabel: "Shift Lead" },
        tenant.admin.userId
      )
    ).rejects.toThrow(/already exists/);
  });

  // Saving a role without changing its label must not collide with itself.
  it("allows a role to keep its own label", async () => {
    const role = await make("Shift Lead");

    const updated = await roleService.update(
      role.id,
      tenant.orgId,
      { displayLabel: "Shift Lead", description: "Runs the evening" },
      tenant.admin.userId
    );
    expect(updated.description).toBe("Runs the evening");
  });

  /*
   * The stored name deliberately does NOT follow a rename.
   *
   * It appears in audit entries already written, and re-slugging it would make
   * yesterday's log refer to a name that no longer exists. Nothing reads it, so
   * letting it drift costs nothing — the same reason the form stopped asking
   * for it.
   */
  it("leaves the derived name alone", async () => {
    const role = await make("Shift Lead");
    const updated = await roleService.update(
      role.id,
      tenant.orgId,
      { displayLabel: "Shift Supervisor" },
      tenant.admin.userId
    );

    expect(updated.name).toBe("shift_lead");
  });
});

describe("what the schema accepts", () => {
  it("no longer takes a name", () => {
    const parsed = createRoleSchema.safeParse({
      name: "shift_lead",
      displayLabel: "Shift Lead",
      permissionIds: ["p1"],
    });
    // Zod strips unknown keys rather than failing, so the assertion is that it
    // does not reach the service — not that the request is rejected.
    expect(parsed.success).toBe(true);
    expect(parsed.success && "name" in parsed.data).toBe(false);
  });

  /*
   * A label with no letters or digits has no honest slug, and the service would
   * have nothing to store. Refused at the boundary so the message names the
   * field the user can see.
   */
  it("refuses a label with nothing usable in it", () => {
    for (const displayLabel of ["!!!", "   ", "🎉"]) {
      const parsed = createRoleSchema.safeParse({
        displayLabel,
        permissionIds: ["p1"],
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("applies the same rule to a rename", () => {
    expect(updateRoleSchema.safeParse({ displayLabel: "!!!" }).success).toBe(
      false
    );
    expect(
      updateRoleSchema.safeParse({ displayLabel: "Shift Lead" }).success
    ).toBe(true);
  });

  it("still requires at least one permission", () => {
    const parsed = createRoleSchema.safeParse({
      displayLabel: "Shift Lead",
      permissionIds: [],
    });
    expect(parsed.success).toBe(false);
  });
});
