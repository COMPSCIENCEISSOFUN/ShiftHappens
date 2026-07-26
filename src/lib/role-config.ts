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

/** Default employment type for new staff members */
export const DEFAULT_EMPLOYMENT_TYPE = "casual";

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