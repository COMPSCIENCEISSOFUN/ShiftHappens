/**
 * FAQ data access (Entity layer).
 *
 * No organizationId anywhere: there is one marketing site, edited by the
 * platform admin. The published read runs on the server while the landing page
 * renders, so this data reaches the public without a public endpoint.
 */
import { prisma } from "@/lib/prisma";

export interface FaqEntryData {
  question: string;
  answer: string;
  position?: number;
  published?: boolean;
}

export class FaqRepository {
  /**
   * What the landing page shows.
   *
   * `id` after `position` because position is editorial and duplicates are
   * expected — two entries both at 0 is what "I have not ordered these yet"
   * looks like, and without a tiebreaker they would swap places between
   * renders.
   */
  async findPublished() {
    return prisma.faqEntry.findMany({
      where: { published: true },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { id: true, question: true, answer: true },
    });
  }

  /** Everything, drafts included, for the editor. */
  async findAll() {
    return prisma.faqEntry.findMany({
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });
  }

  async findById(id: string) {
    return prisma.faqEntry.findUnique({ where: { id } });
  }

  async create(data: FaqEntryData) {
    return prisma.faqEntry.create({ data });
  }

  async update(id: string, data: Partial<FaqEntryData>) {
    return prisma.faqEntry.update({ where: { id }, data });
  }

  async delete(id: string) {
    return prisma.faqEntry.delete({ where: { id } });
  }

  /** Highest position in use, so a new entry lands at the end rather than the top. */
  async highestPosition(): Promise<number> {
    const top = await prisma.faqEntry.findFirst({
      orderBy: [{ position: "desc" }, { id: "asc" }],
      select: { position: true },
    });
    return top?.position ?? -1;
  }
}
