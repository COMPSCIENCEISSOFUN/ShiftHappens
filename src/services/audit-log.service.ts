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
import { DATE_RANGE_MESSAGE, parseDateRange } from "@/lib/date-range";
import { endOfDayInTimeZone, startOfDayInTimeZone } from "@/lib/timezone";

/*
 * Re-exported so the ~50 service call sites keep one import for the audit
 * vocabulary. The definitions live in `lib` because the audit PAGE needs them
 * and is a client component.
 */
export { ACTIONS, type AuditAction } from "@/lib/audit-actions";

/**
 * Midday on a calendar day, as the seed for a timezone conversion.
 *
 * Midday and not midnight: constructing at midnight UTC and converting to a
 * zone with a positive offset lands on the PREVIOUS day, which is the same trap
 * `getRosterForDay` documents. From noon, every offset on earth stays inside
 * the day that was asked for.
 */
function noonOn(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}




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

  /**
   * Retrieves audit logs with filters.
   *
   * ## The date range arrives as calendar DAYS, not instants
   *
   * It used to arrive as two `Date`s the browser had built, and both were
   * wrong in opposite directions. `startDate` was the bare "2026-08-09" the
   * picker produced, which `new Date()` reads as midnight UTC — 08:00 in
   * Singapore, so the first eight hours of the chosen day were missing.
   * `endDate` was built in the READER's timezone and shifted a day forward, so
   * it was right for a Singapore browser and eight hours too generous for one
   * on UTC. A range of a single day was therefore neither that day nor a
   * consistent window, and which rows you saw depended on where you were
   * sitting.
   *
   * Both halves are now decided here, from the organisation's calendar,
   * through the same `startOfDayInTimeZone` / `endOfDayInTimeZone` pair the
   * roster uses. The endpoint passes the strings through; the browser does no
   * date arithmetic at all, which is the only arrangement where every reader
   * sees the same log.
   */
  async getLogs(
    organizationId: string,
    filters?: {
      action?: string;
      entityType?: string;
      userId?: string;
      /** Inclusive `YYYY-MM-DD`, on the organisation's calendar. */
      from?: string | null;
      /** Inclusive `YYYY-MM-DD`, on the organisation's calendar. */
      to?: string | null;
    },
    limit = 50,
    offset = 0
  ) {
    const range = parseDateRange(filters?.from, filters?.to);
    if (range.problem) throw new Error(DATE_RANGE_MESSAGE[range.problem]);

    const bounds = {
      ...filters,
      startDate: range.from ? startOfDayInTimeZone(noonOn(range.from)) : undefined,
      // The END of the chosen day, inclusive. Half-open reads as an off-by-one
      // to everyone not holding the code, and picking one day for both bounds
      // must return that day rather than nothing.
      endDate: range.to ? endOfDayInTimeZone(noonOn(range.to)) : undefined,
    };
    return this.queryLogs(organizationId, bounds, limit, offset);
  }

  private async queryLogs(
    organizationId: string,
    filters: {
      action?: string;
      entityType?: string;
      userId?: string;
      startDate?: Date;
      endDate?: Date;
    },
    limit: number,
    offset: number
  ) {
    const [logs, total] = await Promise.all([
      this.auditRepo.findByOrganizationId(organizationId, filters, limit, offset),
      this.auditRepo.countByOrganizationId(organizationId, filters),
    ]);

    return { logs, total, limit, offset };
  }
}