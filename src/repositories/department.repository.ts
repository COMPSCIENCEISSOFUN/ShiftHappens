/**
 * Department Repository (Entity Layer)
 *
 * Data access layer for Department model operations.
 * All queries are org-scoped to enforce multi-tenant data isolation.
 *
 * Supports soft-delete (archive) pattern:
 *  - findByOrganizationId excludes archived by default
 *  - archive/unarchive toggle archivedAt timestamp
 *  - permanent delete requires department to be archived first
 *  - getImpactSummary returns counts of affected entities before archive
 *
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { prisma } from "@/lib/prisma";

export class DepartmentRepository {
  /** Creates a new department within an organization */
  async create(data: {
    name: string;
    description?: string;
    organizationId: string;
    color?: string;
  }) {
    return prisma.department.create({
      data: {
        name: data.name,
        description: data.description,
        organizationId: data.organizationId,
        color: data.color,
      },
    });
  }

  /** Finds a department by ID, includes member count */
  async findById(id: string) {
    return prisma.department.findUnique({
      where: { id },
      include: {
        _count: {
          select: { departmentMemberships: true, tasks: true },
        },
      },
    });
  }

  /**
   * Finds all departments for an organization.
   * Org-scoped query for tenant isolation.
   * Includes member count for display purposes.
   *
   * @param includeArchived  When true, returns archived departments too
   *                         (used by the Departments management page).
   */
  /**
   * How many of these department ids belong to this organisation.
   *
   * Exists so a caller can prove a LIST of ids without pulling every
   * department, and without N queries. The comparison against the caller's own
   * list length is what makes it a proof: fewer means at least one id was not
   * ours.
   */
  async countOwned(departmentIds: string[], organizationId: string): Promise<number> {
    if (departmentIds.length === 0) return 0;
    return prisma.department.count({
      where: { id: { in: departmentIds }, organizationId },
    });
  }

  async findByOrganizationId(
    organizationId: string,
    includeArchived = false,
    /**
     * The caller's department scope, or null/undefined for an unrestricted one.
     *
     * `null` and `undefined` both mean "every department", matching
     * `departmentScopeFor`, whose null is what a company admin gets. An EMPTY
     * array is not the same thing and must not collapse into it: a manager
     * assigned to no departments is scoped to nothing, and returning the whole
     * organisation to them is the bug this parameter exists to fix.
     */
    departmentIds?: string[] | null
  ) {
    return prisma.department.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
        ...(departmentIds != null ? { id: { in: departmentIds } } : {}),
      },
      include: {
        _count: {
          select: { departmentMemberships: true, tasks: true },
        },
      },
      orderBy: { name: "asc" },
    });
  }

  /**
   * Active departments with their member and task counts, unordered.
   *
   * Separate from `findByOrganizationId` because the caller is aggregating,
   * not rendering a list: the counts are summarised for the AI dashboard and
   * sorting them by name would be work nobody reads.
   */
  async findActiveWithCounts(organizationId: string) {
    return prisma.department.findMany({
      where: { organizationId, archivedAt: null },
      include: {
        _count: {
          select: {
            departmentMemberships: true,
            // Only work still to be done.
            //
            // This counted EVERY task the department had ever held, so a
            // department with three months of completed history reported
            // dozens of tasks against a handful of staff and looked
            // catastrophically understaffed. The figure is fed to the model as
            // ground truth, which then reasoned confidently from it — a false
            // premise producing a fluent, wrong conclusion.
            tasks: { where: { status: { in: ["open", "in_progress"] } } },
          },
        },
      },
    });
  }

  /**
   * Just the id and name of each active department.
   *
   * The AI task parser matches free text against this list, so archived
   * departments must stay out of it — the model would happily file a new task
   * into a department the organisation has already retired.
   */
  async findActiveNames(organizationId: string) {
    return prisma.department.findMany({
      where: { organizationId, archivedAt: null },
      select: { id: true, name: true },
    });
  }

  /** Updates a department's name and/or description */
  async update(
    id: string,
    data: { name?: string; description?: string; color?: string }
  ) {
    return prisma.department.update({
      where: { id },
      data,
    });
  }

  /**
   * Archives a department by setting archivedAt to now.
   * Archived departments are hidden from active views but data is preserved.
   */
  async archive(id: string) {
    return prisma.department.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
  }

  /**
   * Unarchives a department by clearing archivedAt.
   * Restores the department to active status.
   */
  async unarchive(id: string) {
    return prisma.department.update({
      where: { id },
      data: { archivedAt: null },
    });
  }

  /**
   * Returns counts of entities that would be affected by archiving/deleting.
   * Shown to the admin as an impact summary before they confirm.
   */
  async getImpactSummary(departmentId: string) {
    const [memberCount, activeTaskCount, workRuleCount] = await Promise.all([
      prisma.departmentMembership.count({
        where: { departmentId },
      }),
      prisma.task.count({
        where: {
          departmentId,
          status: { in: ["open", "in_progress"] },
        },
      }),
      prisma.workRule.count({
        where: { departmentId },
      }),
    ]);

    return { memberCount, activeTaskCount, workRuleCount };
  }

  /**
   * Permanently deletes a department.
   * Caller must verify the department is archived first.
   */
  async delete(id: string) {
    return prisma.department.delete({
      where: { id },
    });
  }

  /**
   * Checks if a department has any assigned members.
   * Used to block archival when staff are still assigned.
   */
  async hasMembers(departmentId: string): Promise<boolean> {
    const count = await prisma.departmentMembership.count({
      where: { departmentId },
    });
    return count > 0;
  }

  /**
   * Checks if a department name already exists within an organization.
   * Used to prevent duplicate department names per org.
   * Optional excludeId parameter for update operations (exclude self).
   */
  async nameExistsInOrg(
    name: string,
    organizationId: string,
    excludeId?: string
  ): Promise<boolean> {
    const count = await prisma.department.count({
      where: {
        name,
        organizationId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    return count > 0;
  }
}
