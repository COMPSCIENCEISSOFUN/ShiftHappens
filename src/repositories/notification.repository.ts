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
    filter: NotificationFilter = {},
    /**
     * The last row of the previous page, for keyset paging.
     *
     * ## Why a cursor and not just the offset
     *
     * The feed grows at the head. Ask for rows 20–39, have three notifications
     * arrive while you read, and every row shifts down three places — so "Load
     * older" re-appends rows already on screen and skips three that were never
     * shown. On a page whose whole job is "have I missed anything", silently
     * dropping rows is the wrong failure.
     *
     * Keyset asks "older than this exact row" instead of "twenty rows in", so
     * arrivals at the head cannot move the boundary. The comparison is on
     * `(createdAt, id)` — the same pair the ordering uses, which is what makes
     * it exact: `createdAt` is `timestamp(3)`, so ties are routine when one
     * action notifies several people at once, and a cursor on the timestamp
     * alone would skip the rest of a tied group.
     *
     * `offset` stays for the callers that page a STABLE list. Passing both is a
     * caller error; the cursor wins, because it is the one that is correct.
     */
    before?: { createdAt: Date; id: string }
  ) {
    const where = this.buildWhere(userId, organizationId, filter);

    return prisma.notification.findMany({
      where: before
        ? {
            AND: [
              where,
              {
                OR: [
                  { createdAt: { lt: before.createdAt } },
                  { createdAt: before.createdAt, id: { lt: before.id } },
                ],
              },
            ],
          }
        : where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      skip: before ? 0 : offset,
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
   * Counts notifications per type, and per type again for the unread ones, in
   * one round trip.
   *
   * The filter pills need a count each; issuing one query per pill would be
   * five queries that can disagree with one another under concurrent writes.
   *
   * The unread half exists because "Needs action" was summed from the ALL
   * counts, so a rejection read months ago still counted toward a tile telling
   * you something wanted your attention — the number never went down as you
   * dealt with things, which is the one behaviour that tile has to have.
   * Grouping by `isRead` as well answers both questions without a second query,
   * and the two cannot disagree because they come from the same rows.
   */
  async countByType(
    userId: string,
    organizationId: string
  ): Promise<{ all: Record<string, number>; unread: Record<string, number> }> {
    const rows = await prisma.notification.groupBy({
      by: ["type", "isRead"],
      where: { userId, organizationId },
      _count: { _all: true },
    });

    const all: Record<string, number> = {};
    const unread: Record<string, number> = {};
    for (const row of rows) {
      all[row.type] = (all[row.type] ?? 0) + row._count._all;
      if (!row.isRead) {
        unread[row.type] = (unread[row.type] ?? 0) + row._count._all;
      }
    }
    return { all, unread };
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
