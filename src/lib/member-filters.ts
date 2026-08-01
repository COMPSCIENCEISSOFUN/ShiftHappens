/**
 * Member Filtering Utilities
 *
 * Pure functions for filtering the members list on the members page.
 * Extracted from the component so edge cases can be unit-tested.
 *
 * All filtering is client-side — no API calls needed since the
 * full member list is already loaded.
 */
import { normalizeEmploymentType } from "@/lib/role-config";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface FilterableMember {
  id: string;
  role: string;
  status: string;
  employmentType: string | null;
  customRole?: { id: string; name: string; displayLabel: string } | null;
  user: {
    id: string;
    name: string | null;
    email: string;
  };
  departmentMemberships: {
    department: { id: string; name: string };
  }[];
}

export interface MemberFilters {
  search: string;
  role: string;
  employmentType: string;
  departmentId: string;
  status: string;
}

/* ------------------------------------------------------------------ */
/*  Filter logic                                                       */
/* ------------------------------------------------------------------ */

/** Returns true when at least one filter has a non-empty value. */
export function hasActiveFilters(filters: MemberFilters): boolean {
  return !!(
    filters.search ||
    filters.role ||
    filters.employmentType ||
    filters.departmentId ||
    filters.status
  );
}

/**
 * Filters a member list by the given criteria.
 *
 * - Search: case-insensitive partial match on name OR email
 * - Role: exact match on system role key
 * - Employment type: exact match; members with null employmentType
 *   are treated as the default (casual)
 * - Department: member belongs to the department (by id)
 * - Status: exact match on "active" / "inactive"
 *
 * All filters are AND-combined — a member must pass every
 * non-empty filter to appear in the result.
 */
export function filterMembers(
  members: FilterableMember[],
  filters: MemberFilters
): FilterableMember[] {
  return members.filter((m) => {
    // ── Search (name or email, case-insensitive partial match) ──
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const nameMatch = m.user.name?.toLowerCase().includes(q) ?? false;
      const emailMatch = m.user.email.toLowerCase().includes(q);
      if (!nameMatch && !emailMatch) return false;
    }

    // ── Role ──
    if (filters.role && m.role !== filters.role) return false;

    // ── Employment type (only applies to staff; admins/managers have none) ──
    if (filters.employmentType) {
      if (m.role !== "staff") return false;
      const empType = normalizeEmploymentType(m.employmentType);
      if (empType !== filters.employmentType) return false;
    }

    // ── Department ──
    if (filters.departmentId) {
      const inDept = m.departmentMemberships.some(
        (dm) => dm.department.id === filters.departmentId
      );
      if (!inDept) return false;
    }

    // ── Status ──
    if (filters.status && m.status !== filters.status) return false;

    return true;
  });
}
