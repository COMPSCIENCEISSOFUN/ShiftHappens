/**
 * One sentence saying what an audit entry actually did.
 *
 */
import { ACTIONS, type AuditAction } from "@/lib/audit-actions";
import { reasonLabel } from "@/lib/decline-reasons";

/** The parsed `details` column. Every field is optional — see below. */
export type AuditDetails = Record<string, unknown> | null | undefined;

/**
 * Reads one field defensively.
 *
 * `details` is a `Json` column written by twenty-three services over several
 * months, and rows written before a field existed simply do not have it. A
 * summariser that assumed its own shape would throw on the oldest rows in the
 * table — the ones an audit log exists to keep.
 */
function str(d: AuditDetails, key: string): string | null {
  const value = d?.[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function num(d: AuditDetails, key: string): number | null {
  const value = d?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(d: AuditDetails, key: string): unknown[] | null {
  const value = d?.[key];
  return Array.isArray(value) ? value : null;
}

/** `"a" · "b"` — the parts that resolved, in order, joined once. */
function join(...parts: (string | null)[]): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" · ") : null;
}

function quoted(value: string | null): string | null {
  return value ? `"${value}"` : null;
}

/** `from → to`, and nothing at all when neither was recorded. */
function movement(d: AuditDetails, fromKey = "from", toKey = "to"): string | null {
  const from = str(d, fromKey);
  const to = str(d, toKey);
  if (from && to) return `${from} → ${to}`;
  if (to) return `→ ${to}`;
  return null;
}

/**
 * A name for the thing, whatever the writing service happened to call it.
 *
 * Four keys for one idea, because they were chosen independently: tasks write
 * `title`, assignments write `taskTitle`, departments and certificates write
 * `name`. Normalising here rather than renaming the columns leaves the stored
 * rows alone, which is the point of an audit log.
 */
function subject(d: AuditDetails): string | null {
  return str(d, "taskTitle") ?? str(d, "title") ?? str(d, "name");
}

/** The list of fields a partial update touched, as prose. */
function changedFields(d: AuditDetails): string | null {
  const explicit = list(d, "changes") ?? list(d, "changed");
  const keys = explicit
    ? explicit.filter((k): k is string => typeof k === "string")
    : Object.keys(d ?? {}).filter((k) => d?.[k] !== undefined);
  if (keys.length === 0) return null;
  return `changed ${keys.join(", ")}`;
}

type Summariser = (d: AuditDetails) => string | null;

/**
 * Every action, and what its row says.
 *
 * Ordered as `ACTIONS` is, so the two read side by side.
 */
const SUMMARY: Record<AuditAction, Summariser> = {
  // ── Tasks ────────────────────────────────────────────────────────
  [ACTIONS.TASK_CREATED]: (d) => quoted(subject(d)),
  [ACTIONS.TASK_UPDATED]: (d) => join(quoted(subject(d)), changedFields(d)),
  [ACTIONS.TASK_DELETED]: (d) => quoted(subject(d)),
  [ACTIONS.TASK_ASSIGNED]: (d) => {
    /*
     * Two writers, two shapes. `assignStaff` records the membership ids it was
     * given; the weekly scheduler records counts across a whole run. Both are
     * "staff assigned" and the row has to read sensibly either way.
     */
    const planned = num(d, "totalPlanned");
    const created = num(d, "assignmentsCreated");
    if (planned !== null || created !== null) {
      const filled = created ?? 0;
      const asked = planned ?? filled;
      return join(
        `${filled} of ${asked} placed`,
        str(d, "allocationProvider") ? `via ${str(d, "allocationProvider")}` : null
      );
    }
    const ids = list(d, "membershipIds");
    const count = ids?.length ?? 0;
    return join(
      quoted(subject(d)),
      count > 0 ? `${count} ${count === 1 ? "person" : "people"}` : null,
      str(d, "status")
    );
  },
  [ACTIONS.TASK_UNASSIGNED]: (d) => quoted(subject(d)),
  [ACTIONS.RECURRING_TASKS_GENERATED]: (d) =>
    join(
      `${num(d, "created") ?? 0} created`,
      num(d, "filled") !== null ? `${num(d, "filled")} staffed` : null,
      num(d, "unfilled") ? `${num(d, "unfilled")} unstaffed` : null,
      num(d, "skippedAtLimit") ? `${num(d, "skippedAtLimit")} skipped at the plan limit` : null
    ),

  // ── Projects ─────────────────────────────────────────────────────
  [ACTIONS.PROJECT_CREATED]: (d) => join(quoted(subject(d)), str(d, "staffingMode")),
  [ACTIONS.PROJECT_UPDATED]: (d) => join(quoted(subject(d)), str(d, "status")),
  [ACTIONS.PROJECT_DELETED]: (d) =>
    join(
      quoted(subject(d)),
      num(d, "workItemCount") !== null ? `${num(d, "workItemCount")} work items` : null
    ),

  // ── Assignments ──────────────────────────────────────────────────
  [ACTIONS.ASSIGNMENT_ACCEPTED]: (d) => quoted(subject(d)),
  [ACTIONS.ASSIGNMENT_REJECTED]: (d) =>
    join(quoted(subject(d)), reasonLabel(str(d, "reason")), str(d, "notes")),
  [ACTIONS.ASSIGNMENT_CLOCKED_IN]: (d) => quoted(subject(d)),
  [ACTIONS.ASSIGNMENT_CLOCKED_OUT]: (d) => quoted(subject(d)),
  [ACTIONS.ASSIGNMENT_COMPLETED]: (d) => quoted(subject(d)),
  [ACTIONS.ASSIGNMENT_DECLINE_REQUESTED]: (d) =>
    join(quoted(subject(d)), reasonLabel(str(d, "reason")), str(d, "notes")),
  [ACTIONS.ASSIGNMENT_DECLINE_APPROVED]: (d) =>
    join(quoted(subject(d)), reasonLabel(str(d, "reason"))),
  [ACTIONS.ASSIGNMENT_DECLINE_DENIED]: (d) =>
    join(quoted(subject(d)), reasonLabel(str(d, "reason"))),
  [ACTIONS.ASSIGNMENT_WITHDRAWAL_REQUESTED]: (d) =>
    join(quoted(subject(d)), str(d, "reason"), str(d, "notes")),
  [ACTIONS.ASSIGNMENT_WITHDRAWAL_APPROVED]: (d) =>
    join(quoted(subject(d)), str(d, "reason")),
  [ACTIONS.ASSIGNMENT_WITHDRAWAL_DENIED]: (d) => quoted(subject(d)),
  [ACTIONS.ASSIGNMENT_RATED]: (d) =>
    join(
      quoted(subject(d)),
      num(d, "rating") !== null ? `rated ${num(d, "rating")}/5` : null,
      str(d, "comment")
    ),
  [ACTIONS.ASSIGNMENT_CLOCK_CORRECTED]: (d) =>
    join(quoted(subject(d)), str(d, "member"), str(d, "reason")),
  [ACTIONS.ELIGIBILITY_OVERRIDDEN]: (d) =>
    join(quoted(str(d, "taskTitle")), str(d, "member"), str(d, "reason")),

  // ── Membership ───────────────────────────────────────────────────
  [ACTIONS.SENIORITY_OVERRIDDEN]: (d) => movement(d) ?? null,
  [ACTIONS.AVAILABILITY_REVIEW_REQUESTED]: () => null,
  [ACTIONS.AVAILABILITY_UPDATED]: (d) => {
    const days = list(d, "days");
    if (!days) return null;
    const open = days.filter(
      (day) => (day as { isAvailable?: boolean })?.isAvailable
    ).length;
    return `${open} of ${days.length} days available`;
  },
  [ACTIONS.CONTRACTED_DAYS_SET]: (d) => {
    const days = list(d, "days");
    return days ? `${days.length} contracted days` : null;
  },
  [ACTIONS.REPORT_EXPORTED]: (d) => {
    /*
     * `scope` is the field that matters — the same button produces one
     * department's figures for a manager and the whole company's for an admin,
     * and this row is the only record of which left the building.
     */
    const scope = d?.["scope"];
    const where = Array.isArray(scope)
      ? `${scope.length} department${scope.length === 1 ? "" : "s"}`
      : typeof scope === "string"
        ? scope
        : null;
    return join(where, str(d, "format"));
  },

  // ── Members and invitations ──────────────────────────────────────
  [ACTIONS.MEMBER_INVITED]: (d) => join(str(d, "email"), str(d, "role")),
  [ACTIONS.MEMBER_INVITE_REVOKED]: (d) => join(str(d, "email"), str(d, "role")),
  [ACTIONS.MEMBER_JOINED]: (d) => join(str(d, "email"), str(d, "role")),
  [ACTIONS.MEMBER_ROLE_CHANGED]: (d) =>
    join(
      movement(d, "previousRole", "newRole"),
      str(d, "employmentType")
    ),
  [ACTIONS.MEMBER_ACTIVATED]: (d) =>
    movement(d, "previousStatus", "newStatus"),
  [ACTIONS.MEMBER_DEACTIVATED]: (d) =>
    join(
      movement(d, "previousStatus", "newStatus"),
      /*
       * The consequence, not just the act. Deactivating releases future
       * shifts, and how many is the number somebody reading this back wants.
       */
      num(d, "releasedShifts")
        ? `${num(d, "releasedShifts")} shifts released`
        : null
    ),
  [ACTIONS.MEMBER_CUSTOM_ROLE_ASSIGNED]: (d) =>
    movement(d, "previousRoleLabel", "roleLabel") ?? str(d, "roleLabel"),
  [ACTIONS.MEMBER_CUSTOM_ROLE_CLEARED]: (d) => str(d, "previousRoleLabel"),

  // ── Departments ──────────────────────────────────────────────────
  [ACTIONS.DEPARTMENT_CREATED]: (d) => str(d, "name"),
  [ACTIONS.DEPARTMENT_UPDATED]: (d) => join(str(d, "name"), changedFields(d)),
  [ACTIONS.DEPARTMENT_ARCHIVED]: (d) => str(d, "name"),
  [ACTIONS.DEPARTMENT_UNARCHIVED]: (d) => str(d, "name"),
  [ACTIONS.DEPARTMENT_DELETED]: (d) => str(d, "name"),

  // ── Leave ────────────────────────────────────────────────────────
  [ACTIONS.LEAVE_APPROVED]: (d) => dayOf(d),
  [ACTIONS.LEAVE_REJECTED]: (d) => dayOf(d),
  [ACTIONS.LEAVE_DISMISSED]: (d) => dayOf(d),

  // ── Certifications ───────────────────────────────────────────────
  [ACTIONS.CERTIFICATION_SUBMITTED]: (d) =>
    join(str(d, "name"), str(d, "expiryDate") ? `expires ${dateOnly(str(d, "expiryDate"))}` : null),
  [ACTIONS.CERTIFICATION_VERIFIED]: (d) => join(str(d, "name"), str(d, "member")),
  [ACTIONS.CERTIFICATION_REJECTED]: (d) =>
    join(str(d, "name"), str(d, "member"), str(d, "reason")),
  [ACTIONS.CERTIFICATION_REVOKED]: (d) =>
    join(str(d, "name"), str(d, "member"), str(d, "reason")),
  [ACTIONS.CERTIFICATION_WITHDRAWN]: (d) => str(d, "name"),
  [ACTIONS.CERTIFICATION_TYPE_ADDED]: (d) => str(d, "name"),
  [ACTIONS.CERTIFICATION_TYPE_REMOVED]: (d) => str(d, "name"),

  // ── Work rules and roles ─────────────────────────────────────────
  [ACTIONS.WORK_RULE_CREATED]: (d) => join(str(d, "name"), str(d, "type")),
  [ACTIONS.WORK_RULE_UPDATED]: (d) => join(str(d, "name"), changedFields(d)),
  [ACTIONS.WORK_RULE_DELETED]: (d) => str(d, "name"),
  [ACTIONS.ROLE_CREATED]: (d) =>
    join(
      str(d, "displayLabel") ?? str(d, "name"),
      num(d, "permissionCount") !== null
        ? `${num(d, "permissionCount")} permissions`
        : null
    ),
  [ACTIONS.ROLE_UPDATED]: (d) => str(d, "displayLabel"),
  [ACTIONS.ROLE_DELETED]: (d) =>
    join(
      str(d, "displayLabel") ?? str(d, "name"),
      /*
       * Deleting a role strips its permissions from everyone holding it, so
       * the number of people affected belongs in the record of the deletion.
       */
      num(d, "holderCount") !== null ? `${num(d, "holderCount")} holders` : null
    ),

  // ── Organisation, settings, billing ──────────────────────────────
  [ACTIONS.SETTINGS_UPDATED]: (d) => changedFields(d),
  [ACTIONS.ORGANIZATION_UPDATED]: (d) => changedFields(d),
  [ACTIONS.ORGANIZATION_SUSPENDED]: (d) => join(movement(d), str(d, "by")),
  [ACTIONS.ORGANIZATION_REACTIVATED]: (d) => join(movement(d), str(d, "by")),
  [ACTIONS.ORGANIZATION_TIER_CHANGED]: (d) => join(movement(d), str(d, "by")),
  [ACTIONS.CHECKOUT_STARTED]: (d) =>
    join(str(d, "plan"), str(d, "interval"), str(d, "source")),
  [ACTIONS.SUBSCRIPTION_UPGRADED]: (d) => join(str(d, "tier"), str(d, "interval")),
  [ACTIONS.SUBSCRIPTION_UPDATED]: (d) =>
    movement(d) ?? join(str(d, "tier"), str(d, "status")) ??
    (d?.["resumed"] === true ? "resumed" : null),
  [ACTIONS.SUBSCRIPTION_CANCELED]: (d) =>
    join(
      str(d, "tier"),
      d?.["scheduled"] === true ? "at the end of the period" : null
    ),

  // ── Account and assistant ────────────────────────────────────────
  [ACTIONS.USER_PASSWORD_CHANGED]: (d) =>
    str(d, "via") === "reset_link" ? "via a reset link" : "from the profile page",
  [ACTIONS.USER_PROFILE_UPDATED]: (d) => changedFields(d),
  /*
   * The intent, never the sentence. What somebody typed into the assistant is
   * their own; what the product classified it as is the auditable part.
   */
  [ACTIONS.ASSISTANT_QUERIED]: (d) =>
    join(str(d, "intent")?.replace(/_/g, " ") ?? null, str(d, "classifiedBy")),
};

/** A stored ISO date, as a plain day. Never a time — these are calendar days. */
function dateOnly(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}

function dayOf(d: AuditDetails): string | null {
  return dateOnly(str(d, "date"));
}

/**
 * What this entry did, in one line, or null when there is nothing to add.
 *
 * Takes a plain `string` rather than `AuditAction`, because the action arrives
 * from the database and rows exist for actions the catalogue has since retired
 * — `member.role_changed` predates the custom-role split and its rows are
 * still here. An unrecognised action is not an error; it is an old row, and it
 * gets the same treatment as one with nothing to say.
 */
export function summariseAudit(action: string, details: AuditDetails): string | null {
  const summarise = (SUMMARY as Record<string, Summariser | undefined>)[action];
  if (!summarise) return null;
  try {
    const text = summarise(details);
    return text && text.trim().length > 0 ? text : null;
  } catch {
    /*
     * A malformed row must not take the page down. `details` is a Json column
     * with no schema behind it, and the one screen that reads it is the screen
     * somebody opens when something has already gone wrong.
     */
    return null;
  }
}
