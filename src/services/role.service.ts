/**
 * Role Service (Control Layer)
 * 
 * Business logic for custom role management.
 * Enforces rules:
 * - No duplicate role names within the same org
 * - System roles (company_admin, manager, staff) cannot be modified or deleted
 * - Every custom role must have at least one permission
 */
import { OrganizationRepository } from "@/repositories/organization.repository";
import { PERMISSION_FEATURE } from "@/lib/permissions";
import {
  getMinimumTierForFeature,
  isFeatureAvailable,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";
import { RoleRepository } from "@/repositories/role.repository";
import { MembershipRepository } from "@/repositories/membership.repository";
import { AccessService } from "@/services/access.service";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { WorkRuleRepository } from "@/repositories/work-rule.repository";
import { uniqueRoleName } from "@/lib/role-slug";
import type { CreateRoleInput, UpdateRoleInput } from "@/lib/validations";
import { SubscriptionService } from "@/services/subscription.service";

export class RoleService {
  private workRuleRepo = new WorkRuleRepository();
  private orgRepo = new OrganizationRepository();
  private roleRepo = new RoleRepository();
  private membershipRepo = new MembershipRepository();
  private accessService = new AccessService();
  private auditService = new AuditLogService();
  private subscriptionService = new SubscriptionService();

  /**
   * Refuses to put a permission into a role that the author does not hold.
   *
   * ## The hole this closes
   *
   * `assertCustomRoleAssignable` in `user-management.service.ts` already
   * refuses to ASSIGN a role containing permissions the assigner lacks, and its
   * docblock names the risk exactly: "authority delegated by proxy, by someone
   * who never had it". That check ran on assign and nowhere else.
   *
   * So the whole thing could be walked around without ever assigning anything.
   * Delegate `roles:manage` to a manager, and they open the role they are
   * already wearing, tick `billing:manage`, and save. `effectivePermissions`
   * reads the role's permissions live on the next request, so they hold it
   * immediately — no second person, no assign step, no sign-out. The guard on
   * the assign path was left checking the one route nobody needed to take.
   *
   * ## Subset, not admin-only
   *
   * The same reasoning as the assign-time check: delegating a NARROWER role is
   * what `roles:manage` is for, and a company admin holds the whole catalogue
   * so this never constrains one. What it forbids is a role growing beyond its
   * author.
   *
   * ## No actor, no check
   *
   * `userId` is optional throughout this service because the seed and other
   * system paths create roles with no human behind them. Those are trusted by
   * construction — the alternative is a seed that cannot build an admin role.
   */
  private async assertMayGrantPermissions(
    organizationId: string,
    permissionIds: readonly string[],
    userId?: string
  ) {
    if (!userId || permissionIds.length === 0) return;

    const actor = await this.membershipRepo.findByUserAndOrg(
      userId,
      organizationId
    );
    if (!actor) throw new Error("Not authorized to manage roles");

    const held = this.accessService.permissionsFor(actor);
    const names = await this.roleRepo.permissionNamesByIds(permissionIds);
    const excess = names.filter((name) => !held.has(name));
    if (excess.length > 0) {
      throw new Error(
        `You cannot grant permissions you do not hold: ${excess.join(", ")}`
      );
    }
  }

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

    // Every permission, because the role does not exist yet — all of them are
    // being added.
    await this.assertMayGrantPermissions(
      organizationId,
      input.permissionIds,
      userId
    );

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

  /**
   * Every role in an organisation, with two facts the list cannot work out for
   * itself: how many people hold each one, and whether the caller is one of
   * them.
   *
   * `heldByCaller` is answered here rather than on the page because the page
   * only knows the caller's permission NAMES — the provider deliberately
   * carries nothing else — and comparing a role's label against the chip in the
   * sidebar would be guessing at identity from a string two people could share.
   *
   * Without `userId` — a system path, or a caller outside the org — nobody
   * holds anything, which is the honest answer rather than a missing field the
   * UI would have to treat as false anyway.
   */
  async getByOrganization(organizationId: string, userId?: string) {
    const roles = await this.roleRepo.findByOrganizationId(organizationId);
    const actor = userId
      ? await this.membershipRepo.findByUserAndOrg(userId, organizationId)
      : null;

    return roles.map(({ _count, ...role }) => ({
      ...role,
      memberCount: _count.memberCustomRoles,
      heldByCaller: actor?.customRoleId === role.id,
    }));
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
     * Only what is being ADDED, not everything submitted.
     *
     * The role form resends the complete permission list on every save, so
     * checking all of it would refuse a rename — the edit would be judged on
     * permissions the role already had and nobody was touching. That is the
     * same failure shape as the self-role guard, which threw "You cannot change
     * your own role" at an admin putting themselves in a department, because it
     * compared ids instead of comparing the role to the role.
     *
     * Removals are deliberately unchecked. Taking a permission out of a role
     * grants nobody anything, and refusing it would trap a role in a state its
     * current editor cannot reduce.
     */
    if (input.permissionIds !== undefined) {
      const current = new Set(role.rolePermissions.map((rp) => rp.permissionId));
      const added = input.permissionIds.filter((id) => !current.has(id));
      await this.assertMayGrantPermissions(organizationId, added, userId);
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

    /*
     * Counted BEFORE the delete, which is the only moment the number exists.
     * `Membership.customRoleId` is `onDelete: SetNull`, so the rows survive
     * with the link blanked — afterwards there is nothing left to count and no
     * record anywhere of who lost what.
     *
     * That is also why this is not a refusal. Stripping a role from its holders
     * is what deleting one MEANS, and the holders keep their system-role
     * permissions either way. It is recoverable by re-creating the role and
     * re-assigning it, and the audit entry is what makes that possible.
     */
    const holderCount = await this.membershipRepo.countByCustomRole(roleId);

    const deleted = await this.roleRepo.delete(roleId);

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.ROLE_DELETED,
      entityType: "role",
      entityId: roleId,
      details: { name: role.name, displayLabel: role.displayLabel, holderCount },
    });

    return deleted;
  }

  /** Returns all available permissions for the role creation/edit UI */
  /**
   * The permission catalogue, each entry saying whether this organisation's
   * plan can actually honour it.
   *
   * ## Why the plan has to travel with the catalogue
   *
   * `PERMISSION_FEATURE` maps a permission onto a gated feature and the route
   * guard checks the plan BEFORE the permission, so granting `audit:view` to a
   * Pro organisation opens nothing. That enforcement is correct; the role
   * builder just did not know about it and rendered the entry as an ordinary
   * checkbox.
   *
   * The result was a control that could never work for anybody able to see it.
   * Custom roles are Pro-and-above and `audit_log` was Enterprise-only, so
   * every organisation with a role builder was one for which that box was a
   * guaranteed no-op — an interface implying something the system would not do,
   * the same shape as the AI badge over algorithmic output.
   *
   * **`audit_log` moved to Pro on 2026-08-11, so that particular box now
   * works.** This method is unchanged and did not need to be: it computes
   * availability from `isFeatureAvailable` rather than naming a tier, so the
   * move propagated on its own. The example is kept because the SHAPE recurs —
   * `priority_support` is Enterprise-only today and reachable through no
   * permission at all, and the next gated feature added at the top tier will
   * land in exactly this position.
   *
   * `requiredTier` is returned rather than a bare boolean so the screen can say
   * WHICH plan is needed. A named plan is actionable; "unavailable" invites a
   * support ticket.
   */
  async getAllPermissions(organizationId?: string) {
    const permissions = await this.roleRepo.getAllPermissions();
    if (!organizationId) return permissions;

    const org = await this.orgRepo.findById(organizationId);
    const tier = (org?.subscriptionTier ?? "free") as SubscriptionTier;

    return permissions.map((permission) => {
      const feature = PERMISSION_FEATURE[permission.name];
      // Ungated permissions are returned untouched rather than carrying
      // `available: true`. Absent means "no plan question here", which is a
      // different statement from "your plan allows it".
      if (!feature) return permission;
      return {
        ...permission,
        available: isFeatureAvailable(tier, feature),
        requiredTier: getMinimumTierForFeature(feature),
      };
    });
  }
}