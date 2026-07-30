/**
 * Industry Templates Configuration
 *
 * Single source of truth for onboarding templates.
 * Each template defines departments, work rules, and suggested
 * certifications for a specific industry.
 *
 * Used by: onboarding page (template selector + preview),
 * organization service (applies template after org creation).
 *
 * Template application bypasses subscription tier limits —
 * it's initialization, not a regular user action.
 * After setup, all further additions are subject to tier limits.
 */

export interface TemplateDepartment {
  name: string;
  description: string;
  color: string;
}

export interface TemplateWorkRule {
  name: string;
  type: "break_interval" | "max_hours_daily" | "max_hours_weekly";
  hoursThreshold?: number;
  breakHours?: number;
  maxHours?: number;
  reason: string;
}

export interface TemplateDefinition {
  id: string;
  name: string;
  icon: string;
  description: string;
  departments: TemplateDepartment[];
  workRules: TemplateWorkRule[];
  certifications: string[];
}

/** Data shape for AI-generated or manually crafted custom templates */
export interface CustomTemplateData {
  departments: TemplateDepartment[];
  workRules: TemplateWorkRule[];
  certifications: string[];
}

export const INDUSTRY_TEMPLATES: TemplateDefinition[] = [
  {
    id: "hospitality",
    name: "Hospitality / F&B",
    icon: "UtensilsCrossed",
    description: "Restaurants, cafes, bars, hotels",
    departments: [
      {
        name: "Kitchen",
        description: "Food preparation, cooking, and plating operations",
        color: "#EF4444",
      },
      {
        name: "Bar",
        description: "Beverage service, inventory, and cocktail preparation",
        color: "#3B82F6",
      },
      {
        name: "Front of House",
        description: "Guest relations, table management, dining room",
        color: "#10B981",
      },
    ],
    workRules: [
      {
        name: "Service break interval",
        type: "break_interval",
        hoursThreshold: 6,
        breakHours: 1,
        reason: "Long service periods require regular rest to maintain quality",
      },
      {
        name: "Daily shift cap",
        type: "max_hours_daily",
        maxHours: 10,
        reason: "Prevents fatigue during double shifts in fast-paced kitchens",
      },
    ],
    certifications: ["Food Safety Level 2", "RSA Certification", "First Aid"],
  },
  {
    id: "healthcare",
    name: "Healthcare",
    icon: "HeartPulse",
    description: "Hospitals, clinics, care facilities",
    departments: [
      {
        name: "Emergency",
        description: "Acute care, triage, and emergency response",
        color: "#EF4444",
      },
      {
        name: "General Ward",
        description: "Inpatient care, monitoring, and recovery",
        color: "#3B82F6",
      },
      {
        name: "Outpatient",
        description: "Scheduled consultations, procedures, and follow-ups",
        color: "#10B981",
      },
    ],
    workRules: [
      {
        name: "Shift duration cap",
        type: "max_hours_daily",
        maxHours: 12,
        reason: "Patient safety requires alert, rested staff on every shift",
      },
      {
        name: "Weekly rotation limit",
        type: "max_hours_weekly",
        maxHours: 48,
        reason: "Mandatory rest between rotations to prevent clinical errors",
      },
    ],
    certifications: ["Nursing License", "CPR Certification", "First Aid"],
  },
  {
    id: "retail",
    name: "Retail",
    icon: "ShoppingCart",
    description: "Stores, malls, supermarkets",
    departments: [
      {
        name: "Sales Floor",
        description: "Customer assistance, product display, and merchandising",
        color: "#8B5CF6",
      },
      {
        name: "Warehouse",
        description: "Stock management, receiving, and inventory control",
        color: "#F59E0B",
      },
      {
        name: "Customer Service",
        description: "Returns, inquiries, complaints, and support",
        color: "#10B981",
      },
    ],
    workRules: [
      {
        name: "Floor break interval",
        type: "break_interval",
        hoursThreshold: 6,
        breakHours: 1,
        reason: "Retail staff on their feet for extended periods need regular breaks",
      },
      {
        name: "Casual weekly limit",
        type: "max_hours_weekly",
        maxHours: 38,
        reason: "Standard casual employment cap under retail awards",
      },
    ],
    certifications: ["First Aid", "Cash Handling Certification"],
  },
  {
    id: "construction",
    name: "Construction",
    icon: "HardHat",
    description: "Building, infrastructure, trades",
    departments: [
      {
        name: "Electrical",
        description: "Electrical systems installation, wiring, and maintenance",
        color: "#F59E0B",
      },
      {
        name: "Structural",
        description: "Foundation, framing, and load-bearing construction",
        color: "#6B7280",
      },
      {
        name: "Plumbing",
        description: "Water systems, drainage, and pipe fitting",
        color: "#3B82F6",
      },
    ],
    workRules: [
      {
        name: "Physical labor daily cap",
        type: "max_hours_daily",
        maxHours: 10,
        reason: "Physical fatigue increases injury risk on construction sites",
      },
      {
        name: "Mandatory site break",
        type: "break_interval",
        hoursThreshold: 6,
        breakHours: 1,
        reason: "Safety-critical rest requirement for heavy machinery operators",
      },
    ],
    certifications: [
      "Safety Induction (White Card)",
      "Working at Heights",
      "First Aid",
    ],
  },
  {
    id: "software",
    name: "Software / IT Ops",
    icon: "Server",
    description: "Support desks, on-call rotations, DevOps",
    departments: [
      {
        name: "Helpdesk",
        description: "Tier 1-3 technical support and ticket resolution",
        color: "#3B82F6",
      },
      {
        name: "DevOps",
        description: "Infrastructure, deployments, and system monitoring",
        color: "#10B981",
      },
      {
        name: "QA",
        description: "Testing windows, release validation, and bug triage",
        color: "#8B5CF6",
      },
      {
        name: "Infrastructure",
        description: "Server maintenance, network operations, and patching",
        color: "#F59E0B",
      },
    ],
    workRules: [
      {
        name: "Operations weekly cap",
        type: "max_hours_weekly",
        maxHours: 40,
        reason: "Standard workweek for IT operations to prevent burnout",
      },
      {
        name: "On-call shift cap",
        type: "max_hours_daily",
        maxHours: 12,
        reason: "Sustained alertness required for incident response",
      },
    ],
    certifications: [
      "AWS Certified",
      "ITIL Foundation",
      "Security Clearance",
    ],
  },
];

