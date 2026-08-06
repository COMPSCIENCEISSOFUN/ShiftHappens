/**
 * Department Scoping (Boundary/Control helper)
 *
 * Company Admins have organization-wide access. Managers (and other non-admin
 * roles) are scoped to the department(s) they belong to — they can only see
 * and act on tasks, members, and allocations within those departments
 * (PRD §2.2, §4.5).
 *
 * A `null` scope means "unrestricted" (company admin). An array scopes to those
 * department IDs. A resource with no department is out of scope for anyone who
 * is scoped (only admins can touch org-wide, department-less resources).
 *
 * Everything in this file is a PURE function of a membership — no database, no
 * framework — so it can be unit tested directly and reused by both routes
 * (Boundary) and services (Control).
 *
 * The two lookups that used to live here (`isTaskInScope`,
 * `isAssignmentTaskInScope`) queried Prisma, which made a lib file the Boundary
 * imports reach Entity directly. They now live on `AccessService`
 * (`src/services/access.service.ts`) and are reached through Control.
 */

export interface ScopableMembership {
  role: string;
  departmentMemberships?: { department: { id: string } }[];
}

/**
 * The department IDs a member is scoped to, or `null` when unrestricted.
 * Company admins are unrestricted; everyone else is limited to their
 * assigned departments (which may be an empty list).
 */
export function departmentScopeFor(membership: ScopableMembership): string[] | null {
  if (membership.role === "company_admin") return null;
  return (membership.departmentMemberships ?? []).map((dm) => dm.department.id);
}

/**
 * Is this member inside the caller's department scope?
 *
 * `undefined`/`null` is unrestricted — a company admin. An ARRAY is the
 * caller's own departments, and an EMPTY array therefore means "no
 * departments", matching nobody. That distinction is the difference between a
 * manager seeing nothing and a manager seeing the whole organisation.
 *
 * Distinct from `isDepartmentInScope`, which asks about a resource's single
 * department. A member belongs to several, and belonging to ANY of the
 * caller's is enough.
 */
export function memberInScope(
  membership: { departmentMemberships?: { department: { id: string } }[] },
  departmentScope?: string[] | null
): boolean {
  if (departmentScope === undefined || departmentScope === null) return true;
  const scope = new Set(departmentScope);
  return (membership.departmentMemberships ?? []).some((dm) =>
    scope.has(dm.department.id)
  );
}

/**
 * Whether a department is within a scope. `null` scope allows everything;
 * a resource with no department is never in scope for a scoped member.
 */
export function isDepartmentInScope(
  departmentId: string | null | undefined,
  scope: string[] | null
): boolean {
  if (scope === null) return true;
  if (!departmentId) return false;
  return scope.includes(departmentId);
}

