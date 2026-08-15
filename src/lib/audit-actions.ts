/**
 * Every event the application can record, as a closed set.
 *
 */
export const ACTIONS = {
  // Tasks
  TASK_CREATED: "task.created",
  TASK_UPDATED: "task.updated",
  TASK_DELETED: "task.deleted",
  TASK_ASSIGNED: "task.assigned",
  TASK_UNASSIGNED: "task.unassigned",
  RECURRING_TASKS_GENERATED: "task.recurring_generated",
  // Projects
  PROJECT_CREATED: "project.created",
  PROJECT_UPDATED: "project.updated",
  /*
   * The project row is gone, so this entry is the only remaining evidence it
   * existed. Its details carry the name and the work-item count for that
   * reason — "project.deleted" with an id nothing resolves any more answers
   * nothing about what was lost.
   */
  PROJECT_DELETED: "project.deleted",
  // Assignments
  ASSIGNMENT_ACCEPTED: "assignment.accepted",
  ASSIGNMENT_REJECTED: "assignment.rejected",
  ASSIGNMENT_CLOCKED_IN: "assignment.clocked_in",
  ASSIGNMENT_CLOCKED_OUT: "assignment.clocked_out",
  ASSIGNMENT_COMPLETED: "assignment.completed",
  ASSIGNMENT_DECLINE_REQUESTED: "assignment.decline_requested",
  ASSIGNMENT_DECLINE_APPROVED: "assignment.decline_approved",
  ASSIGNMENT_DECLINE_DENIED: "assignment.decline_denied",
  ASSIGNMENT_WITHDRAWAL_REQUESTED: "assignment.withdrawal_requested",
  ASSIGNMENT_WITHDRAWAL_APPROVED: "assignment.withdrawal_approved",
  ASSIGNMENT_WITHDRAWAL_DENIED: "assignment.withdrawal_denied",
  ASSIGNMENT_RATED: "assignment.rated",
  ASSIGNMENT_CLOCK_CORRECTED: "assignment.clock_corrected",
  ELIGIBILITY_OVERRIDDEN: "assignment.eligibility_overridden",
  SENIORITY_OVERRIDDEN: "membership.seniority_overridden",
  AVAILABILITY_REVIEW_REQUESTED: "membership.availability_review_requested",
  /*
   * A member changing their OWN weekly pattern.
   *
   * The two events around this were already recorded — a manager waiving
   * availability (`assignment.eligibility_overridden`) and a manager asking for
   * a refresh — and the edit itself was not. So "why was this person eligible
   * on Tuesday" was answerable only where somebody had intervened, and a
   * pattern quietly changed to avoid a shift left no trace at all.
   *
   * The employer-set path is NOT this: `setContractedDaysForUser` raises
   * `CONTRACTED_DAYS_SET` and always has. Two acts, two actions — the same
   * split made for custom roles, and for the same reason.
   */
  AVAILABILITY_UPDATED: "availability.updated",
  CONTRACTED_DAYS_SET: "membership.contracted_days_set",
  /*
   * The report leaving the building.
   *
   * Every other action here records a change to the system. This one records
   * an EXTRACTION, and it is the only one: `GET /reports/export` produces a
   * PDF carrying every staff member's name, worked hours and rejection history,
   * and once downloaded it is outside the product entirely — no permission
   * change, no plan change and no deactivation can reach it again.
   *
   * `scope` in the details is the field that matters. The same button produces
   * one department's figures for a manager and the whole company's for an
   * admin, and after the fact those two files are indistinguishable unless the
   * log says which was taken.
   */
  REPORT_EXPORTED: "report.exported",
  /*
   * A question asked of the assistant, recorded as an EXTRACTION — the same
   * reasoning as `report.exported`, and the same shape: nothing changed, but
   * data left the system in a form somebody now holds.
   *
   * The details record the INTENT, never the sentence. People type anything
   * into a chat box, this log is readable by every company admin, and an
   * assistant that quietly transcribes what staff type into an admin-visible
   * record is a privacy problem built on purpose. "member_hours, Kitchen"
   * answers every question an audit needs to ask; the raw text answers a
   * question nobody should be asking.
   */
  ASSISTANT_QUERIED: "assistant.queried",
  // Members
  MEMBER_INVITED: "member.invited",
  MEMBER_JOINED: "member.joined",
  /*
   * A pending invitation withdrawn before anybody accepted it.
   *
   * Separate from `MEMBER_INVITED` rather than folded into it: the row is
   * deleted, so without its own entry the only trace an invitation ever existed
   * would be the "invited" line, and the log would read as though somebody were
   * still expected to arrive. Most often the address was simply wrong, and
   * "we invited jhon@ and then took it back" is the honest version of that.
   */
  MEMBER_INVITE_REVOKED: "member.invite_revoked",
  /*
   * The member's SYSTEM role — staff, manager, company_admin.
   *
   * Custom roles are the two entries below and used to share this one. They are
   * different acts on different fields with different details: this one carries
   * `previousRole`/`newRole`, the custom-role one carried a bare id. One action
   * name meant the filter could not separate them and no reader could tell
   * which had happened without inspecting the shape of the details.
   *
   * The name is unchanged so historical rows keep their meaning — every entry
   * written before the split really was one of these OR a custom-role change,
   * and re-labelling them would rewrite the record rather than clarify it. The
   * page keeps a label for it for exactly that reason.
   */
  MEMBER_ROLE_CHANGED: "member.role_changed",
  MEMBER_CUSTOM_ROLE_ASSIGNED: "member.custom_role_assigned",
  MEMBER_CUSTOM_ROLE_CLEARED: "member.custom_role_cleared",
  MEMBER_ACTIVATED: "member.activated",
  MEMBER_DEACTIVATED: "member.deactivated",
  // Departments
  DEPARTMENT_CREATED: "department.created",
  DEPARTMENT_UPDATED: "department.updated",
  DEPARTMENT_ARCHIVED: "department.archived",
  DEPARTMENT_UNARCHIVED: "department.unarchived",
  DEPARTMENT_DELETED: "department.deleted",
  LEAVE_APPROVED: "leave.approved",
  LEAVE_REJECTED: "leave.rejected",
  /* Cleared from the queue after its date passed — nobody decided anything. */
  LEAVE_DISMISSED: "leave.dismissed",
  // Certifications
  CERTIFICATION_SUBMITTED: "certification.submitted",
  CERTIFICATION_VERIFIED: "certification.verified",
  CERTIFICATION_REJECTED: "certification.rejected",
  CERTIFICATION_REVOKED: "certification.revoked",
  CERTIFICATION_WITHDRAWN: "certification.withdrawn",
  // The organisation's list of recognised certificates — the vocabulary, not
  // anybody's individual certificate. Audited because it decides what every
  // future shift is able to require.
  CERTIFICATION_TYPE_ADDED: "certification_type.added",
  CERTIFICATION_TYPE_REMOVED: "certification_type.removed",
  // Settings
  SETTINGS_UPDATED: "settings.updated",
  // Roles
  ROLE_CREATED: "role.created",
  ROLE_UPDATED: "role.updated",
  ROLE_DELETED: "role.deleted",
  // Work Rules
  WORK_RULE_CREATED: "work_rule.created",
  WORK_RULE_UPDATED: "work_rule.updated",
  WORK_RULE_DELETED: "work_rule.deleted",
  /*
   * Account events, which happen OUTSIDE any organisation.
   *
   * `AuditLog.organizationId` is required, so these are written once per
   * organisation the user is an active member of — see `logForUser`. That is
   * the right audience rather than a workaround: an admin whose rota depends on
   * somebody has a legitimate interest in that person's password changing, and
   * no interest at all once they have left.
   *
   * `user.registered` and `user.logged_in` used to be declared here and were
   * never written by anything. Both were deleted rather than implemented:
   * registration happens before any membership exists, so there is no
   * organisation to attribute it to, and a login has none either at the moment
   * NextAuth authorises it. Declaring an action nothing can raise is the same
   * defect as a setting nothing reads.
   */
  USER_PASSWORD_CHANGED: "user.password_changed",
  USER_PROFILE_UPDATED: "user.profile_updated",
  // Organization
  ORGANIZATION_UPDATED: "organization.updated",
  // Raised by the PLATFORM admin, and recorded against the affected tenant —
  // the organisation being suspended is the one whose people need to see why.
  ORGANIZATION_SUSPENDED: "organization.suspended",
  ORGANIZATION_REACTIVATED: "organization.reactivated",
  ORGANIZATION_TIER_CHANGED: "organization.tier_changed",
  // Billing / subscription
  CHECKOUT_STARTED: "subscription.checkout_started",
  SUBSCRIPTION_UPGRADED: "subscription.upgraded",
  SUBSCRIPTION_UPDATED: "subscription.updated",
  SUBSCRIPTION_CANCELED: "subscription.canceled",
} as const;

export type AuditAction = (typeof ACTIONS)[keyof typeof ACTIONS];
