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
    ipAddress?: string;
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
      search?: string;
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
        ...(filters?.search ? { OR: [
          { action: { contains: filters.search, mode: "insensitive" } },
          { entityType: { contains: filters.search, mode: "insensitive" } },
          { user: { is: { OR: [{ name: { contains: filters.search, mode: "insensitive" } }, { email: { contains: filters.search, mode: "insensitive" } }] } } },
        ] } : {}),
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
      orderBy: { createdAt: "desc" },
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
      search?: string;
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
        ...(filters?.search ? { OR: [
          { action: { contains: filters.search, mode: "insensitive" } },
          { entityType: { contains: filters.search, mode: "insensitive" } },
          { user: { is: { OR: [{ name: { contains: filters.search, mode: "insensitive" } }, { email: { contains: filters.search, mode: "insensitive" } }] } } },
        ] } : {}),
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
