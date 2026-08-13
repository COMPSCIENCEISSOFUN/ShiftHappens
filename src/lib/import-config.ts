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
    // "type" deliberately absent. A column headed "Type" in an HR export almost
    // always means employment type, not job role — claiming it here made every
    // row fail with `Unknown role: "Full-time"`, and the preview UI lets you
    // correct values but not the column mapping, so the import was unrecoverable
    // without editing the spreadsheet.
    "role", "position", "job title",
  ],
  department: [
    "department", "dept", "team", "section", "unit",
  ],
  employmentType: [
    // "status" deliberately absent — in an HR export it nearly always means
    // active/inactive, so claiming it here made every row fail with
    // `Unknown type: "Active"`. "employment status" is unambiguous and is
    // accepted instead.
    "employment type", "employment status", "work type", "contract type",
    "emp type", "employment", "contract", "type",
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

/**
 * The columns a BULK INVITE file may carry.
 *
 * Deliberately not `EXPECTED_COLUMNS`, which describes the mass-import file.
 * The two look similar and mean different things:
 *
 *   - Mass import creates memberships directly, so it needs a `Name` — nobody
 *     is ever going to type one.
 *   - An invitation is accepted by a person who fills in their own name and
 *     password on the way in. Asking an admin to supply a name here would
 *     produce a field that is collected, stored on nothing, and contradicted by
 *     whatever the invitee types ten minutes later.
 *
 * `required` drives the preview's validation as well as the help text, so the
 * dialog cannot promise one thing and enforce another.
 */
export const INVITE_COLUMNS: {
  key: "email" | "role" | "department" | "employmentType";
  label: string;
  required: boolean;
  description: string;
}[] = [
  {
    key: "email",
    label: "Email",
    required: true,
    description: "Where the invitation is sent. One person per row.",
  },
  {
    key: "role",
    label: "Role",
    required: false,
    description: `${Object.values(ROLE_DISPLAY).join(" or ")} — defaults to ${ROLE_DISPLAY[INVITABLE_ROLES[INVITABLE_ROLES.length - 1]]}`,
  },
  {
    key: "department",
    label: "Department",
    required: false,
    description: "Must match a department you already have. Blank for none.",
  },
  {
    key: "employmentType",
    label: "Employment Type",
    required: false,
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
  fulltime: "full_time",
  "full-time": "full_time",
  "full time": "full_time",
  permanent: "full_time",
  "part-time": "casual",
  "part time": "casual",
  parttime: "casual",
  temporary: "casual",
  contract: "casual",
  temp: "casual",
};