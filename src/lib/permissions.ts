/**
 * The permission catalogue, the default bundle for each system role, and the
 * rule for which permissions a subscription plan can veto.
 *
 * ## Why this file exists
 *
 * The catalogue used to live only in `prisma/seed.ts`. An audit of the whole
 * `src/` tree found that every permission name appeared in that one file and
 * was read back by nothing: the Roles screen let an admin compose permission
 * sets, stored them in `RolePermission`, rendered them as chips — and no code
 * path anywhere consulted them to allow or deny anything. Authorization was
 * entirely the `Membership.role` string. A custom role with every permission
 * ticked granted nothing; one with none took nothing away.
 *
 * So the catalogue now lives here, in code, and `prisma/seed.ts` imports it.
 * The database table is a join target for `RolePermission` and a source of
 * descriptions for the UI; it is no longer where the list is defined, and the
 * two cannot drift.
 *
 * ## The model
 *
 * - `company_admin` holds every permission, always. `assignCustomRole` already
 *   refuses to give an admin a custom role, so there is no path by which an
 *   admin's own access can be narrowed — which matters, because the person who
 *   edits roles must not be able to lock themselves out of the roles screen.
 * - Anyone else holds either their system role's default bundle, or — if they
 *   have been given a custom role — exactly that role's permissions INSTEAD.
 *   Replacing rather than intersecting is what makes the feature useful: a
 *   "Shift Lead" who can assign shifts but not delete them is a narrowing, and
 *   a senior staff member who may verify certificates is a widening, and both
 *   are things an org admin has a legitimate reason to express.
 *
 * The bundles below are defined so that a member WITHOUT a custom role has
 * exactly the access the role-string checks gave them before. That is what
 * makes this change safe to land: `tests/api/contract.test.ts` drives every
 * route in `routes.manifest.ts` and asserts the role contract, so if a bundle
 * is wrong the suite says so.
 *
 * ## What permissions cannot do
 *
 * They cannot buy a subscription plan. `PERMISSION_FEATURE` below maps the
 * permissions that describe a tier-gated feature onto that feature, and the
 * route guard checks the plan BEFORE the permission. Granting `audit:view` to a
 * custom role on a Pro organisation does not open the audit log — the plan
 * still says no. The two gates are independent and both can only deny.
 *
 * Department scope is likewise untouched by permissions: `departmentScopeFor`
 * keys off `role === "company_admin"`, so a custom role can change WHAT a
 * manager may do but never WHOSE data they may do it to.
 */
import type { GatedFeature } from "@/lib/subscription-tiers";

export interface PermissionDefinition {
  name: string;
  description: string;
  category: string;
}

/**
 * Every permission in the system — 28 of them.
 *
 * The block above the divider is what survived the audit, kept verbatim where
 * possible: organisations may already have `RolePermission` rows pointing at
 * these, and renaming one would silently empty a role somebody had composed.
 * The block below was added when the routes were moved onto permissions and no
 * existing name described what the route actually did.
 *
 * Sixteen names were retired in the same pass, and `prisma/seed.ts` deletes
 * rows the catalogue no longer defines — so the "renaming empties a role"
 * argument does not protect those. It could not: they granted nothing, so a
 * role losing them loses nothing. `tests/lib/permissions.test.ts` pins both
 * lists, the kept and the gone.
 */
