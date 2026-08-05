/**
 * Work Rule Repository (Entity Layer)
 *
 * Data access layer for custom work rules (break intervals,
 * daily/weekly hour limits). Supports org-scoped CRUD and
 * querying applicable rules for eligibility checks.
 *
 * Rules can target globally, by department, or by custom role.
 * All queries are org-scoped for multi-tenant isolation.
 */
import { prisma } from "@/lib/prisma";

const RULE_INCLUDE = {
  role: { select: { id: true, name: true, displayLabel: true } },
  department: { select: { id: true, name: true } },
};

export class WorkRuleRepository {
  /** Creates a new work rule within an organization */
  async create(data: {
    organizationId: string;
    name: string;
    type: string;
    roleId?: string | null;
    departmentId?: string | null;
    hoursThreshold?: number | null;
    breakHours?: number | null;
    maxHours?: number | null;
    isActive?: boolean;
  }) {
    return prisma.workRule.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        type: data.type,
        roleId: data.roleId ?? null,
        departmentId: data.departmentId ?? null,
        hoursThreshold: data.hoursThreshold ?? null,
        breakHours: data.breakHours ?? null,
        maxHours: data.maxHours ?? null,
        isActive: data.isActive ?? true,
      },
      include: RULE_INCLUDE,
    });
  }

  /** Finds a work rule by ID */
  async findById(id: string) {
    return prisma.workRule.findUnique({
      where: { id },
      include: RULE_INCLUDE,
    });
  }

  /** Lists all work rules for an organization */
  async findByOrganizationId(organizationId: string) {
    return prisma.workRule.findMany({
      where: { organizationId },
      include: RULE_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /**
   * Finds all active rules for an organization.
   * Returns ALL active rules — filtering by department/role
   * is handled per-member in the eligibility engine.
   */
  async findApplicableRules(
    organizationId: string,
    roleId?: string | null
  ) {
    return prisma.workRule.findMany({
      where: {
        organizationId,
        isActive: true,
        ...(roleId ? {
          OR: [
            { roleId: null },
            { roleId },
          ],
        } : {}),
      },
      include: RULE_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /** Checks if a work rule name already exists in the organization */
  async existsByName(organizationId: string, name: string, excludeId?: string) {
    const existing = await prisma.workRule.findUnique({
      where: {
        organizationId_name: { organizationId, name },
      },
    });
    if (!existing) return false;
    if (excludeId && existing.id === excludeId) return false;
    return true;
  }

  /** Updates a work rule's fields */
  async update(
    id: string,
    data: {
      name?: string;
      type?: string;
      roleId?: string | null;
      departmentId?: string | null;
      hoursThreshold?: number | null;
      breakHours?: number | null;
      maxHours?: number | null;
      isActive?: boolean;
    }
  ) {
    return prisma.workRule.update({
      where: { id },
      data,
      include: RULE_INCLUDE,
    });
  }

  /** Deletes a work rule */

  /**
   * The rules that target a given role or department, by name.
   *
   * For the delete guards on roles and departments. Names rather than a bare
   * count, because "3 work rules target this role" tells an admin they have a
   * problem and nothing about how to solve it — the names are what let them go
   * and deal with the right ones.
   */
  async findTargeting(target: {
    roleId?: string;
    departmentId?: string;
  }): Promise<{ id: string; name: string }[]> {
    return prisma.workRule.findMany({
      where: target.roleId
        ? { roleId: target.roleId }
        : { departmentId: target.departmentId },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  }

  async delete(id: string) {
    return prisma.workRule.delete({ where: { id } });
  }
}