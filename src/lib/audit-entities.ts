/**
 * What an audit entry is ABOUT, as a closed set, plus readable names for it.
 *
 * ## Why this is in `lib` and not in the service
 *
 * The audit page is a client component and needs both of these to build its
 * filter. Importing them from `audit-log.service` would pull
 * `AuditLogRepository` and therefore Prisma into the browser bundle — the same
 * reason `shift-outcome.ts` lives here rather than beside the service that
 * classifies with it, and the reason the tasks page restates `StaffEligibility`
 * instead of importing it.
 *
 * ## Why a union rather than a string
 *
 * `entityType` was a bare `string`. Fourteen different values had been written
 * by hand while the page's filter offered six, so seven categories —
 * certifications, work rules, subscriptions, accounts and more — had entries
 * nobody could narrow to. The dropdown was a second hand-maintained list and it
 * fell behind the first, silently, because nothing connected them.
 *
 * A union fixes the direction of the dependency: the filter is derived from
 * this, so an entity type cannot exist without being filterable, and a typo
 * cannot reach the database. It caught one immediately — `"auto-schedule"`,
 * hyphenated where everything else is snake_case, and naming the FEATURE rather
 * than the thing acted on. Those rows are assignments.
 *
 * ## `membership` is deliberately absent
 *
 * It and `member` were both in use for what a reader considers one thing:
 * invitations and role changes wrote `member`, seniority overrides and
 * contracted-days wrote `membership`. Selecting "Members" silently hid half of
 * them. Consolidated onto `member`, with a migration bringing existing rows
 * across — leaving them would have made old entries unreachable by exactly the
 * filter this change exists to fix.
 */

export const AUDIT_ENTITY_TYPES = [
  "task",
  "project",
  "assignment",
  "department",
  "member",
  "invitation",
  "availability",
  "certification",
  "work_rule",
  "role",
  "settings",
  "organization",
  "subscription",
  "user",
  // Not a stored record — the only entity here that names an artefact the
  // product hands out rather than a row it keeps.
  "report",
  // Nor this one. The second, and the pair is the reason the comment above is
  // no longer accurate on its own: both name something the product HANDED OUT
  // rather than something it stores.
  "assistant",
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * One readable name per entity type.
 *
 * A `Record` over the union rather than a loose map, so adding a type without
 * naming it fails the build instead of producing a blank option.
 */
export const AUDIT_ENTITY_LABELS: Record<AuditEntityType, string> = {
  task: "Tasks",
  project: "Projects",
  assignment: "Assignments",
  department: "Departments",
  member: "Members",
  invitation: "Invitations",
  availability: "Availability",
  certification: "Certifications",
  work_rule: "Work rules",
  role: "Roles",
  settings: "Settings",
  organization: "Organisation",
  subscription: "Billing",
  user: "Accounts",
  report: "Reports",
  assistant: "Assistant",
};