export const PERMISSIONS: PermissionDefinition[] = [
  // Department management
  { name: "departments:create", description: "Create new departments", category: "departments" },
  { name: "departments:update", description: "Update department details", category: "departments" },
  { name: "departments:delete", description: "Delete departments", category: "departments" },

  // Member management
  { name: "members:invite", description: "Invite new members", category: "members" },
  { name: "members:update_role", description: "Update member roles", category: "members" },
  { name: "members:deactivate", description: "Activate or deactivate members", category: "members" },

  // Task management
  { name: "tasks:create", description: "Create new tasks", category: "tasks" },
  { name: "tasks:update", description: "Update task details", category: "tasks" },
  { name: "tasks:delete", description: "Delete tasks", category: "tasks" },
  { name: "tasks:assign", description: "Assign staff to tasks", category: "tasks" },
  /*
   * Its own permission rather than part of `tasks:assign`.
   *
   * Rostering somebody decides the future; amending a clock time rewrites the
   * record of what already happened, on the field the hours totals are built
   * from. They are different authorities and an organisation may reasonably
   * grant one without the other — a shift lead who books people should not
   * necessarily be able to change how long they were paid for.
   */
  { name: "assignments:correct_clock", description: "Correct a recorded clock in or out time", category: "tasks" },

  // Eligibility & allocation
  { name: "eligibility:view", description: "View eligibility status of staff", category: "eligibility" },
  { name: "eligibility:override", description: "Override eligibility blocks with reason", category: "eligibility" },
  { name: "allocation:use_suggestions", description: "Use AI-powered allocation suggestions", category: "allocation" },
  { name: "allocation:auto_allocate", description: "Trigger auto-allocation for tasks", category: "allocation" },

  // Reporting
  { name: "reports:view", description: "View reports and analytics", category: "reports" },
  { name: "reports:export", description: "Export reports as CSV or PDF", category: "reports" },

  // Calendar
  { name: "calendar:view_team", description: "View team coverage and other members' schedules", category: "calendar" },

  // Notifications

  // Settings
  { name: "settings:read", description: "View company settings", category: "settings" },
  { name: "settings:update", description: "Update company settings", category: "settings" },

  // Roles
  { name: "roles:manage", description: "Create, update and delete custom roles", category: "roles" },

  // Organization
  { name: "organization:update", description: "Update organization profile", category: "organization" },

  // Audit
  { name: "audit:view", description: "View audit logs", category: "audit" },

  // ── Added when the routes were moved onto permissions ─────────────────
  { name: "work_rules:manage", description: "View, create, update and delete work rules", category: "work_rules" },
  { name: "members:update_seniority", description: "Pin or release a member's seniority level", category: "members" },
  { name: "members:request_availability", description: "Ask a member to review their availability", category: "members" },
  { name: "certifications:review", description: "Verify, reject or revoke others' certifications", category: "certifications" },
  { name: "allocation:auto_schedule", description: "Build and confirm a whole-week draft schedule", category: "allocation" },
  { name: "billing:manage", description: "Change the subscription plan", category: "billing" },
  /*
   * Deliberately absent from MANAGER_EXTRA_PERMISSIONS.
   *
   * A full-time member's contracted days are a term of their employment, not a
   * rostering judgement — which is what separates this from
   * `members:update_seniority` next door, held by managers precisely because it
   * is a call about running a shift. Admins hold it because
   * `effectivePermissions` grants them the whole catalogue, so no special case
   * is needed to say "admin only".
   *
   * It is still a catalogue entry rather than a hardcoded role check so that an
   * admin who wants to delegate it can, through the custom-role machinery that
   * already exists. Default-admin and admin-only-forever are different claims,
   * and this is the first.
   */
  { name: "members:set_contracted_days", description: "Set a full-time member's contracted working days", category: "members" },
];

export const PERMISSION_NAMES = PERMISSIONS.map((p) => p.name);

/**
 * Permissions describing a feature the subscription plan gates.
 *
 * The guard consults this BEFORE the permission itself, so the plan wins. Only
 * permissions that map to a real `GatedFeature` belong here — everything absent
 * from this map is available on every plan and is decided by permission alone.
 */
export const PERMISSION_FEATURE: Record<string, GatedFeature> = {
  "audit:view": "audit_log",
};

/*
 * Two deliberate absences from the map above.
 *
 * `reports:export` — the export route serves CSV on every plan and PDF only
 * above Free, so the FORMAT is gated, not the route. Listing the permission
 * here would take CSV away from Free, which the pricing table promises.
 *
 * `roles:manage` — the custom_roles feature is already enforced inside
 * `RoleService.create`, which is the right place
 * because it also applies the per-tier COUNT limit. A second gate here would
 * change an unrelated endpoint: the permission catalogue is fetched in order to
 * compose a role, so a Free admin opening the Roles screen would meet an
 * upgrade error where they previously saw an empty picker — for no gain, since
 * they cannot create a role either way.
 */

/**
 * What a member of each system role may do when they hold no custom role.
 *
 * `staff` is the floor: everything any active member could do before this
 * change. `manager` adds the shift-running powers. `company_admin` is not
 * listed because it is not a bundle — an admin holds every permission, and
 * spelling out a list would create a second place for the catalogue to drift.
 */
/**
 * Deliberately empty.
 *
 * Twelve permissions used to live here and every one of them enforced nothing:
 *
 *   - Six were BASELINE READS — view tasks, view members, view departments.
 *     Being an active member of the organisation already grants those, and
 *     switching one off produced a login that displayed nothing. A checkbox
 *     whose only possible use is to lock a colleague out of the product is not
 *     a permission, it is a trap.
 *   - Six were SELF-SERVICE — accept a shift, clock in, upload your own
 *     certificate, set your own availability, manage your own notification
 *     preferences. Revoking one leaves a person still rostered and unable to
 *     answer, or unable to record the hours they worked. That is a broken
 *     member, not a restricted one. `notifications:receive` was the plainest
 *     case of all: the notification service sends regardless, so no code path
 *     could ever have consulted it.
 *
 * What remains is the useful consequence. Every permission in the catalogue is
 * now a manager or admin action, so giving a STAFF member a custom role is
 * purely additive — ticking two or three boxes is exactly how a "Shift Lead"
 * gets built. That was impossible to see while a third of the list did nothing.
 */
const STAFF_PERMISSIONS = [] as const;

