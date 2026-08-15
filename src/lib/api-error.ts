/**
 * Turning an API error response into something a person can act on.
 */

/** Zod's `flatten()` shape, which is what every route sends. */
interface ZodFlattened {
  formErrors?: string[];
  fieldErrors?: Record<string, string[] | undefined>;
}

interface ApiErrorBody {
  error?: unknown;
  details?: unknown;
}

/**
 * Field names as the reader knows them.
 *
 * `scheduledStart` is what the schema calls it and what nobody calls it. The
 * map is deliberately small: an unlisted field falls back to its own name with
 * the camelCase split, which is imperfect but honest — better a slightly stiff
 * "required headcount" than a confident label for the wrong field.
 */
const FIELD_LABEL: Record<string, string> = {
  title: "Title",
  description: "Description",
  departmentId: "Department",
  departmentIds: "Departments",
  projectId: "Project",
  requiredHeadcount: "People needed",
  requiredCertifications: "Certifications",
  priority: "Priority",
  status: "Status",
  scheduledStart: "Start time",
  scheduledEnd: "End time",
  plannedStart: "Planned start",
  plannedEnd: "Planned end",
  recurringPattern: "Repeat pattern",
  compositionRules: "Team rules",
  orderIndex: "Order",
  email: "Email",
  name: "Name",
  password: "Password",
  role: "Role",
  reason: "Reason",
  notes: "Notes",
};

function labelFor(field: string): string {
  if (FIELD_LABEL[field]) return FIELD_LABEL[field];
  // camelCase → "camel case", then sentence-cased. Never guesses a synonym.
  const spaced = field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The most useful sentence available for a failed request.
 *
 * Prefers the specific over the general: field errors first, then whole-form
 * errors, then the route's own message, then the caller's fallback. A caller
 * that has nothing better to say still gets a sentence rather than "undefined".
 */
export function apiErrorMessage(body: unknown, fallback: string): string {
  const parsed = (body ?? {}) as ApiErrorBody;
  const headline =
    typeof parsed.error === "string" && parsed.error.trim().length > 0
      ? parsed.error
      : fallback;

  const details = parsed.details as ZodFlattened | undefined;
  if (!details || typeof details !== "object") return headline;

  const parts: string[] = [];

  for (const [field, messages] of Object.entries(details.fieldErrors ?? {})) {
    const first = messages?.[0];
    if (!first) continue;
    /*
     * The field is named even when the message already reads as a sentence.
     * Zod's default for a missing key is "Required", which on its own tells
     * the reader that something was required without saying what.
     */
    parts.push(`${labelFor(field)}: ${first.toLowerCase()}`);
  }

  for (const formError of details.formErrors ?? []) {
    if (formError) parts.push(formError);
  }

  if (parts.length === 0) return headline;

  /*
   * The headline is kept in front of the specifics rather than replaced by
   * them. "Validation failed" alone was useless, but dropping it entirely
   * would lose the distinction between a refusal the caller can fix and a
   * fault they cannot.
   */
  return `${headline} — ${parts.join("; ")}`;
}
