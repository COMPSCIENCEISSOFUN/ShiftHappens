/**
 * Industry Template Repository (Entity Layer)
 *
 * Data access layer for IndustryTemplate model.
 * Handles CRUD operations and active template queries.
 * Platform-level — not org-scoped.
 */
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";


/**
 * Oldest first, with a tiebreak — a TOTAL order, not just a sort key.
 *
 * `createdAt` alone is not enough. Prisma maps `DateTime` to `timestamp(3)`, so
 * two rows created in the same millisecond carry the same value, and Postgres
 * gives no defined order for ties: the same query can return them either way
 * round on successive calls. That is precisely the instability an `orderBy` is
 * added to remove, so a partial order here is worse than none — it looks
 * deterministic and is not.
 *
 * It is not hypothetical. This surfaced as a test that passed on a slow machine
 * (two creates 50ms apart) and failed on a fast one, where both landed in the
 * same millisecond.
 *
 * `id` is the tiebreak because cuid carries a base36 timestamp and a
 * per-process counter, so ids from one process sort in creation order — the
 * tiebreak agrees with the intent rather than merely being stable. Stability is
 * the property that matters, though: at a millisecond tie, true creation order
 * is not recoverable from the data anyway.
 */
const OLDEST_FIRST = [
  { createdAt: "asc" },
  { id: "asc" },
] satisfies { createdAt?: "asc"; id?: "asc" }[];

export class IndustryTemplateRepository {
  /** Returns all templates (including inactive) — for platform admin */
  async findAll() {
    return prisma.industryTemplate.findMany({
      orderBy: OLDEST_FIRST,
    });
  }

  /** Returns only active templates — for onboarding and settings */
  async findActive() {
    return prisma.industryTemplate.findMany({
      where: { isActive: true },
      orderBy: OLDEST_FIRST,
    });
  }

  /** Finds a single template by ID */
  async findById(id: string) {
    return prisma.industryTemplate.findUnique({ where: { id } });
  }

  /** Finds a template by name — used for uniqueness checks */
  async findByName(name: string) {
    return prisma.industryTemplate.findUnique({ where: { name } });
  }

  /** Creates a new template */
  async create(data: {
    name: string;
    icon: string;
    description: string;
    departments: Prisma.InputJsonValue;
    workRules: Prisma.InputJsonValue;
    certifications: Prisma.InputJsonValue;
    isAiGenerated?: boolean;
  }) {
    return prisma.industryTemplate.create({
      data: {
        name: data.name,
        icon: data.icon,
        description: data.description,
        departments: data.departments,
        workRules: data.workRules,
        certifications: data.certifications,
        isAiGenerated: data.isAiGenerated ?? false,
      },
    });
  }

  /** Updates an existing template */
  async update(
    id: string,
    data: {
      name?: string;
      icon?: string;
      description?: string;
      departments?: Prisma.InputJsonValue;
      workRules?: Prisma.InputJsonValue;
      certifications?: Prisma.InputJsonValue;
      isActive?: boolean;
    }
  ) {
    return prisma.industryTemplate.update({
      where: { id },
      data,
    });
  }

  /** Soft-delete — sets isActive to false */
  async deactivate(id: string) {
    return prisma.industryTemplate.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /** Reactivate a deactivated template */
  async activate(id: string) {
    return prisma.industryTemplate.update({
      where: { id },
      data: { isActive: true },
    });
  }

  /** Count how many organizations were created from this template */
  async getUsageCount(templateId: string): Promise<number> {
    return prisma.organization.count({
      where: { templateId },
    });
  }

  /** Count usage for all templates in one query */
  async getUsageCounts(): Promise<Record<string, number>> {
    const counts = await prisma.organization.groupBy({
      by: ["templateId"],
      _count: { templateId: true },
      where: { templateId: { not: null } },
    });

    const result: Record<string, number> = {};
    for (const row of counts) {
      if (row.templateId) {
        result[row.templateId] = row._count.templateId;
      }
    }
    return result;
  }
}