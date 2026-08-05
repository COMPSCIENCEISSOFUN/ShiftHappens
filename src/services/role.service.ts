/**
 * Role Service (Control Layer)
 * 
 * Business logic for custom role management.
 * Enforces rules:
 * - No duplicate role names within the same org
 * - System roles (company_admin, manager, staff) cannot be modified or deleted
 * - Every custom role must have at least one permission
 */
import { RoleRepository } from "@/repositories/role.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { WorkRuleRepository } from "@/repositories/work-rule.repository";
import { uniqueRoleName } from "@/lib/role-slug";
import type { CreateRoleInput, UpdateRoleInput } from "@/lib/validations";
import { SubscriptionService } from "@/services/subscription.service";

export class RoleService {
  private workRuleRepo = new WorkRuleRepository();
  private roleRepo = new RoleRepository();
  private auditService = new AuditLogService();
  private subscriptionService = new SubscriptionService();

  /**
   * Creates a new custom role in an organization.
   *
   * ## One name, not two
   *
   * The caller supplies only the display label. The stored `name` is derived
   * from it — the form used to ask for both, annotating the second "Used in
   * code. Lowercase, no spaces." when nothing read it, nothing validated the
   * format, and nothing could change it afterwards.
   *
   * ## Uniqueness moved to the label
   *
   * `@@unique([organizationId, name])` guarded the field nobody sees, so two
   * roles could both be labelled "Shift Lead" — stored as `shift_lead` and
   * `shiftlead` — and show as two identical entries in the roles list and every
   * member dropdown. The label is checked first now, case-insensitively,
   * because "Shift Lead" and "shift lead" are the same role to anyone reading a
   * dropdown.
   *
   * The derived name is then made unique separately. That second step is not
   * redundant: two DIFFERENT labels can slug to the same string, and the
   * database index is on the slug.
   */
  async create(input: CreateRoleInput, organizationId: string, userId?: string) {
    await this.subscriptionService.enforceFeatureAccess(organizationId, 'custom_roles');
    await this.subscriptionService.enforceResourceLimit(organizationId, 'custom_roles');

    const displayLabel = input.displayLabel.trim();

    const labelExists = await this.roleRepo.labelExistsInOrg(
      displayLabel,
      organizationId
    );
    if (labelExists) {
      throw new Error(`A role called "${displayLabel}" already exists`);
    }

    const name = uniqueRoleName(
      displayLabel,
      await this.roleRepo.takenNamesInOrg(organizationId)
    );
    // Validation refuses a label with no letters or digits, so an empty slug
    // here means the label was all punctuation or the collision loop ran out.
    // Either way it is a refusal, not something to paper over with a random id.
    if (!name) {
      throw new Error("Role name needs at least one letter or number");
    }

    const role = await this.roleRepo.create({
      name,
      displayLabel,
      description: input.description,
      organizationId,
      permissionIds: input.permissionIds,
    });

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.ROLE_CREATED,
      entityType: "role",
      entityId: role.id,
      details: { name, displayLabel, permissionCount: input.permissionIds.length },
    });

    return role;
  }

  /** Retrieves all roles for an organization */
  async getByOrganization(organizationId: string) {
    return this.roleRepo.findByOrganizationId(organizationId);
  }

  /**
   * Retrieves a single role by ID, scoped to an organization.
   * Returns null for a missing role OR one owned by another tenant.
   */
  async getById(roleId: string, organizationId: string) {
    const role = await this.roleRepo.findById(roleId);
    if (!role || role.organizationId !== organizationId) return null;
    return role;
  }

  /**
   * Updates a custom role's display label, description, or permissions.
   * System roles cannot be modified.
   */
  async update(roleId: string, organizationId: string, input: UpdateRoleInput, userId?: string) {
    const role = await this.roleRepo.findById(roleId);
    if (!role || role.organizationId !== organizationId) {
      throw new Error("Role not found");
    }

    if (role.isSystemRole) {
      throw new Error("Cannot modify system roles");
    }

    /*
     * Renaming has to respect the same uniqueness the create path does, or the
     * rule only holds for roles nobody has edited since.
     *
     * The stored `name` deliberately does NOT follow a rename. It is an
     * internal identifier that appears in audit-log entries already written,
     * and re-slugging it would make yesterday's log refer to a name that no
     * longer exists. Nothing reads it, so letting it drift from the label costs
     * nothing — which is the same reason the form stopped asking for it.
     */
    if (input.displayLabel !== undefined) {
      const label = input.displayLabel.trim();
      const clash = await this.roleRepo.labelExistsInOrg(
        label,
        organizationId,
        roleId
      );
      if (clash) {
        throw new Error(`A role called "${label}" already exists`);
      }
    }

    const updated = await this.roleRepo.update(roleId, {
      displayLabel: input.displayLabel?.trim(),
      description: input.description,
      permissionIds: input.permissionIds,
    });

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.ROLE_UPDATED,
      entityType: "role",
      entityId: roleId,
      details: { displayLabel: input.displayLabel },
    });

    return updated;
  }

  /**
   * Deletes a custom role.
   * System roles cannot be deleted.
   */

  /**
   * Refuses the delete while work rules still target this role.
   *
   * The database now enforces it too — the FK is `onDelete: Restrict` — but a
   * constraint violation reaches the caller as an opaque 500. This runs first
   * so the admin gets a sentence they can act on, and the constraint is the
   * backstop rather than the error anybody sees.
   *
   * Names, not a count: "3 work rules target this role" says there is a
   * problem and nothing about how to solve it.
   */
  private async assertNoWorkRulesTargetRole(id: string) {
    const rules = await this.workRuleRepo.findTargeting({ roleId: id });
    if (rules.length === 0) return;

    const names = rules.map((r) => r.name).join(", ");
    throw new Error(
      `Cannot delete: ${rules.length} work rule${rules.length === 1 ? "" : "s"} ` +
        `target${rules.length === 1 ? "s" : ""} this role (${names}). ` +
        `Retarget or delete ${rules.length === 1 ? "it" : "them"} first.`
    );
  }

  async delete(roleId: string, organizationId: string, userId?: string) {
    const role = await this.roleRepo.findById(roleId);
    if (!role || role.organizationId !== organizationId) {
      throw new Error("Role not found");
    }

    if (role.isSystemRole) {
      throw new Error("Cannot delete system roles");
    }

    await this.assertNoWorkRulesTargetRole(roleId);

    const deleted = await this.roleRepo.delete(roleId);

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.ROLE_DELETED,
      entityType: "role",
      entityId: roleId,
      details: { name: role.name },
    });

    return deleted;
  }

  /** Returns all available permissions for the role creation/edit UI */
  async getAllPermissions() {
    return this.roleRepo.getAllPermissions();
  }
}