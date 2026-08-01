/**
 * Mass Import Configuration
 *
 * Centralized mapping config for spreadsheet column recognition
 * and value normalization. Single source of truth for import
 * aliases — pages and services import from here, never hardcode.
 *
 * Derives role and employment type options from role-config.ts.
 * To add support for a new header alias or value variation,
 * update this file only.
 */
import {
  SYSTEM_ROLE_LABELS,
  EMPLOYMENT_TYPE_LABELS,
} from "@/lib/role-config";

// ─── Derived from role-config.ts ─────────────────────────────

/** Roles that can be assigned via import (company_admin excluded) */
export const INVITABLE_ROLES = Object.keys(SYSTEM_ROLE_LABELS).filter(
  (r) => r !== "company_admin"
);

/** All valid employment types */
export const EMPLOYMENT_TYPES = Object.keys(EMPLOYMENT_TYPE_LABELS);

/** Display labels for roles (for preview table dropdowns) */
export const ROLE_DISPLAY: Record<string, string> = Object.fromEntries(
  INVITABLE_ROLES.map((r) => [r, SYSTEM_ROLE_LABELS[r]])
);

/** Display labels for employment types (for preview table dropdowns) */
export const EMPLOYMENT_DISPLAY: Record<string, string> = {
  ...EMPLOYMENT_TYPE_LABELS,
};

// ─── Column header aliases ───────────────────────────────────
// Maps user spreadsheet headers → system field names.
// All values must be lowercase.

export const HEADER_ALIASES: Record<string, string[]> = {
  name: [
    "name", "full name", "employee name", "staff name",
    "member name", "first name",
  ],
  email: [
    "email", "e-mail", "email address", "mail",
  ],
  role: [
    "role", "position", "job title", "type",
  ],
  department: [
    "department", "dept", "team", "section", "unit",
  ],
  employmentType: [
    "employment type", "work type", "contract type",
    "emp type", "employment", "contract", "status",
  ],
};

/** Human-readable labels for expected columns (used in UI help text) */
export const EXPECTED_COLUMNS: { label: string; description: string }[] = [
  { label: "Name", description: "required" },
  { label: "Email", description: "required" },
  {
    label: "Role",
    description: `${Object.values(ROLE_DISPLAY).join(" or ")} — defaults to ${ROLE_DISPLAY[INVITABLE_ROLES[INVITABLE_ROLES.length - 1]]}`,
  },
  { label: "Department", description: "must match existing" },
  {
    label: "Employment Type",
    description: `${Object.values(EMPLOYMENT_DISPLAY).join(" or ")} — defaults to ${EMPLOYMENT_DISPLAY.casual}`,
  },
];

// ─── Value aliases ───────────────────────────────────────────
// Maps common user-entered values → system enum values.
// All keys must be lowercase.

export const ROLE_ALIASES: Record<string, string> = {
  ...Object.fromEntries(INVITABLE_ROLES.map((r) => [r, r])),
  employee: "staff",
  worker: "staff",
  team_member: "staff",
  "team member": "staff",
  supervisor: "manager",
  lead: "manager",
  "team lead": "manager",
};

export const EMPLOYMENT_ALIASES: Record<string, string> = {
  ...Object.fromEntries(EMPLOYMENT_TYPES.map((t) => [t, t])),
  full_time: "casual",
  fulltime: "casual",
  "full-time": "casual",
  "full time": "casual",
  permanent: "casual",
  "part-time": "temporary_part_time",
  "part time": "temporary_part_time",
  parttime: "temporary_part_time",
  "temporary part-time": "temporary_part_time",
  "temporary part time": "temporary_part_time",
  temporary: "temporary_part_time",
  contract: "temporary_part_time",
  temp: "temporary_part_time",
};
