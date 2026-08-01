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

/** System roles that may occupy task-assignment slots. */
export const ASSIGNABLE_SYSTEM_ROLES = ["staff"] as const;

export function isAssignableSystemRole(role: string): boolean {
  return (ASSIGNABLE_SYSTEM_ROLES as readonly string[]).includes(role);
}

export const EMPLOYMENT_TYPES = ["casual", "temporary_part_time"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  casual: "Casual",
  temporary_part_time: "Temporary or Part-Time",
};

/** Employment type keys for iteration (select options, filters) */
export const EMPLOYMENT_TYPE_KEYS = [...EMPLOYMENT_TYPES];

/** Default employment type for new staff members */
export const DEFAULT_EMPLOYMENT_TYPE = "casual";

/** Maps legacy and missing database values to an approved employment type. */
export function normalizeEmploymentType(
  employmentType?: string | null
): EmploymentType {
  return employmentType === "temporary_part_time"
    ? "temporary_part_time"
    : DEFAULT_EMPLOYMENT_TYPE;
}

/** The approved WBS places weekly availability under this staff type only. */
export function requiresManagedAvailability(
  employmentType?: string | null
): boolean {
  return normalizeEmploymentType(employmentType) === "temporary_part_time";
}

/**
 * Builds the system role display label.
 * For staff, prepends the approved employment type label.
 * Admins and managers don't have employment types.
 */
export function getSystemRoleLabel(
  systemRole: string,
  employmentType?: string | null
): string {
  if (systemRole === "company_admin") return SYSTEM_ROLE_LABELS.company_admin;
  if (systemRole === "manager") return SYSTEM_ROLE_LABELS.manager;

  const empLabel =
    EMPLOYMENT_TYPE_LABELS[normalizeEmploymentType(employmentType)];
  return `${empLabel} Staff`;
}
