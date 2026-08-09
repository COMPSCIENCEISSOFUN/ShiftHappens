/**
 * Certification Type Repository (Entity Layer)
 *
 * The organisation's list of recognised certificates. Every query is org-scoped
 * for tenant isolation; a certificate vocabulary is as much a fact about one
 * organisation as its departments are.
 */
import { prisma } from "@/lib/prisma";

export class CertificationTypeRepository {
  /** Every type in an organisation, alphabetically — the order both pickers show. */
  async findByOrganizationId(organizationId: string) {
    return prisma.certificationType.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
    });
  }

  async findById(id: string) {
    return prisma.certificationType.findUnique({ where: { id } });
  }

  async create(organizationId: string, name: string) {
    return prisma.certificationType.create({
      data: { organizationId, name },
    });
  }

  async delete(id: string) {
    return prisma.certificationType.delete({ where: { id } });
  }

  /**
   * Is this name already taken in the organisation, ignoring case?
   *
   * Case-INSENSITIVE, unlike the unique index beneath it. Eligibility compares
   * `name.trim().toLowerCase()` on both sides, so "Food Safety" and "food
   * safety" are one certificate — two entries for it would be two ways to
   * express the same requirement, which is the ambiguity this whole table
   * exists to remove.
   *
   * `excludeId` is for a future rename. Nothing calls it with one yet; it is
   * here because a uniqueness check without it is the thing that refuses an
   * edit for clashing with itself, which this codebase has already been bitten
   * by once.
   */
  async nameExistsInOrg(
    name: string,
    organizationId: string,
    excludeId?: string
  ): Promise<boolean> {
    const match = await prisma.certificationType.findFirst({
      where: {
        organizationId,
        name: { equals: name.trim(), mode: "insensitive" },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    return match !== null;
  }

  /** How many tasks still require this exact name, ignoring case. */
  async countTasksRequiring(
    organizationId: string,
    name: string
  ): Promise<number> {
    /*
     * `has` on a `String[]` is case-SENSITIVE and cannot be made otherwise, so
     * this reads the column and compares in application code. The alternative
     * is a raw query; at the scale of one organisation's task list, filtering
     * in memory is the cheaper thing to be able to read.
     */
    const rows = await prisma.task.findMany({
      where: { organizationId },
      select: { requiredCertifications: true },
    });
    const needle = name.trim().toLowerCase();
    return rows.filter((t) =>
      (t.requiredCertifications ?? []).some(
        (c) => c.trim().toLowerCase() === needle
      )
    ).length;
  }
}
