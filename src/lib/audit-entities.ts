/**
 * What an audit entry is ABOUT, as a closed set, plus readable names for it.
 *
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
