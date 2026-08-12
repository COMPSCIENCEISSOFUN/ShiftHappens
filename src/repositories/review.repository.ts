/**
 * Review data access (Entity layer).
 *
 * Two audiences, two shapes. The landing page needs a name, an organisation and
 * words; the moderation queue needs the same plus the status and when it last
 * changed. Neither needs an email, so neither selects one.
 */
import { prisma } from "@/lib/prisma";

export interface UpsertReviewData {
  membershipId: string;
  organizationId: string;
  rating: number;
  body: string;
}

export class ReviewRepository {
  private authorSelect = {
    id: true,
    role: true,
    user: { select: { id: true, name: true } },
  };

  /**
   * One review per member, so this is an upsert rather than a create.
   *
   * The status is reset on every write, including an edit of an approved one —
   * the unique key means there is no second row to moderate, so the words on
   * the public page and the words that were approved are the same words only if
   * editing withdraws it.
   */
  async upsert(data: UpsertReviewData) {
    const { membershipId, organizationId, rating, body } = data;
    return prisma.review.upsert({
      where: { membershipId },
      update: { rating, body, status: "pending" },
      create: { membershipId, organizationId, rating, body },
    });
  }

  async findByMembership(membershipId: string) {
    return prisma.review.findUnique({ where: { membershipId } });
  }

  async findById(id: string) {
    return prisma.review.findUnique({
      where: { id },
      select: {
        id: true,
        rating: true,
        body: true,
        status: true,
        updatedAt: true,
        organization: { select: { id: true, name: true } },
        membership: { select: this.authorSelect },
      },
    });
  }

  /**
   * What the landing page shows.
   *
   * Most recently updated first, with `id` breaking the tie so the carousel
   * does not reorder itself between renders.
   */
  async findApproved(take: number) {
    return prisma.review.findMany({
      where: { status: "approved" },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true,
        rating: true,
        body: true,
        organization: { select: { name: true } },
        membership: { select: this.authorSelect },
      },
    });
  }

  /** The moderation queue, oldest first — waiting longest is answered first. */
  async findByStatus(status: string | undefined, take: number, skip: number) {
    return prisma.review.findMany({
      where: status ? { status } : {},
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take,
      skip,
      select: {
        id: true,
        rating: true,
        body: true,
        status: true,
        updatedAt: true,
        organization: { select: { id: true, name: true } },
        membership: { select: this.authorSelect },
      },
    });
  }

  async countByStatus(status: string | undefined): Promise<number> {
    return prisma.review.count({ where: status ? { status } : {} });
  }

  /** How many sit in each state, for the queue's tiles. */
  async countsByStatus(): Promise<{ status: string; count: number }[]> {
    const rows = await prisma.review.groupBy({
      by: ["status"],
      _count: { _all: true },
      orderBy: { status: "asc" },
    });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  }

  async setStatus(id: string, status: string) {
    return prisma.review.update({
      where: { id },
      data: { status },
      select: { id: true, status: true },
    });
  }
}
