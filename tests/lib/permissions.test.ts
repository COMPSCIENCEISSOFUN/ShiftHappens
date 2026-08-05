/**
 * The permission model.
 *
 * An audit found the catalogue was seeded, displayed and never read: a custom
 * role with everything ticked granted nothing, one with nothing ticked took
 * nothing away. These tests pin the rules that now decide access — and, just as
 * importantly, the ones that stop a permission from reaching further than it
 * should.
 */
import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_NAMES,
  PERMISSION_FEATURE,
  ROLE_PERMISSIONS,
  effectivePermissions,
  hasPermission,
} from "@/lib/permissions";

describe("the catalogue", () => {
  it("has no duplicate names", () => {
    expect(new Set(PERMISSION_NAMES).size).toBe(PERMISSION_NAMES.length);
  });

  it("gives every permission a description and a category", () => {
    for (const p of PERMISSIONS) {
      expect(p.description.trim()).not.toBe("");
      expect(p.category.trim()).not.toBe("");
    }
  });

  /**
   * These names must not change. `RolePermission` rows point at
   * `Permission.name`, so a rename silently empties a role somebody composed
   * and nothing reports the orphan.
   *
   * The list is what SURVIVED the audit that left the catalogue at 28. Sixteen
   * were retired deliberately — twelve that enforced nothing (six baseline
   * reads, six self-service), plus `roles:create/update/delete` merged into
   * `roles:manage` and `work_rules:read` folded into `work_rules:manage`.
   * `prisma/seed.ts` deletes rows the catalogue no longer defines, so they
   * leave the picker too.
   */
  it("keeps the name of every permission that survived the cut", () => {
    const kept = [
      "departments:create", "departments:update", "departments:delete",
      "members:invite", "members:update_role", "members:deactivate",
      "tasks:create", "tasks:update", "tasks:delete", "tasks:assign",
      "eligibility:view", "eligibility:override",
      "allocation:use_suggestions", "allocation:auto_allocate",
      "reports:view", "reports:export",
      "settings:read", "settings:update",
      "organization:update", "audit:view",
    ];
    for (const name of kept) expect(PERMISSION_NAMES).toContain(name);
  });

  // The retired ones must STAY gone. Re-adding one without wiring it would put
  // the catalogue back where it started: entries that decide nothing.
  it("does not reintroduce a retired permission", () => {
    const retired = [
      "departments:read", "members:read", "tasks:read", "roles:read",
      "organization:read", "calendar:view",
      "tasks:accept_reject", "tasks:clock", "certifications:submit",
      "calendar:manage_availability", "notifications:receive", "notifications:manage",
      "roles:create", "roles:update", "roles:delete", "work_rules:read",
    ];
    for (const name of retired) expect(PERMISSION_NAMES).not.toContain(name);
  });

  // A bundle naming a permission that does not exist is a permission nobody can
  // ever hold, and it would fail silently — the route would just 403.
  it("defines every permission the role bundles reference", () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      for (const p of perms) {
        expect(PERMISSION_NAMES, `${role} references ${p}`).toContain(p);
      }
    }
  });

  it("maps only real permissions to gated features", () => {
    for (const name of Object.keys(PERMISSION_FEATURE)) {
      expect(PERMISSION_NAMES).toContain(name);
    }
  });
});

describe("the role bundles", () => {
  it("gives managers everything staff have", () => {
    for (const p of ROLE_PERMISSIONS.staff) {
      expect(ROLE_PERMISSIONS.manager).toContain(p);
    }
  });

  /**
   * The admin-only surface, spelled out. If one of these ever appears in the
   * manager bundle, a manager silently gains the ability to change the
   * organisation's shape — billing, membership, work rules, the roles
   * themselves — and no route test would notice, because the route would be
   * doing exactly what it was told.
   */
  it("keeps the organisation-shaping permissions out of the manager bundle", () => {
    const adminOnly = [
      "organization:update",
      "settings:read",
      "settings:update",
      "members:invite",
      "members:update_role",
      "members:deactivate",
      "departments:create",
      "departments:update",
      "departments:delete",
      "work_rules:manage",
      "roles:manage",
      "audit:view",
      "billing:manage",
      "allocation:auto_schedule",
    ];
    for (const p of adminOnly) {
      expect(ROLE_PERMISSIONS.manager, `manager should not hold ${p}`).not.toContain(p);
    }
  });

  it("leaves the staff bundle empty", () => {
    expect(ROLE_PERMISSIONS.staff).toEqual([]);
  });
});

describe("effectivePermissions", () => {
  it("gives a company admin everything", () => {
    const perms = effectivePermissions("company_admin", null);
    expect(perms.size).toBe(PERMISSION_NAMES.length);
  });

  /**
   * An admin cannot be given a custom role — `assignCustomRole` refuses — but
   * if that guard were ever bypassed, the person who edits roles must not be
   * able to lock themselves out of the roles screen.
   */
  it("ignores a custom role attached to an admin", () => {
    const perms = effectivePermissions("company_admin", []);
    expect(perms.has("roles:manage")).toBe(true);
  });

  it("falls back to the system bundle when there is no custom role", () => {
    expect(effectivePermissions("manager", null).has("tasks:assign")).toBe(true);
    expect(effectivePermissions("staff", null).has("tasks:assign")).toBe(false);
  });

  /**
   * The distinction the whole model rests on. `null` means "no custom role";
   * `[]` means "a role an admin deliberately composed with nothing in it".
   * Collapsing them would make an empty role behave like no role at all, and a
   * role could then never be used to take anything away.
   */
  it("treats an empty custom role as nothing, not as no custom role", () => {
    // Read on a MANAGER: the staff bundle is now deliberately empty, so staff
    // could not tell the two cases apart and would prove nothing here.
    expect(effectivePermissions("manager", []).size).toBe(0);
    expect(effectivePermissions("manager", null).size).toBeGreaterThan(0);
  });

  /**
   * The staff bundle is empty ON PURPOSE — every permission it held enforced
   * nothing. Asserted rather than left implicit, because an empty array reads
   * like an oversight.
   */
  it("gives a plain staff member no permissions, by design", () => {
    expect(effectivePermissions("staff", null).size).toBe(0);
  });

  it("lets a custom role narrow what a manager may do", () => {
    const perms = effectivePermissions("manager", ["tasks:update", "tasks:assign"]);
    expect(perms.has("tasks:assign")).toBe(true);
    // A shift lead who may fill a shift but not delete one.
    expect(perms.has("tasks:delete")).toBe(false);
  });

  /**
   * The Shift Lead. Now that every permission is a manager or admin action,
   * giving a staff member a custom role is purely additive.
   */
  it("lets a custom role widen what a staff member may do", () => {
    const perms = effectivePermissions("staff", [
      "tasks:assign",
      "certifications:review",
    ]);
    expect(perms.has("certifications:review")).toBe(true);
    expect(perms.has("tasks:assign")).toBe(true);
    // And nothing beyond what was ticked.
    expect(perms.has("tasks:delete")).toBe(false);
  });

  it("gives an unknown system role nothing rather than defaulting open", () => {
    expect(effectivePermissions("some_new_role", null).size).toBe(0);
  });
});

describe("hasPermission", () => {
  it("answers on exact names, not prefixes", () => {
    const perms = new Set(["tasks:read"]);
    expect(hasPermission(perms, "tasks:read")).toBe(true);
    expect(hasPermission(perms, "tasks")).toBe(false);
    expect(hasPermission(perms, "tasks:read:extra")).toBe(false);
  });
});
