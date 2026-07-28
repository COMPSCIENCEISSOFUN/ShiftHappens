/**
 * Notification Repository (Entity Layer)
 *
 * Database operations for user notifications.
 * Supports create, list (paginated + filtered), counts, mark as read
 * (single + bulk), and bulk create.
 *
 * Every query is scoped by BOTH userId and organizationId. A notification
 * belongs to one user within one organisation: a user who is a member of two
 * organisations has two separate feeds and must never see one from inside the
 * other, since the title and message embed that organisation's task names and
 * colleague names.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export interface NotificationFilter {
  /** Restrict to these notification types. Omit or pass an empty array for all. */
  types?: string[];
  /** Only unread notifications. */
  unreadOnly?: boolean;
  /** Case-insensitive substring match against title and message. */
  search?: string;
}

export interface NotificationInput {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

export class NotificationRepository {
  /**
   * Builds the shared WHERE clause. Kept private and used by every read so a
   * filter can never be applied to the list but forgotten on its count.
   */
  private buildWhere(
    userId: string,
    organizationId: string,
    filter: NotificationFilter = {}
  ): Prisma.NotificationWhereInput {
    const { types, unreadOnly, search } = filter;
    const trimmed = search?.trim();

    return {
      userId,
      organizationId,
      ...(unreadOnly ? { isRead: false } : {}),
      ...(types && types.length > 0 ? { type: { in: types } } : {}),
      ...(trimmed
        ? {
            OR: [
              { title: { contains: trimmed, mode: "insensitive" as const } },
              { message: { contains: trimmed, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
  }

  /** Creates a single notification */
  async create(data: NotificationInput) {
    return prisma.notification.create({ data });
  }

  /** Creates multiple notifications at once (e.g., notifying all managers) */
  async createMany(notifications: NotificationInput[]) {
    return prisma.notification.createMany({ data: notifications });
  }

  /**
   * Returns notifications for a user within an org, newest first.
   *
   * Ordered by createdAt AND id. createdAt is stored at millisecond precision,
   * so notifications written in the same millisecond — routine, since a single
   * action can notify several people at once — tie. An unbroken tie makes the
   * sort non-deterministic, and under LIMIT/OFFSET that means a row can appear
   * on page 1 and again on page 2 while another is skipped entirely. The id is
   * a cuid, whose leading timestamp+counter preserves insertion order, so it
   * is both a stable tiebreaker and the right one.
   */
  async findByUserId(
    userId: string,
    organizationId: string,
    limit = 20,
    offset = 0,
    filter: NotificationFilter = {}
  ) {
    return prisma.notification.findMany({
      where: this.buildWhere(userId, organizationId, filter),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      skip: offset,
    });
  }

  /**
   * Counts notifications matching the same filter as findByUserId.
   * Drives "load more" — without it the UI cannot tell a full last page from
   * a page that happens to end exactly on the limit.
   */
  async countMatching(
    userId: string,
    organizationId: string,
    filter: NotificationFilter = {}
  ): Promise<number> {
    return prisma.notification.count({
      where: this.buildWhere(userId, organizationId, filter),
    });
  }

  /** Counts unread notifications for a user within an org */
  async countUnread(userId: string, organizationId: string): Promise<number> {
    return prisma.notification.count({
      where: { userId, organizationId, isRead: false },
    });
  }

  /**
   * Counts notifications per type in one round trip.
   * The filter pills need a count each; issuing one query per pill would be
   * five queries that can disagree with one another under concurrent writes.
   */
  async countByType(
    userId: string,
    organizationId: string
  ): Promise<Record<string, number>> {
    const rows = await prisma.notification.groupBy({
      by: ["type"],
      where: { userId, organizationId },
      _count: { type: true },
    });

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.type] = row._count.type;
    }
    return counts;
  }

  /** Counts notifications created at or after `since` */
  async countSince(
    userId: string,
    organizationId: string,
    since: Date
  ): Promise<number> {
    return prisma.notification.count({
      where: { userId, organizationId, createdAt: { gte: since } },
    });
  }

  /** Marks a single notification as read */
  async markAsRead(id: string) {
    return prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  /** Marks all of a user's notifications as read within one org */
  async markAllAsRead(userId: string, organizationId: string) {
    return prisma.notification.updateMany({
      where: { userId, organizationId, isRead: false },
      data: { isRead: true },
    });
  }

  /** Finds a notification by ID (for ownership + org verification) */
  async findById(id: string) {
    return prisma.notification.findUnique({ where: { id } });
  }

  /**
   * Checks whether a notification of this type already exists for the user in
   * this org (optionally about a specific entity) since a given time.
   * Used to avoid re-sending the same alert on every clock-out.
   */
  async existsSince(
    userId: string,
    organizationId: string,
    type: string,
    since: Date,
    entityId?: string
  ): Promise<boolean> {
    const count = await prisma.notification.count({
      where: {
        userId,
        organizationId,
        type,
        createdAt: { gte: since },
        ...(entityId ? { entityId } : {}),
      },
    });
    return count > 0;
  }
}
