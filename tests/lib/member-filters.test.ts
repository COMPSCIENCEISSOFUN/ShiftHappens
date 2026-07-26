/**
 * Tests for Member Filtering Utilities
 *
 * Covers search, role/employment-type/department/status filters,
 * combined filters, and edge cases (null names, special characters,
 * empty lists, default employment type fallback).
 */
import { describe, it, expect } from "vitest";
import {
  filterMembers,
  hasActiveFilters,
  type FilterableMember,
  type MemberFilters,
} from "@/lib/member-filters";

/* ------------------------------------------------------------------ */
/*  Test data                                                          */
/* ------------------------------------------------------------------ */

const EMPTY_FILTERS: MemberFilters = {
  search: "",
  role: "",
  employmentType: "",
  departmentId: "",
  status: "",
};

function makeMember(overrides: Partial<FilterableMember> & { userId?: string; name?: string | null; email?: string } = {}): FilterableMember {
  return {
    id: overrides.id ?? "mem-1",
    role: overrides.role ?? "staff",
    status: overrides.status ?? "active",
    employmentType: overrides.employmentType ?? null,
    user: {
      id: overrides.userId ?? "user-1",
      name: overrides.name !== undefined ? overrides.name : "Alice Smith",
      email: overrides.email ?? "alice@example.com",
    },
    departmentMemberships: overrides.departmentMemberships ?? [],
  };
}

const kitchen = { department: { id: "dept-kitchen", name: "Kitchen" } };
const bar = { department: { id: "dept-bar", name: "Bar" } };

const MEMBERS: FilterableMember[] = [
  makeMember({ id: "m1", userId: "u1", name: "Alice Smith", email: "alice@oceangrill.com", role: "company_admin", employmentType: null, departmentMemberships: [] }),
  makeMember({ id: "m2", userId: "u2", name: "Bob Jones", email: "bob@oceangrill.com", role: "manager", employmentType: null, departmentMemberships: [kitchen] }),
  makeMember({ id: "m3", userId: "u3", name: "Charlie Brown", email: "charlie@oceangrill.com", role: "staff", employmentType: "full_time", departmentMemberships: [kitchen] }),
  makeMember({ id: "m4", userId: "u4", name: "Diana Lee", email: "diana@oceangrill.com", role: "staff", employmentType: "casual", departmentMemberships: [bar] }),
  makeMember({ id: "m5", userId: "u5", name: "Eve O'Connor", email: "eve@oceangrill.com", role: "staff", employmentType: null, departmentMemberships: [kitchen, bar] }),
  makeMember({ id: "m6", userId: "u6", name: null, email: "noname@oceangrill.com", role: "staff", employmentType: "full_time", departmentMemberships: [], status: "inactive" }),
];

/* ------------------------------------------------------------------ */
/*  hasActiveFilters                                                    */
/* ------------------------------------------------------------------ */

describe("hasActiveFilters", () => {
  it("returns false when all filters are empty", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it("returns true when search is set", () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, search: "alice" })).toBe(true);
  });

  it("returns true when role is set", () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, role: "staff" })).toBe(true);
  });

  it("returns true when employmentType is set", () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, employmentType: "casual" })).toBe(true);
  });

  it("returns true when departmentId is set", () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, departmentId: "dept-1" })).toBe(true);
  });

  it("returns true when status is set", () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, status: "active" })).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  filterMembers — search                                             */
/* ------------------------------------------------------------------ */

