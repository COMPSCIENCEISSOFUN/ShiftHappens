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
import { SubscriptionService } from "@/services/subscription.service";
import type { CreateDepartmentInput, UpdateDepartmentInput } from "@/lib/validations";

export class DepartmentService {
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

  /** Retrieves a single department by ID */
  async getById(departmentId: string) {
    return this.deptRepo.findById(departmentId);
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
  async getImpactSummary(departmentId: string) {
    return this.deptRepo.getImpactSummary(departmentId);
  }

  /**
   * Archives a department (soft-delete).
   * Sets archivedAt timestamp — department is hidden from active views
   * but all data (tasks, memberships, work rules) is preserved.
   */
  async archive(departmentId: string, organizationId: string, userId?: string) {
    const dept = await this.deptRepo.findById(departmentId);
    if (!dept) {
      throw new Error("Department not found");
    }
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
    const dept = await this.deptRepo.findById(departmentId);
    if (!dept) {
      throw new Error("Department not found");
    }
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
  async delete(departmentId: string, organizationId: string, userId?: string) {
    const dept = await this.deptRepo.findById(departmentId);
    if (!dept) {
      throw new Error("Department not found");
    }
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
