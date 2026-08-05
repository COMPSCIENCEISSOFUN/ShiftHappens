/**
 * Audit Log Service (Control Layer)
 * 
 * Provides a simple interface for recording audit events
 * throughout the application. Fire-and-forget — audit logging
 * should never block or fail the primary operation.
 * 
 * Usage: await auditService.log({ ... })
 * The log method catches its own errors to prevent
 * audit failures from breaking business operations.
 */
import { AuditLogRepository } from "@/repositories/audit-log.repository";

const ACTIONS = {
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
  ELIGIBILITY_OVERRIDDEN: "assignment.eligibility_overridden",
  SENIORITY_OVERRIDDEN: "membership.seniority_overridden",
  AVAILABILITY_REVIEW_REQUESTED: "membership.availability_review_requested",
  // Members
  MEMBER_INVITED: "member.invited",
  MEMBER_ROLE_CHANGED: "member.role_changed",
  MEMBER_ACTIVATED: "member.activated",
  MEMBER_DEACTIVATED: "member.deactivated",
  // Departments
  DEPARTMENT_CREATED: "department.created",
  DEPARTMENT_UPDATED: "department.updated",
  DEPARTMENT_ARCHIVED: "department.archived",
  DEPARTMENT_UNARCHIVED: "department.unarchived",
  DEPARTMENT_DELETED: "department.deleted",
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
  // Auth
  USER_REGISTERED: "user.registered",
  USER_LOGGED_IN: "user.logged_in",
  // Organization
  ORGANIZATION_UPDATED: "organization.updated",
  // Billing / subscription
  CHECKOUT_STARTED: "subscription.checkout_started",
  SUBSCRIPTION_UPGRADED: "subscription.upgraded",
  SUBSCRIPTION_UPDATED: "subscription.updated",
  SUBSCRIPTION_CANCELED: "subscription.canceled",
} as const;

export type AuditAction = (typeof ACTIONS)[keyof typeof ACTIONS];

export { ACTIONS };

export class AuditLogService {
  private auditRepo = new AuditLogRepository();

  /**
   * Records an audit event. Fire-and-forget — errors are
   * logged to console but never thrown to the caller.
   */
  async log(params: {
    organizationId: string;
    userId?: string;
    action: AuditAction;
    entityType: string;
    entityId?: string;
    details?: Record<string, unknown>;
    ipAddress?: string;
  }) {
    try {
      await this.auditRepo.create(params);
    } catch (error) {
      console.error("[AuditLog Error]", error);
    }
  }

  /** Retrieves audit logs with filters */
  async getLogs(
    organizationId: string,
    filters?: {
      action?: string;
      entityType?: string;
      userId?: string;
      startDate?: Date;
      endDate?: Date;
    },
    limit = 50,
    offset = 0
  ) {
    const [logs, total] = await Promise.all([
      this.auditRepo.findByOrganizationId(organizationId, filters, limit, offset),
      this.auditRepo.countByOrganizationId(organizationId, filters),
    ]);

    return { logs, total, limit, offset };
  }
}