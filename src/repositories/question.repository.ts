/**
 * Asked-question data access (Entity layer).
 *
 * Like `FeedbackRepository`, the reads here are deliberately not org-scoped:
 * the platform admin is looking across every asker, and most askers have no
 * organisation at all.
 */
import { prisma } from "@/lib/prisma";

export interface CreateQuestionData {
  body: string;
  email?: string | null;
  name?: string | null;
  membershipId?: string | null;
  organizationId?: string | null;
}

export class QuestionRepository {
  private listSelect = {
    id: true,
    body: true,
    email: true,
    name: true,
    createdAt: true,
    handledAt: true,
    organization: { select: { id: true, name: true } },
    membership: {
      select: {
        id: true,
        user: { select: { id: true, name: true, email: true } },
      },
    },
  };

  async create(data: CreateQuestionData) {
    return prisma.question.create({ data });
  }

  /**
   * Oldest first, unlike the feedback queue.
   *
   * A question is work to be done rather than news to be read: the one that has
   * been waiting longest is the one most likely to have been asked again since.
   * `id` breaks the tie so paging cannot repeat or skip a row.
   */
  async findList(includeHandled: boolean, take: number, skip: number) {
    return prisma.question.findMany({
      where: includeHandled ? {} : { handledAt: null },
      select: this.listSelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
      skip,
    });
  }

  async count(includeHandled: boolean): Promise<number> {
    return prisma.question.count({
      where: includeHandled ? {} : { handledAt: null },
    });
  }

  async findById(id: string) {
    return prisma.question.findUnique({ where: { id }, select: this.listSelect });
  }

  /** Mark as dealt with, or put it back on the list. */
  async setHandled(id: string, handledAt: Date | null) {
    return prisma.question.update({
      where: { id },
      data: { handledAt },
      select: this.listSelect,
    });
  }

  /** How many have been asked since a date, for the platform dashboard. */
  async countSince(since: Date): Promise<number> {
    return prisma.question.count({ where: { createdAt: { gte: since } } });
  }
}
