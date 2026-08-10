/**
 * Audit Log Repository (Entity Layer)
 * 
 * Data access layer for AuditLog model.
 * Records and queries system activity for accountability.
 * All queries are org-scoped for multi-tenant isolation.
 * 
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { prisma } from "@/lib/prisma";

export class AuditLogRepository {
  /** Creates a new audit log entry */
  async create(data: {
    organizationId: string;
    userId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    details?: object;
    /*
     * Deliberately not accepted any more.
     *
     * The column exists and every row's is null: it was optional at the schema,
     * the repository and the service, so no caller ever had to pass one and
     * none ever did. A full stack with no writer.
     *
     * ## What this is NOT
     *
     * An earlier version of this note said the address "only exists on the
     * incoming request" and implied nothing in the codebase could reach it.
     * That was wrong, and wrong in the direction this file is about: it made
     * the case sound more settled than the code supports.
     *
     * `getClientIp` exists in `src/middleware.ts`, is carefully reasoned — it
     * takes the LAST `x-forwarded-for` entry, because the left-most is whatever
     * the caller sent — and has its own suite in `tests/lib/client-ip.test.ts`.
     * The resolver is here and it works.
     *
     * ## The actual reasons
     *
     * The middleware matches `/api/:path*` and does not pass what it learns to
     * anything: audit entries are written deep inside SERVICES, which receive no
     * request. So populating this still means either threading a parameter
     * through the call sites that log, or having the middleware set a header for
     * routes to read and forward — the second is cheaper than the first and
     * neither is free, and no one has asked to read the field.
     *
     * It is also personal data under the PDPA, so keeping it obliges a
     * retention policy this project does not have and a limitations entry it
     * would rather not need.
     *
     * That is a decision about cost and scope. It is not "impossible", and the
     * note should not have implied it was.
     *
     * ## Sequencing
     *
     * Removed from the signatures FIRST, deliberately: dropping a column needs
     * the deploy that stops referencing it to go out before the drop (§4). The
     * column itself goes in the next migration that touches this table.
     */
  }) {
    return prisma.auditLog.create({ data });
  }

  /** Queries audit logs with optional filters and pagination */
  async findByOrganizationId(
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
    return prisma.auditLog.findMany({
      where: {
        organizationId,
        ...(filters?.action && { action: filters.action }),
        ...(filters?.entityType && { entityType: filters.entityType }),
        ...(filters?.userId && { userId: filters.userId }),
        ...(filters?.startDate || filters?.endDate
          ? {
              createdAt: {
                ...(filters?.startDate && { gte: filters.startDate }),
                ...(filters?.endDate && { lte: filters.endDate }),
              },
            }
          : {}),
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      skip: offset,
    });
  }

  /** Returns total count for pagination */
  async countByOrganizationId(
    organizationId: string,
    filters?: {
      action?: string;
      entityType?: string;
      userId?: string;
      startDate?: Date;
      endDate?: Date;
    }
  ) {
    return prisma.auditLog.count({
      where: {
        organizationId,
        ...(filters?.action && { action: filters.action }),
        ...(filters?.entityType && { entityType: filters.entityType }),
        ...(filters?.userId && { userId: filters.userId }),
        ...(filters?.startDate || filters?.endDate
          ? {
              createdAt: {
                ...(filters?.startDate && { gte: filters.startDate }),
                ...(filters?.endDate && { lte: filters.endDate }),
              },
            }
          : {}),
      },
    });
  }
}