/** The "Custom" template is handled specially in the UI — not in this array */
export const CUSTOM_TEMPLATE_ID = "custom";

/** Look up a template by ID. Returns undefined for "custom" or invalid IDs. */
export function getTemplateById(id: string): TemplateDefinition | undefined {
  return INDUSTRY_TEMPLATES.find((t) => t.id === id);
}

/** Validate that a custom template has valid structure */
export function validateCustomTemplate(data: unknown): data is CustomTemplateData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;

  if (!Array.isArray(d.departments) || d.departments.length === 0 || d.departments.length > 6) return false;
  if (!Array.isArray(d.workRules) || d.workRules.length > 5) return false;
  if (!Array.isArray(d.certifications) || d.certifications.length > 10) return false;

  const validTypes = ["break_interval", "max_hours_daily", "max_hours_weekly"];

  for (const dept of d.departments) {
    const dep = dept as Record<string, unknown>;
    if (!dep.name || typeof dep.name !== "string") return false;
    if (!dep.color || typeof dep.color !== "string") return false;
  }

  for (const rule of d.workRules) {
    const r = rule as Record<string, unknown>;
    if (!r.name || typeof r.name !== "string") return false;
    if (!r.type || !validTypes.includes(r.type as string)) return false;
  }

  return true;
}
// ============================================================
// Industry selection — <select> value ⇄ stored string
// ============================================================

/**
 * Sentinel for the "Other" option in an industry `<select>`.
 *
 * Deliberately not the bare string "other": platform admins can create
 * templates with arbitrary names, and a template literally named "other"
 * would otherwise be indistinguishable from the free-text escape hatch —
 * selecting it would submit an empty industry and silently clear the field.
 * A double-underscore sentinel cannot collide with a human-entered name.
 */
export const OTHER_INDUSTRY = "__other__";

/** The two control values an industry string maps onto. */
export interface IndustrySelection {
  /** Bound to the `<select>`: a known option, OTHER_INDUSTRY, or "" for unset. */
  select: string;
  /** Bound to the free-text input. Only meaningful when select is OTHER_INDUSTRY. */
  custom: string;
}

/**
 * Maps a stored industry string onto the dropdown + free-text pair.
 *
 * `options` MUST be the resolved list, not a value that is still loading. If it
 * is empty because the option fetch has not finished, every industry — including
 * one chosen from the dropdown itself — classifies as "Other". That was the
 * settings-page bug: the classification ran against an empty array captured on
 * the first render, so the control reverted to Other on every reload while the
 * stored value stayed correct.
 *
 * Degrading to "Other" when the option list genuinely fails to load is the
 * intended behaviour: the value is shown, is editable, and re-saves byte for
 * byte, so a failed fetch cannot lose data.
 */
export function resolveIndustrySelection(
  industry: string | null | undefined,
  options: readonly string[]
): IndustrySelection {
  const value = (industry ?? "").trim();
  if (!value) return { select: "", custom: "" };

  return options.includes(value)
    ? { select: value, custom: "" }
    : { select: OTHER_INDUSTRY, custom: value };
}

/**
 * The inverse of resolveIndustrySelection — what to persist for a given pair.
 *
 * Returns "" rather than null for an unset industry: the API treats an empty
 * string as an explicit clear, and Prisma ignores `undefined`.
 */
export function industryFromSelection(select: string, custom: string): string {
  return select === OTHER_INDUSTRY ? custom.trim() : select.trim();
}
