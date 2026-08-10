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

  /**
   * `reports:export` was kept OUT of that map for a documented reason that
   * described a product nobody built: that the route served CSV on every plan
   * and gated only the PDF format, so listing it would take CSV away from Free.
   *
   * There is no CSV. The route has no format parameter and returns a PDF
   * unconditionally, `PdfReportService` renders nothing else, and the pricing
   * table carries a single row — "PDF report export", Free: no.
   *
   * Pinned as a mapping because what it prevents is silent. Unmapped, the plan
   * is consulted after the permission, so a Free caller is refused with
   * "Forbidden" for a feature that no amount of permission can unlock.
   */
  it("gates the PDF export on the plan that sells it", () => {
    expect(PERMISSION_FEATURE["reports:export"]).toBe("pdf_export");
  });

  /**
   * The description is not documentation — it is the label an admin reads while
   * ticking boxes on the Roles screen, so it is part of the interface. This one
   * advertised a format the product has never been able to produce.
   */
  it("does not advertise an export format the product cannot produce", () => {
    const exportPermission = PERMISSIONS.find((p) => p.name === "reports:export");
    expect(exportPermission).toBeDefined();
    expect(exportPermission?.description).not.toMatch(/CSV/i);
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
   * The reversal, and the test that used to assert the opposite.
   *
   * Under replace semantics `[]` and `null` HAD to differ — an empty role meant
   * "nothing", and collapsing the two would have made it grant the whole system
   * bundle. Adding rather than replacing dissolves the distinction: a role
   * holding nothing contributes nothing.
   *
   * Worth keeping as its own test rather than deleting, because the old
   * behaviour is the one a reader will expect if they meet a role called
   * "Empty" in a database and assume it locks somebody out.
   */
  it("leaves a manager untouched by a custom role holding nothing", () => {
    expect(effectivePermissions("manager", [])).toEqual(
      effectivePermissions("manager", null)
    );
    expect(effectivePermissions("manager", []).size).toBeGreaterThan(0);
  });

  /**
   * The staff bundle is empty ON PURPOSE — every permission it held enforced
   * nothing. Asserted rather than left implicit, because an empty array reads
   * like an oversight.
   */
  it("gives a plain staff member no permissions, by design", () => {
    expect(effectivePermissions("staff", null).size).toBe(0);
  });

  /**
   * A custom role CANNOT narrow a manager. This asserted the opposite before —
   * it is the behaviour the change removes, so it is inverted rather than
   * deleted: a reader who remembers narrowing should find the answer here
   * instead of finding nothing.
   *
   * Taking `tasks:delete` away from a manager is now expressed by making them
   * staff and granting what they may do, which also moves their rank, which is
   * the honest consequence of the same decision.
   */
  it("does not let a custom role narrow a manager", () => {
    const perms = effectivePermissions("manager", ["tasks:update"]);
    expect(perms.has("tasks:update")).toBe(true);
    expect(perms.has("tasks:delete")).toBe(true);
  });

  /**
   * The Shift Lead. A staff member starts from nothing, so their role is the
   * whole of what they hold — which is how a strict role is still expressible
   * with no way to subtract.
   */
  it("lets a custom role widen what a staff member may do", () => {
    const perms = effectivePermissions("staff", [
      "tasks:assign",
      "certifications:review",
    ]);
    expect(perms.has("certifications:review")).toBe(true);
    expect(perms.has("tasks:assign")).toBe(true);
    // And nothing beyond what was ticked — the empty staff bundle is what
    // makes that true, and why emptying it turned out to be load-bearing.
    expect(perms.has("tasks:delete")).toBe(false);
    expect(perms.size).toBe(2);
  });

  it("adds a role's permissions to the manager bundle rather than replacing it", () => {
    const perms = effectivePermissions("manager", ["work_rules:manage"]);

    expect(perms.has("work_rules:manage")).toBe(true);
    for (const inherited of ROLE_PERMISSIONS.manager) {
      expect(perms.has(inherited), `manager lost ${inherited}`).toBe(true);
    }
  });

  /**
   * The drift this change exists to stop.
   *
   * `assignments:correct_clock` was added to the manager bundle in August.
   * Every manager got it; every custom role composed by copying that bundle did
   * not, and never would for any later addition. Inheritance means a role built
   * last month keeps up with a bundle that moves.
   *
   * Named explicitly rather than asserted over the whole bundle, because the
   * loop above already does that — this one is about the DATE, and a reader
   * meeting it should be able to see which addition made the point.
   */
  it("gives a role built before a bundle grew the permission added later", () => {
    const builtEarlier = ["tasks:assign"];
    expect(
      effectivePermissions("manager", builtEarlier).has("assignments:correct_clock")
    ).toBe(true);
  });

  /**
   * Rank is a separate scale and no role touches it. A staff member can end up
   * holding more permissions than a manager — that is the point of a Shift
   * Lead — and still cannot administer one, because the escalation guards read
   * `ROLE_RANK`, not this set.
   */
  it("can leave a staff member holding more than a plain manager", () => {
    const perms = effectivePermissions("staff", [
      ...ROLE_PERMISSIONS.manager,
      "work_rules:manage",
    ]);
    expect(perms.size).toBeGreaterThan(effectivePermissions("manager", null).size);
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
