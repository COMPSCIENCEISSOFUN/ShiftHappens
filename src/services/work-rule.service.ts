/**
 * Work Rule Service (Control Layer)
 *
 * Business logic for custom work rules including:
 * - CRUD with field validation per rule type
 * - Name uniqueness enforcement per organization
 * - Department and role targeting
 * - Applicable rules lookup for eligibility engine
 *
 * Rule types and required fields:
 * - break_interval: hoursThreshold + breakHours
 * - max_hours_daily: maxHours
 * - max_hours_weekly: maxHours
 *
 * Targeting: rules can apply to all staff (global),
 * a specific department, a specific custom role, or both.
 *
 * All operations are org-scoped and audit-logged.
 */
import { WorkRuleRepository } from "@/repositories/work-rule.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import type { CreateWorkRuleInput, UpdateWorkRuleInput } from "@/lib/validations";
import { SubscriptionService } from "@/services/subscription.service";
import { prisma } from "@/lib/prisma";

export class WorkRuleService {
  private workRuleRepo = new WorkRuleRepository();
  private auditService = new AuditLogService();
  private subscriptionService = new SubscriptionService();

  /**
   * Creates a new work rule with type-specific field validation.
   * Enforces name uniqueness per organization.
   */
  async create(input: CreateWorkRuleInput, orgId: string, userId: string) {
    await this.subscriptionService.enforceResourceLimit(orgId, 'work_rules');

    const nameExists = await this.workRuleRepo.existsByName(orgId, input.name);
    if (nameExists) {
      throw new Error("A work rule with this name already exists");
    }

    this.validateFieldsForType(input.type, input);
    await this.assertTargetsBelongToOrganization(
      input.roleId ?? null,
      (input as Record<string, unknown>).departmentId as string | null ?? null,
      orgId
    );

    const rule = await this.workRuleRepo.create({
      organizationId: orgId,
      name: input.name,
      type: input.type,
      roleId: input.roleId ?? null,
      departmentId: (input as Record<string, unknown>).departmentId as string | null ?? null,
      hoursThreshold: input.hoursThreshold ?? null,
      breakHours: input.breakHours ?? null,
      maxHours: input.maxHours ?? null,
      isActive: input.isActive ?? true,
    });

    await this.auditService.log({
      organizationId: orgId,
      userId,
      action: ACTIONS.WORK_RULE_CREATED,
      entityType: "work_rule",
      entityId: rule.id,
      details: { name: rule.name, type: rule.type },
    });

    return rule;
  }

  /** Lists all work rules for an organization */
  async getByOrganization(orgId: string) {
    return this.workRuleRepo.findByOrganizationId(orgId);
  }

  /** Gets a single work rule by ID */
  async getById(ruleId: string) {
    return this.workRuleRepo.findById(ruleId);
  }

  /**
   * Updates a work rule with type-specific field validation.
   * Enforces name uniqueness if name is being changed.
   */
  async update(
    ruleId: string,
    orgId: string,
    input: UpdateWorkRuleInput,
    userId: string
  ) {
    const existing = await this.workRuleRepo.findById(ruleId);
    if (!existing) throw new Error("Work rule not found");
    if (existing.organizationId !== orgId) throw new Error("Work rule not found");

    if (input.name && input.name !== existing.name) {
      const nameExists = await this.workRuleRepo.existsByName(orgId, input.name, ruleId);
      if (nameExists) {
        throw new Error("A work rule with this name already exists");
      }
    }

    const effectiveType = input.type || existing.type;
    const merged = {
      hoursThreshold: input.hoursThreshold !== undefined ? input.hoursThreshold : existing.hoursThreshold,
      breakHours: input.breakHours !== undefined ? input.breakHours : existing.breakHours,
      maxHours: input.maxHours !== undefined ? input.maxHours : existing.maxHours,
    };
    this.validateFieldsForType(effectiveType, merged);

    const inputAny = input as Record<string, unknown>;
    await this.assertTargetsBelongToOrganization(
      input.roleId === undefined ? existing.roleId : input.roleId ?? null,
      inputAny.departmentId === undefined
        ? existing.departmentId
        : inputAny.departmentId as string | null ?? null,
      orgId
    );

    const updated = await this.workRuleRepo.update(ruleId, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.roleId !== undefined && { roleId: input.roleId ?? null }),
      ...(inputAny.departmentId !== undefined && { departmentId: inputAny.departmentId as string | null ?? null }),
      ...(input.hoursThreshold !== undefined && { hoursThreshold: input.hoursThreshold ?? null }),
      ...(input.breakHours !== undefined && { breakHours: input.breakHours ?? null }),
      ...(input.maxHours !== undefined && { maxHours: input.maxHours ?? null }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    });

    await this.auditService.log({
      organizationId: orgId,
      userId,
      action: ACTIONS.WORK_RULE_UPDATED,
      entityType: "work_rule",
      entityId: ruleId,
      details: input,
    });

    return updated;
  }

  /** Deletes a work rule */
  async delete(ruleId: string, orgId: string, userId: string) {
    const existing = await this.workRuleRepo.findById(ruleId);
    if (!existing) throw new Error("Work rule not found");
    if (existing.organizationId !== orgId) throw new Error("Work rule not found");

    await this.workRuleRepo.delete(ruleId);

    await this.auditService.log({
      organizationId: orgId,
      userId,
      action: ACTIONS.WORK_RULE_DELETED,
      entityType: "work_rule",
      entityId: ruleId,
      details: { name: existing.name },
    });
  }

  /**
   * Gets active rules applicable to a given role context.
   * Used by the eligibility engine during assignment checks.
   */
  async getApplicableRules(orgId: string, roleId?: string | null) {
    return this.workRuleRepo.findApplicableRules(orgId, roleId);
  }

  /**
   * Validates that required fields are present for the given rule type.
   */
  private validateFieldsForType(
    type: string,
    fields: {
      hoursThreshold?: number | null;
      breakHours?: number | null;
      maxHours?: number | null;
    }
  ) {
    switch (type) {
      case "break_interval":
        if (!fields.hoursThreshold || fields.hoursThreshold <= 0) {
          throw new Error("Hours threshold is required for break interval rules");
        }
        if (!fields.breakHours || fields.breakHours <= 0) {
          throw new Error("Break hours is required for break interval rules");
        }
        break;
      case "max_hours_daily":
      case "max_hours_weekly":
        if (!fields.maxHours || fields.maxHours <= 0) {
          throw new Error("Max hours is required for hour limit rules");
        }
        break;
      default:
        throw new Error(`Unknown rule type: ${type}`);
    }
  }

  private async assertTargetsBelongToOrganization(
    roleId: string | null,
    departmentId: string | null,
    organizationId: string
  ) {
    const [role, department] = await Promise.all([
      roleId
        ? prisma.role.findFirst({ where: { id: roleId, organizationId }, select: { id: true } })
        : null,
      departmentId
        ? prisma.department.findFirst({ where: { id: departmentId, organizationId }, select: { id: true } })
        : null,
    ]);
    if (roleId && !role) throw new Error("Role not found");
    if (departmentId && !department) throw new Error("Department not found");
  }
}