const MANAGER_EXTRA_PERMISSIONS = [
  "tasks:create",
  "tasks:update",
  "tasks:delete",
  "tasks:assign",
  "eligibility:view",
  "eligibility:override",
  "calendar:view_team",
  "allocation:use_suggestions",
  "allocation:auto_allocate",
  "reports:view",
  "reports:export",
  "members:update_seniority",
  "members:request_availability",
  "certifications:review",
  // Managers, not staff. A member correcting their own clock time is the
  // absence of a control, not a correction.
  "assignments:correct_clock",
] as const;

export const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  staff: STAFF_PERMISSIONS,
  manager: [...STAFF_PERMISSIONS, ...MANAGER_EXTRA_PERMISSIONS],
};

/**
 * Who may read the org-wide reference lists.
 *
 * ## Why these exist at all
 *
 * `GET /tasks`, `GET /members` and `GET /departments` required only membership.
 * Six baseline reads were retired from the catalogue on the grounds that they
 * enforced nothing and everyone needed them, and these three routes were left
 * on that reasoning — but the SIDEBAR was meanwhile gated, so the menu and the
 * routes disagreed about whether these were baseline. The menu was right.
 *
 * A plain staff member has "My Tasks" for their own shifts and does not need
 * the org task board; nor the member directory, which carries every colleague's
 * name, email, role and employment type; nor the department list with its
 * org-wide counts. Anyone who typed the URL got all three, and the data really
 * loaded — the page gates hid buttons, not rows.
 *
 * ## Why a list per resource, and why here
 *
 * Each list names the permissions of the screens that actually consume that
 * endpoint, which is what makes it checkable: every entry can be traced to a
 * page that would break without it. The alternative — "any permission at all" —
 * is shorter and says nothing about why.
 *
 * They live beside the catalogue so the route and the page gate read the same
 * constant. Stating the set twice is how the sidebar and the route came to
 * disagree in the first place.
 */
export const TASK_LIST_READERS = [
  // The task board itself…
  "tasks:create",
  "tasks:update",
  "tasks:delete",
  "tasks:assign",
  // …and the calendar, which draws its grid from the same endpoint.
  "calendar:view_team",
] as const;

export const MEMBER_LIST_READERS = [
  "members:invite",
  "members:update_role",
  "members:deactivate",
  "members:update_seniority",
  "members:request_availability",
  // Contracted days are set from the member drawer, which the list opens.
  "members:set_contracted_days",
  // The assign panel renders candidate names; the review queue renders owners.
  "tasks:assign",
  "certifications:review",
] as const;

export const DEPARTMENT_LIST_READERS = [
  "departments:create",
  "departments:update",
  "departments:delete",
  // The task form picks a department; work rules target one; the members screen
  // assigns them; the importer resolves them by name.
  "tasks:create",
  "work_rules:manage",
  "members:invite",
  "members:update_role",
] as const;

/**
 * The permissions a member holds, given their system role and custom role.
 *
 * `customRolePermissions` is null when the member has no custom role — which is
 * NOT the same as an empty array. An empty array is a role an admin composed
 * with nothing in it, and it must mean "nothing", or a role could never be used
 * to take anything away.
 */
export function effectivePermissions(
  systemRole: string,
  customRolePermissions: readonly string[] | null
): Set<string> {
  if (systemRole === "company_admin") return new Set(PERMISSION_NAMES);
  if (customRolePermissions !== null) return new Set(customRolePermissions);
  return new Set(ROLE_PERMISSIONS[systemRole] ?? []);
}

/**
 * The shape `permissionsOf` reads.
 *
 * Structural rather than the Prisma type, so a test can hand it a literal
 * without building a whole membership row, and so this file stays free of
 * anything that would drag the database client into a browser bundle.
 */
export interface PermissionedMembership {
  role: string;
  customRole?: {
    rolePermissions: { permission: { name: string } }[];
  } | null;
}

/**
 * What a loaded membership is allowed to do.
 *
 * The unwrapping — role rows to permission names, absent role to `null` — used
 * to live on `AccessService`, which meant anything outside Control that needed
 * a member's permissions had to write it again. `taskWatcherUserIds` needs it
 * for every member of an organisation at once and never authorises a request,
 * so reaching it through the access service would have been a second copy of a
 * three-line rule where the whole point is that there is one.
 *
 * The null matters and is not a tidy-up: no custom role falls back to the
 * system bundle, while a custom role with nothing in it grants nothing.
 */
export function permissionsOf(membership: PermissionedMembership): Set<string> {
  const custom = membership.customRole
    ? membership.customRole.rolePermissions.map((rp) => rp.permission.name)
    : null;
  return effectivePermissions(membership.role, custom);
}

/** Does this set allow the action? */
export function hasPermission(
  permissions: ReadonlySet<string>,
  permission: string
): boolean {
  return permissions.has(permission);
}
