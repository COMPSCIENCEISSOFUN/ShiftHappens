import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  effectivePermissions,
  hasPermission,
} from "@/lib/permission-guard";

function membership(
  role: string,
  permissionNames?: string[]
) {
  return {
    role,
    customRoleId:
      permissionNames === undefined ? null : "custom-role-id",
    customRole:
      permissionNames === undefined
        ? null
        : {
            rolePermissions: permissionNames.map((name) => ({
              permission: { name },
            })),
          },
  };
}

describe("permission guard", () => {
  it("gives Company Admin every supported permission", () => {
    const admin = membership("company_admin", []);
    expect(hasPermission(admin, PERMISSIONS.AUDIT_VIEW)).toBe(true);
    expect(hasPermission(admin, PERMISSIONS.TASKS_DELETE)).toBe(true);
  });

  it("preserves existing Manager defaults without a custom role", () => {
    const manager = membership("manager");
    expect(hasPermission(manager, PERMISSIONS.TASKS_CREATE)).toBe(true);
    expect(hasPermission(manager, PERMISSIONS.CERTIFICATIONS_REVIEW)).toBe(true);
    expect(hasPermission(manager, PERMISSIONS.ROLES_CREATE)).toBe(false);
  });

  it("preserves Staff defaults for shared read-only resources", () => {
    const staff = membership("staff");
    expect(hasPermission(staff, PERMISSIONS.DEPARTMENTS_READ)).toBe(true);
    expect(hasPermission(staff, PERMISSIONS.TASKS_CREATE)).toBe(false);
  });

  it("uses an assigned custom role as the effective operational permission set", () => {
    const customManager = membership("manager", ["reports:view"]);
    expect(hasPermission(customManager, PERMISSIONS.REPORTS_VIEW)).toBe(true);
    expect(hasPermission(customManager, PERMISSIONS.TASKS_CREATE)).toBe(false);
  });

  it("can grant a Staff member an operational permission", () => {
    const shiftLead = membership("staff", ["tasks:create", "tasks:read"]);
    expect(hasPermission(shiftLead, PERMISSIONS.TASKS_CREATE)).toBe(true);
    expect(hasPermission(shiftLead, PERMISSIONS.TASKS_READ)).toBe(true);
    expect(hasPermission(shiftLead, PERMISSIONS.TASKS_DELETE)).toBe(false);
  });

  it("returns a deduplicated effective permission set", () => {
    const shiftLead = membership("staff", ["tasks:read", "tasks:read"]);
    expect(effectivePermissions(shiftLead)).toEqual(new Set(["tasks:read"]));
  });
});
