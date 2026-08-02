/**
 * Role label rendering.
 *
 * One function decides what the sidebar, members table and dashboard call a
 * person. The branch worth pinning is the fallback: an employment type the app
 * does not recognise must still produce a sensible label rather than
 * "undefined Staff", because employmentType is nullable for admins and managers
 * and was added to staff after the first members already existed.
 */
import { describe, it, expect } from "vitest";
import {
  getSystemRoleLabel,
  SYSTEM_ROLE_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPE_KEYS,
  DEFAULT_EMPLOYMENT_TYPE,
} from "@/lib/role-config";

describe("getSystemRoleLabel", () => {
  it("labels a company admin", () => {
    expect(getSystemRoleLabel("company_admin")).toBe("Company Admin");
  });

  it("labels a manager", () => {
    expect(getSystemRoleLabel("manager")).toBe("Manager");
  });

  it("ignores employment type for admins and managers", () => {
    // Their rows carry null, but a stray value must not become "Full-time Manager".
    expect(getSystemRoleLabel("company_admin", "full_time")).toBe("Company Admin");
    expect(getSystemRoleLabel("manager", "casual")).toBe("Manager");
  });

  it("prepends employment type for staff", () => {
    expect(getSystemRoleLabel("staff", "full_time")).toBe("Full-time Staff");
    expect(getSystemRoleLabel("staff", "casual")).toBe("Casual Staff");
  });

  it("falls back to casual when employment type is missing", () => {
    expect(getSystemRoleLabel("staff")).toBe("Casual Staff");
    expect(getSystemRoleLabel("staff", null)).toBe("Casual Staff");
    expect(getSystemRoleLabel("staff", "")).toBe("Casual Staff");
  });

  it("falls back to casual for an unrecognised employment type", () => {
    expect(getSystemRoleLabel("staff", "contractor")).toBe("Casual Staff");
  });

  it("never renders undefined into the label", () => {
    for (const value of [undefined, null, "", "part_time", "FULL_TIME"]) {
      expect(getSystemRoleLabel("staff", value)).not.toContain("undefined");
    }
  });

  it("treats an unknown system role as staff", () => {
    // Not a designed behaviour so much as a consequence of the two early
    // returns — pinned so a typo'd role renders as "Casual Staff" rather than
    // crashing, and so anyone adding a fourth role sees they must add a branch.
    expect(getSystemRoleLabel("platform_admin")).toBe("Casual Staff");
  });

  it("is case sensitive on the role", () => {
    expect(getSystemRoleLabel("Manager")).toBe("Casual Staff");
  });
});

describe("exported tables", () => {
  it("covers every system role stored on a membership", () => {
    expect(Object.keys(SYSTEM_ROLE_LABELS).sort()).toEqual([
      "company_admin",
      "manager",
      "staff",
    ]);
  });

  it("keeps EMPLOYMENT_TYPE_KEYS in step with the labels", () => {
    // Select options iterate the keys and render via the labels; a key with no
    // label would draw a blank option.
    expect(EMPLOYMENT_TYPE_KEYS).toEqual(Object.keys(EMPLOYMENT_TYPE_LABELS));
  });

  it("has a default employment type that is a real option", () => {
    expect(EMPLOYMENT_TYPE_KEYS).toContain(DEFAULT_EMPLOYMENT_TYPE);
  });

  it("agrees with the fallback used inside getSystemRoleLabel", () => {
    expect(getSystemRoleLabel("staff", DEFAULT_EMPLOYMENT_TYPE)).toBe(
      getSystemRoleLabel("staff", "unknown_type")
    );
  });
});
