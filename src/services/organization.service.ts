/**
 * Organization Service (Control Layer)
 *
 * Handles organization creation with unique slug generation,
 * industry template application, detail updates, and retrieval.
 *
 * Template application bypasses subscription tier limits —
 * it's initialization during org creation, not a regular user action.
 * After setup, all further additions are subject to tier limits.
 */
import { OrganizationRepository } from "@/repositories/organization.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import {
  validateCustomTemplate,
  type CustomTemplateData,
} from "@/lib/industry-templates";
import { IndustryTemplateRepository } from "@/repositories/industry-template.repository";
import { prisma } from "@/lib/prisma";
import type { CreateOrganizationInput, UpdateOrganizationInput } from "@/lib/validations";

export class OrganizationService {
  private orgRepo = new OrganizationRepository();
  private auditService = new AuditLogService();
  private templateRepo = new IndustryTemplateRepository();

  /**
   * Creates a new organization:
   * 1. Generate a unique URL-friendly slug from the org name
   * 2. Create the org with the creator as company_admin
   * 3. Apply industry template if selected (bypasses tier limits)
   */
  async create(
    input: CreateOrganizationInput,
    userId: string,
    templateId?: string,
    customTemplate?: CustomTemplateData
  ) {
    const slug = await this.generateUniqueSlug(input.name);

    const org = await this.orgRepo.create(
      {
        name: input.name,
        slug,
        industry: input.industry,
        description: input.description,
      },
      userId
    );

    // Apply template (fire-and-forget pattern — org is created regardless)
    try {
      if (templateId && templateId !== "custom") {
        const template = await this.templateRepo.findById(templateId);
        if (template) {
          await this.orgRepo.update(org.id, { templateId });
          await this.applyDatabaseTemplate(org.id, template);
        }
      } else if (customTemplate && validateCustomTemplate(customTemplate)) {
        await this.applyCustomTemplate(org.id, customTemplate);
      }
    } catch (error) {
      console.error("[Template Application Error]", error);
      // Org is created — user can configure departments and rules manually
    }

    return org;
  }

  /** Retrieves an organization by ID */
  async getOrganization(orgId: string) {
    return this.orgRepo.findById(orgId);
  }

  /**
   * Updates an organization's details.
   * If name changes, slug is auto-regenerated for consistency.
   * Empty strings for optional fields are cleared to null.
   */
  async updateOrganization(
    orgId: string,
    input: UpdateOrganizationInput,
    userId: string
  ) {
    const org = await this.orgRepo.findById(orgId);
    if (!org) throw new Error("Organization not found");

    const updateData: {
      name?: string;
      slug?: string;
      industry?: string | null;
      description?: string | null;
      logo?: string | null;
      address?: string | null;
    } = {};

    // Name change — trim and regenerate slug if actually different
    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (trimmedName.length === 0) {
        throw new Error("Organization name cannot be empty");
      }
      updateData.name = trimmedName;

      if (trimmedName !== org.name) {
        updateData.slug = await this.generateUniqueSlug(trimmedName);
      }
    }

    // Optional fields — empty string clears to null
    if (input.industry !== undefined) {
      updateData.industry = input.industry.trim() || null;
    }

    if (input.description !== undefined) {
      updateData.description = input.description.trim() || null;
    }

    if (input.logo !== undefined) {
      updateData.logo = input.logo || null;
    }

    if (input.address !== undefined) {
      updateData.address = input.address.trim() || null;
    }

    // No fields changed — return current org without DB write
    if (Object.keys(updateData).length === 0) {
      return org;
    }

    const updated = await this.orgRepo.update(orgId, updateData);

    // Audit log (fire-and-forget)
    await this.auditService.log({
      organizationId: orgId,
      userId,
      action: ACTIONS.ORGANIZATION_UPDATED,
      entityType: "organization",
      entityId: orgId,
      details: {
        changes: Object.keys(updateData).filter((k) => k !== "slug"),
        ...(updateData.name && { newName: updateData.name }),
        ...(updateData.slug && { newSlug: updateData.slug }),
      },
    });

    return updated;
  }

  /** Retrieves all organizations a user belongs to */
  async getUserOrganizations(userId: string) {
    return this.orgRepo.findByUserId(userId);
  }

  /**
   * Applies a database-stored industry template to an organization.
   * Creates departments and work rules from the template's JSON fields.
   */
  private async applyDatabaseTemplate(
    orgId: string,
    template: { departments: unknown; workRules: unknown }
  ) {
    const departments = template.departments as {
      name: string;
      description: string;
      color: string;
    }[];
    const workRules = template.workRules as {
      name: string;
      type: string;
      hoursThreshold?: number;
      breakHours?: number;
      maxHours?: number;
    }[];

    for (const dept of departments) {
      await prisma.department.create({
        data: {
          organizationId: orgId,
          name: dept.name,
          description: dept.description,
          color: dept.color,
        },
      });
    }

    for (const rule of workRules) {
      await prisma.workRule.create({
        data: {
          organizationId: orgId,
          name: rule.name,
          type: rule.type,
          hoursThreshold: rule.hoursThreshold ?? null,
          breakHours: rule.breakHours ?? null,
          maxHours: rule.maxHours ?? null,
          isActive: true,
        },
      });
    }
  }

  /**
   * Applies an AI-generated or manually crafted custom template.
   * Validates the data structure before creating resources.
   */
  private async applyCustomTemplate(orgId: string, template: CustomTemplateData) {
    for (const dept of template.departments) {
      await prisma.department.create({
        data: {
          organizationId: orgId,
          name: dept.name,
          description: dept.description || "",
          color: dept.color || "#6B7280",
        },
      });
    }

    for (const rule of template.workRules) {
      await prisma.workRule.create({
        data: {
          organizationId: orgId,
          name: rule.name,
          type: rule.type,
          hoursThreshold: rule.hoursThreshold ?? null,
          breakHours: rule.breakHours ?? null,
          maxHours: rule.maxHours ?? null,
          isActive: true,
        },
      });
    }
  }

  /**
   * Generates a unique URL-friendly slug from an organization name.
   * Example: "Acme Corp" → "acme-corp"
   * If "acme-corp" exists, generates "acme-corp-k7f2m3"
   */
  private async generateUniqueSlug(name: string): Promise<string> {
    const baseSlug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const exists = await this.orgRepo.slugExists(baseSlug);
    if (!exists) return baseSlug;

    const suffix = Math.random().toString(36).substring(2, 8);
    return `${baseSlug}-${suffix}`;
  }
}
