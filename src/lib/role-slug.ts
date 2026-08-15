/**
 * Turning a role's display label into its stored `name`.
 *
 */

/** Roles whose stored name is fixed by the seed and must never be generated. */
const RESERVED = new Set(["staff", "manager", "company_admin"]);

/**
 * The stored `name` for a display label.
 *
 * Lowercase, spaces and punctuation collapsed to single underscores, trimmed.
 * "Shift Lead" → `shift_lead`; "Front-of-House Supervisor" →
 * `front_of_house_supervisor`.
 *
 * Returns an empty string when the label contains nothing usable — "!!!" or an
 * emoji — rather than inventing a name. The caller decides what to do with
 * that; silently substituting something would store a name unrelated to the
 * label, which is the class of surprise this whole change is removing.
 */
export function slugifyRoleName(displayLabel: string): string {
  return displayLabel
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    // Written as escapes: the literal characters are invisible in an editor and
    // survive a copy-paste badly.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * A stored name for `displayLabel` that no existing role in the organisation
 * is using.
 *
 * `taken` is every name already in the org, INCLUDING the system roles. A
 * custom role named `manager` would not break authorisation — nothing reads the
 * string — but it would sit beside the real Manager role in the audit log and
 * in `profile.service`'s payload, and telling those apart afterwards is
 * needless work for no benefit.
 *
 * Collisions get a numeric suffix rather than a random one, so the name stays
 * readable and re-running the same input twice against the same data gives the
 * same answer. This is a fallback, not the normal path: the label itself is
 * checked for uniqueness first and a duplicate is refused before reaching here.
 * It exists for the case those two disagree — "Shift Lead" and "shift lead" are
 * different labels that slug identically.
 */
export function uniqueRoleName(
  displayLabel: string,
  taken: Iterable<string>
): string {
  const base = slugifyRoleName(displayLabel);
  if (!base) return "";

  const used = new Set(taken);
  if (!used.has(base) && !RESERVED.has(base)) return base;

  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }

  // Unreachable in practice — an organisation with 999 roles named alike has a
  // bigger problem — but returning something colliding would surface as a
  // constraint violation the caller cannot explain.
  return "";
}