describe("filterMembers — search", () => {
  it("returns all members when search is empty", () => {
    const result = filterMembers(MEMBERS, EMPTY_FILTERS);
    expect(result).toHaveLength(MEMBERS.length);
  });

  it("matches by name (case-insensitive)", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "alice" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m1");
  });

  it("matches by email (case-insensitive)", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "CHARLIE@" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m3");
  });

  it("matches partial name", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "li" });
    // "Alice" and "Charlie" both contain "li"
    expect(result).toHaveLength(2);
    const ids = result.map((m) => m.id);
    expect(ids).toContain("m1");
    expect(ids).toContain("m3");
  });

  it("matches partial email", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "oceangrill" });
    expect(result).toHaveLength(MEMBERS.length);
  });

  it("handles member with null name — matches by email only", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "noname" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m6");
  });

  it("handles member with null name — does not crash on name search", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "SomeRandomName" });
    expect(result).toHaveLength(0);
  });

  it("handles special characters in search (apostrophe)", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "O'Con" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m5");
  });

  it("returns empty array when no match", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "zzzznotfound" });
    expect(result).toHaveLength(0);
  });

  it("trims-insensitive — leading/trailing spaces in query still match", () => {
    // The search does not trim, so " alice " should not match "alice"
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: " alice " });
    expect(result).toHaveLength(0);
  });

  it("returns empty array from empty member list", () => {
    const result = filterMembers([], { ...EMPTY_FILTERS, search: "alice" });
    expect(result).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  filterMembers — role filter                                        */
/* ------------------------------------------------------------------ */

describe("filterMembers — role filter", () => {
  it("filters by company_admin", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, role: "company_admin" });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("company_admin");
  });

  it("filters by manager", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, role: "manager" });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("manager");
  });

  it("filters by staff", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, role: "staff" });
    expect(result).toHaveLength(4);
    result.forEach((m) => expect(m.role).toBe("staff"));
  });

  it("returns empty for non-existent role", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, role: "superadmin" });
    expect(result).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  filterMembers — employment type filter                             */
/* ------------------------------------------------------------------ */

describe("filterMembers — employment type filter", () => {
  it("filters full_time members", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, employmentType: "full_time" });
    expect(result).toHaveLength(2); // m3 (explicit) and m6 (explicit)
    const ids = result.map((m) => m.id);
    expect(ids).toContain("m3");
    expect(ids).toContain("m6");
  });

  it("filters casual members — only staff (admins/managers excluded)", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, employmentType: "casual" });
    // m4 (explicit casual), m5 (staff with null → defaults to casual)
    // m1 (admin) and m2 (manager) are excluded — employment type doesn't apply to them
    expect(result).toHaveLength(2);
    const ids = result.map((m) => m.id);
    expect(ids).toContain("m4"); // explicit casual
    expect(ids).toContain("m5"); // staff with null → casual
    expect(ids).not.toContain("m1"); // admin excluded
    expect(ids).not.toContain("m2"); // manager excluded
  });

  it("returns empty for unknown employment type", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, employmentType: "contractor" });
    expect(result).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  filterMembers — department filter                                  */
/* ------------------------------------------------------------------ */

describe("filterMembers — department filter", () => {
  it("filters by Kitchen department", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, departmentId: "dept-kitchen" });
    expect(result).toHaveLength(3); // m2 (Bob), m3 (Charlie), m5 (Eve)
    const ids = result.map((m) => m.id);
    expect(ids).toContain("m2");
    expect(ids).toContain("m3");
    expect(ids).toContain("m5");
  });

  it("filters by Bar department", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, departmentId: "dept-bar" });
    expect(result).toHaveLength(2); // m4 (Diana), m5 (Eve — in both)
    const ids = result.map((m) => m.id);
    expect(ids).toContain("m4");
    expect(ids).toContain("m5");
  });

  it("member in multiple departments appears when filtering by either", () => {
    const kitchenResult = filterMembers(MEMBERS, { ...EMPTY_FILTERS, departmentId: "dept-kitchen" });
    const barResult = filterMembers(MEMBERS, { ...EMPTY_FILTERS, departmentId: "dept-bar" });
    // Eve (m5) is in both
    expect(kitchenResult.map((m) => m.id)).toContain("m5");
    expect(barResult.map((m) => m.id)).toContain("m5");
  });

  it("returns empty for non-existent department", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, departmentId: "dept-nonexistent" });
    expect(result).toHaveLength(0);
  });

  it("excludes members with no department", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, departmentId: "dept-kitchen" });
    const ids = result.map((m) => m.id);
    expect(ids).not.toContain("m1"); // Alice, no dept
    expect(ids).not.toContain("m6"); // null name, no dept
  });
});

