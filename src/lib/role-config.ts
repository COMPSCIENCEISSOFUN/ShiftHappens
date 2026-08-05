/**
 * Role and Employment Type Display Configuration
 *
 * Single source of truth for role label rendering across the app.
 * Used by: sidebar, members page, dashboard, anywhere roles are displayed.
 *
 * System roles control ACCESS (what pages/actions you can see).
 * Employment types control SCHEDULING (how the engine treats availability).
 * Custom roles control PERMISSIONS (fine-grained access beyond base role).
 */

export const SYSTEM_ROLE_LABELS: Record<string, string> = {
  company_admin: "Company Admin",
  manager: "Manager",
  staff: "Staff",
};

export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  full_time: "Full-time",
  casual: "Casual",
};

/** Employment type keys for iteration (select options, filters) */
export const EMPLOYMENT_TYPE_KEYS = Object.keys(EMPLOYMENT_TYPE_LABELS);

/**
 * How much authority each system role carries, for comparing two people.
 *
 * Used to stop a role change reaching above the person making it. Ordering the
 * roles is the only way to express "not above your own", and doing it once here
 * keeps that comparison out of the service, where an inline `=== "company_admin"`
 * would quietly answer a different question.
 */
export const ROLE_RANK: Record<string, number> = {
  staff: 0,
  manager: 1,
  company_admin: 2,
};

/**
 * The authority of a role, or -1 for one nobody recognises.
 *
 * Unknown ranks BELOW staff on purpose. `Membership.role` is a plain string, so
 * an unrecognised value is reachable; treating it as the lowest means such a
 * member can change nobody, which is the safe direction. Defaulting it to
 * anything else would hand authority to a typo.
 */
export function roleRank(role: string): number {
  return ROLE_RANK[role] ?? -1;
}

/**
 * The roles that can be put on a shift.
 *
 * Company admins cannot, and three separate places already said so
 * independently: `EligibilityService` filters them out of every candidate list,
 * `TaskService.assignStaff` throws on one, and
 * `MembershipRepository.findSchedulableStaff` excludes them in the query. Stated
 * once here so a fourth caller cannot quietly disagree — which is exactly what
 * happened when the sidebar was rewritten and began offering admins "My Tasks",
 * "My Availability" and "My Certifications", three pages that can never hold
 * anything for them.
 *
 * It is not a permission. No permission set makes an admin rosterable, because
 * the exclusion is about what the engine will consider, not about authority.
 */
export const ROSTERABLE_ROLES = ["staff", "manager"] as const;

/** Can someone in this role be assigned to a shift? */
export function canBeRostered(role: string | undefined | null): boolean {
  return (ROSTERABLE_ROLES as readonly string[]).includes(role ?? "");
}

/** Default employment type for new staff members */
export const DEFAULT_EMPLOYMENT_TYPE = "casual";

/**
 * Is this member employed full-time?
 *
 * NULL means "never set", which the whole codebase already reads as casual —
 * `DEFAULT_EMPLOYMENT_TYPE` above, and the eligibility engine's fallback. That
 * default matters here more than anywhere else: this predicate decides whether
 * declining a shift needs a manager's agreement, and a member whose record was
 * created before the field existed must not silently acquire an obligation
 * nobody recorded them agreeing to.
 */
export function isFullTime(employmentType: string | null | undefined): boolean {
  return (employmentType ?? DEFAULT_EMPLOYMENT_TYPE) === "full_time";
}

/**
 * Builds the system role display label.
 * For staff, prepends employment type (e.g. "Full-time Staff", "Casual Staff").
 * Admins and managers don't have employment types.
 */
export function getSystemRoleLabel(
  systemRole: string,
  employmentType?: string | null
): string {
  if (systemRole === "company_admin") return SYSTEM_ROLE_LABELS.company_admin;
  if (systemRole === "manager") return SYSTEM_ROLE_LABELS.manager;

  const empLabel =
    EMPLOYMENT_TYPE_LABELS[employmentType || "casual"] ||
    EMPLOYMENT_TYPE_LABELS.casual;
  return `${empLabel} Staff`;
}