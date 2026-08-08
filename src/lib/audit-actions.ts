/**
 * Every event the application can record, as a closed set.
 *
 * ## Why this is in `lib` and not in the service
 *
 * The audit page is a client component and needs these to build its filter and
 * to label its rows. Importing them from `audit-log.service` would pull the
 * repository, and therefore Prisma, into the browser bundle — the same reason
 * `audit-entities.ts` and `shift-outcome.ts` live here.
 *
 * ## Nothing here is raised automatically
 *
 * Declaring an action does not record it. Each one is written by a service that
 * explicitly chose to, and the audit log is only as complete as those choices.
 * Two constants — `user.registered` and `user.logged_in` — sat here for months
 * with nothing raising them, and were deleted rather than implemented:
 * registration happens before any membership exists and a login has no
 * organisation at the moment NextAuth authorises it, so neither can be scoped
 * to the tenant that `AuditLog.organizationId` requires. An action nothing can
 * raise is the same defect as a setting nothing reads.
 */
export const ACTIONS = {
  // Tasks
  TASK_CREATED: "task.created",
  TASK_UPDATED: "task.updated",
  TASK_DELETED: "task.deleted",
  TASK_ASSIGNED: "task.assigned",
  TASK_UNASSIGNED: "task.unassigned",
  RECURRING_TASKS_GENERATED: "task.recurring_generated",
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
  CONTRACTED_DAYS_SET: "membership.contracted_days_set",
  // Members
  MEMBER_INVITED: "member.invited",
  MEMBER_JOINED: "member.joined",
  MEMBER_ROLE_CHANGED: "member.role_changed",
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
  // Certifications
  CERTIFICATION_SUBMITTED: "certification.submitted",
  CERTIFICATION_VERIFIED: "certification.verified",
  CERTIFICATION_REJECTED: "certification.rejected",
  CERTIFICATION_REVOKED: "certification.revoked",
  CERTIFICATION_WITHDRAWN: "certification.withdrawn",
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