/* ------------------------------------------------------------------ */
/*  filterMembers — status filter                                      */
/* ------------------------------------------------------------------ */

describe("filterMembers — status filter", () => {
  it("filters active members", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, status: "active" });
    expect(result).toHaveLength(5);
    result.forEach((m) => expect(m.status).toBe("active"));
  });

  it("filters inactive members", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, status: "inactive" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m6");
  });
});

/* ------------------------------------------------------------------ */
/*  filterMembers — combined filters                                   */
/* ------------------------------------------------------------------ */

describe("filterMembers — combined filters", () => {
  it("search + role: staff named Charlie", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "charlie", role: "staff" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m3");
  });

  it("role + department: staff in Kitchen", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, role: "staff", departmentId: "dept-kitchen" });
    expect(result).toHaveLength(2); // m3 (Charlie) and m5 (Eve)
    const ids = result.map((m) => m.id);
    expect(ids).toContain("m3");
    expect(ids).toContain("m5");
  });

  it("role + employment type: staff + full_time", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, role: "staff", employmentType: "full_time" });
    expect(result).toHaveLength(2); // m3 and m6
  });

  it("search + status: inactive members with 'noname' in email", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "noname", status: "inactive" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m6");
  });

  it("all filters combined that match one member", () => {
    const result = filterMembers(MEMBERS, {
      search: "charlie",
      role: "staff",
      employmentType: "full_time",
      departmentId: "dept-kitchen",
      status: "active",
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("m3");
  });

  it("all filters combined that match no members", () => {
    const result = filterMembers(MEMBERS, {
      search: "alice",
      role: "staff",          // Alice is company_admin
      employmentType: "casual",
      departmentId: "dept-kitchen",
      status: "active",
    });
    expect(result).toHaveLength(0);
  });

  it("contradictory filters return empty", () => {
    const result = filterMembers(MEMBERS, {
      ...EMPTY_FILTERS,
      status: "active",
      search: "noname",  // m6 is inactive
    });
    // noname@oceangrill.com is inactive, so active + noname = 0
    expect(result).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  filterMembers — edge cases                                         */
/* ------------------------------------------------------------------ */

describe("filterMembers — edge cases", () => {
  it("empty member list returns empty", () => {
    const result = filterMembers([], {
      search: "test",
      role: "staff",
      employmentType: "casual",
      departmentId: "dept-1",
      status: "active",
    });
    expect(result).toHaveLength(0);
  });

  it("single member that matches", () => {
    const single = [makeMember({ id: "solo", name: "Solo User", email: "solo@test.com", role: "staff", status: "active" })];
    const result = filterMembers(single, { ...EMPTY_FILTERS, search: "solo" });
    expect(result).toHaveLength(1);
  });

  it("single member that does not match", () => {
    const single = [makeMember({ id: "solo", name: "Solo User", email: "solo@test.com", role: "staff", status: "active" })];
    const result = filterMembers(single, { ...EMPTY_FILTERS, search: "other" });
    expect(result).toHaveLength(0);
  });

  it("search with @ symbol matches email domain", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: "@oceangrill" });
    expect(result).toHaveLength(MEMBERS.length);
  });

  it("search with dot matches email", () => {
    const result = filterMembers(MEMBERS, { ...EMPTY_FILTERS, search: ".com" });
    expect(result).toHaveLength(MEMBERS.length);
  });

  it("does not mutate input array", () => {
    const original = [...MEMBERS];
    filterMembers(MEMBERS, { ...EMPTY_FILTERS, role: "staff" });
    expect(MEMBERS).toEqual(original);
  });
});
