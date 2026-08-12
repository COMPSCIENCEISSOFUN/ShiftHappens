/**
 * Product feedback data access (Entity layer).
 *
 * The only repository here whose reads are deliberately not org-scoped. Every
 * other one takes an organizationId because the question is always "what
 * belongs to this tenant"; the platform admin's question is "what are our
 * customers saying", which has no tenant in it. Writes still carry the sender's
 * organisation, as provenance.
 */
import { prisma } from "@/lib/prisma";

export interface CreateFeedbackData {
  organizationId: string;
  membershipId: string;
  area: string;
  message: string;
}

export interface FeedbackQueueFilters {
  /** One area, or undefined for every area. */
  area?: string;
  /** Archived rows are hidden unless asked for. */
  includeArchived?: boolean;
}

export class FeedbackRepository {
  /**
   * What the queue shows for each message.
   *
   * The sender's name and organisation, because "who said this" is most of
   * what makes a comment actionable, and neither is worth a second query.
   */
  private queueSelect = {
    id: true,
    area: true,
    message: true,
    createdAt: true,
    archivedAt: true,
    organization: { select: { id: true, name: true } },
    membership: {
      select: {
        id: true,
        role: true,
        user: { select: { id: true, name: true, email: true } },
      },
    },
  };

  async create(data: CreateFeedbackData) {
    return prisma.feedback.create({ data });
  }

  private whereFor(filters: FeedbackQueueFilters) {
    return {
      ...(filters.area ? { area: filters.area } : {}),
      ...(filters.includeArchived ? {} : { archivedAt: null }),
    };
  }

  /**
   * One page of the queue, newest first.
   *
   * `id` breaks the tie. Two messages sent in the same millisecond are not
   * hypothetical on a seeded database, and without a second key the same row
   * can appear on two pages while another appears on none.
   */
  async findQueue(filters: FeedbackQueueFilters, take: number, skip: number) {
    return prisma.feedback.findMany({
      where: this.whereFor(filters),
      select: this.queueSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      skip,
    });
  }

  /**
   * How many match, which is not how many this page holds.
   *
   * A second query rather than the length of the page above: a footer reading
   * "50 messages" when there are 300 is worse than no footer.
   */
  async countQueue(filters: FeedbackQueueFilters): Promise<number> {
    return prisma.feedback.count({ where: this.whereFor(filters) });
  }

  /** How many live messages sit in each area, since a date. */
  async countByArea(since: Date): Promise<{ area: string; count: number }[]> {
    const rows = await prisma.feedback.groupBy({
      by: ["area"],
      where: { createdAt: { gte: since }, archivedAt: null },
      _count: { _all: true },
      orderBy: { area: "asc" },
    });
    return rows.map((row) => ({ area: row.area, count: row._count._all }));
  }

  async findById(id: string) {
    return prisma.feedback.findUnique({ where: { id }, select: this.queueSelect });
  }

  /** Archive or restore. `null` puts it back in the live queue. */
  async setArchived(id: string, archivedAt: Date | null) {
    return prisma.feedback.update({
      where: { id },
      data: { archivedAt },
      select: this.queueSelect,
    });
  }
}
