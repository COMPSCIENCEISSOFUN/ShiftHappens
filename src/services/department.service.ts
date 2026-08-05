/**
 * Department Service (Control Layer)
 *
 * Business logic for department management within an organization.
 * Enforces rules:
 * - No duplicate department names within the same org
 * - Subscription tier limits on department count
 *
 * Supports soft-delete (archive) lifecycle:
 *  1. Archive: sets archivedAt, hides from active views
 *  2. Unarchive: clears archivedAt, restores to active
 *  3. Permanent delete: only allowed on already-archived departments
 *  4. Impact summary: counts affected entities before archive
 */
import { DepartmentRepository } from "@/repositories/department.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { WorkRuleRepository } from "@/repositories/work-rule.repository";
import { SubscriptionService } from "@/services/subscription.service";
import type { CreateDepartmentInput, UpdateDepartmentInput } from "@/lib/validations";

export class DepartmentService {
  private workRuleRepo = new WorkRuleRepository();
  private deptRepo = new DepartmentRepository();
  private auditService = new AuditLogService();
  private subscriptionService = new SubscriptionService();

  /**
   * Creates a new department in an organization.
   * Checks subscription limit, then duplicate names before creating.
   */
  async create(input: CreateDepartmentInput, organizationId: string, userId?: string) {
    await this.subscriptionService.enforceResourceLimit(organizationId, 'departments');

    const nameExists = await this.deptRepo.nameExistsInOrg(
      input.name,
      organizationId
    );
    if (nameExists) {
      throw new Error("Department name already exists");
    }

    const department = await this.deptRepo.create({
      name: input.name,
      description: input.description,
      color: input.color,
      organizationId,
    });

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.DEPARTMENT_CREATED,
      entityType: "department",
      entityId: department.id,
      details: { name: input.name, color: input.color },
    });

    return department;
  }

  /**
   * Retrieves all active departments for an organization.
   * Archived departments are excluded by default.
   *
   * @param includeArchived  When true, returns archived departments too
   *                         (used by the Departments management page).
   */
  async getByOrganization(organizationId: string, includeArchived = false) {
    return this.deptRepo.findByOrganizationId(organizationId, includeArchived);
  }

  /**
   * Loads a department and asserts it belongs to the calling organisation.
   *
   * `DepartmentRepository.findById` is a bare `findUnique` on the primary key,
   * so on its own it will happily return another tenant's department. Every
   * method that takes a client-supplied `departmentId` must go through here
   * first — mirroring `TaskService.update`, which has always done this.
   *
   * A cross-tenant id is reported as "Department not found" rather than
   * "Forbidden": telling a caller that an id exists but belongs to someone else
   * is itself a disclosure, and the route already maps this message to 404.
   */
  private async requireOwned(departmentId: string, organizationId: string) {
    const dept = await this.deptRepo.findById(departmentId);
    if (!dept || dept.organizationId !== organizationId) {
      throw new Error("Department not found");
    }
    return dept;
  }

  /** Retrieves a single department by ID, scoped to the organisation. */
  async getById(departmentId: string, organizationId: string) {
    return this.requireOwned(departmentId, organizationId);
  }

  /**
   * Updates a department's name and/or description.
   * Checks for name conflicts, excluding the department being updated.
   */
  async update(
    departmentId: string,
    organizationId: string,
    input: UpdateDepartmentInput,
    userId?: string
  ) {
    await this.requireOwned(departmentId, organizationId);

    if (input.name) {
      const nameExists = await this.deptRepo.nameExistsInOrg(
        input.name,
        organizationId,
        departmentId
      );
      if (nameExists) {
        throw new Error("Department name already exists");
      }
    }

    const department = await this.deptRepo.update(departmentId, {
      name: input.name,
      description: input.description,
      color: input.color,
    });

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.DEPARTMENT_UPDATED,
      entityType: "department",
      entityId: departmentId,
      details: { name: input.name, description: input.description, color: input.color },
    });

    return department;
  }

  /**
   * Returns counts of entities that would be affected by archiving a department.
   * Shown to the admin as an impact summary before they confirm.
   */
  async getImpactSummary(departmentId: string, organizationId: string) {
    await this.requireOwned(departmentId, organizationId);
    return this.deptRepo.getImpactSummary(departmentId);
  }

  /**
   * Archives a department (soft-delete).
   * Sets archivedAt timestamp — department is hidden from active views
   * but all data (tasks, memberships, work rules) is preserved.
   */
  async archive(departmentId: string, organizationId: string, userId?: string) {
    const dept = await this.requireOwned(departmentId, organizationId);
    if (dept.archivedAt) {
      throw new Error("Department is already archived");
    }

    const archived = await this.deptRepo.archive(departmentId);

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.DEPARTMENT_ARCHIVED,
      entityType: "department",
      entityId: departmentId,
      details: { name: dept.name },
    });

    return archived;
  }

  /**
   * Unarchives a department — restores it to active status.
   * Clears the archivedAt timestamp so the department reappears
   * in active views, dropdowns, and task assignment.
   */
  async unarchive(departmentId: string, organizationId: string, userId?: string) {
    const dept = await this.requireOwned(departmentId, organizationId);
    if (!dept.archivedAt) {
      throw new Error("Department is not archived");
    }

    const unarchived = await this.deptRepo.unarchive(departmentId);

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.DEPARTMENT_UNARCHIVED,
      entityType: "department",
      entityId: departmentId,
      details: { name: dept.name },
    });

    return unarchived;
  }

  /**
   * Permanently deletes an archived department.
   * Only allowed on departments that have already been archived.
   * Also checks that no members are still assigned.
   */

  /**
   * Refuses the delete while work rules still target this department.
   *
   * The database now enforces it too — the FK is `onDelete: Restrict` — but a
   * constraint violation reaches the caller as an opaque 500. This runs first
   * so the admin gets a sentence they can act on, and the constraint is the
   * backstop rather than the error anybody sees.
   *
   * Names, not a count: "3 work rules target this department" says there is a
   * problem and nothing about how to solve it.
   */
  private async assertNoWorkRulesTargetDepartment(id: string) {
    const rules = await this.workRuleRepo.findTargeting({ departmentId: id });
    if (rules.length === 0) return;

    const names = rules.map((r) => r.name).join(", ");
    throw new Error(
      `Cannot delete: ${rules.length} work rule${rules.length === 1 ? "" : "s"} ` +
        `target${rules.length === 1 ? "s" : ""} this department (${names}). ` +
        `Retarget or delete ${rules.length === 1 ? "it" : "them"} first.`
    );
  }

  async delete(departmentId: string, organizationId: string, userId?: string) {
    const dept = await this.requireOwned(departmentId, organizationId);
    if (!dept.archivedAt) {
      throw new Error(
        "Department must be archived before it can be permanently deleted"
      );
    }

    const hasMembers = await this.deptRepo.hasMembers(departmentId);
    if (hasMembers) {
      throw new Error(
        "Cannot delete department with assigned members. Please reassign or remove members first."
      );
    }

    await this.assertNoWorkRulesTargetDepartment(departmentId);

    const deleted = await this.deptRepo.delete(departmentId);

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.DEPARTMENT_DELETED,
      entityType: "department",
      entityId: departmentId,
      details: { name: dept.name },
    });

    return deleted;
  }
}
