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
import { MembershipRepository } from "@/repositories/membership.repository";
import type { AuditEntityType } from "@/lib/audit-entities";
import type { AuditAction } from "@/lib/audit-actions";

/*
 * Re-exported so the ~50 service call sites keep one import for the audit
 * vocabulary. The definitions live in `lib` because the audit PAGE needs them
 * and is a client component.
 */
export { ACTIONS, type AuditAction } from "@/lib/audit-actions";




/*
 * Re-exported so services keep one import for the audit vocabulary. The
 * definitions live in `lib` because the audit PAGE needs them too, and it is a
 * client component — importing them from here would pull the repository, and
 * therefore Prisma, into the browser bundle.
 */
export {
  AUDIT_ENTITY_TYPES,
  AUDIT_ENTITY_LABELS,
  type AuditEntityType,
} from "@/lib/audit-entities";

export class AuditLogService {
  private auditRepo = new AuditLogRepository();
  private membershipRepo = new MembershipRepository();

  /**
   * Records an audit event. Fire-and-forget — errors are
   * logged to console but never thrown to the caller.
   */
  async log(params: {
    organizationId: string;
    userId?: string;
    action: AuditAction;
    entityType: AuditEntityType;
    entityId?: string;
    details?: Record<string, unknown>;
  }) {
    try {
      await this.auditRepo.create(params);
    } catch (error) {
      console.error("[AuditLog Error]", error);
    }
  }

  /**
   * Records an account event against every organisation the user belongs to.
   *
   * Password changes and profile edits happen outside any organisation, and
   * `AuditLog.organizationId` is required — so the choice is between not
   * recording them, inventing a nullable column that the org-scoped read would
   * never surface, or writing one row per organisation with a legitimate
   * interest. The third is the only one that puts the event in front of
   * somebody who can act on it.
   *
   * A user in no organisation produces no rows, which is correct: there is
   * nobody to tell.
   *
   * Failures are swallowed per `log`, so one organisation's write failing
   * cannot lose the others.
   */
  async logForUser(params: {
    userId: string;
    action: AuditAction;
    entityType: AuditEntityType;
    details?: Record<string, unknown>;
  }) {
    const organizationIds = await this.membershipRepo.findActiveOrganizationIds(
      params.userId
    );

    await Promise.all(
      organizationIds.map((organizationId) =>
        this.log({
          organizationId,
          userId: params.userId,
          action: params.action,
          entityType: params.entityType,
          entityId: params.userId,
          details: params.details,
        })
      )
    );
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