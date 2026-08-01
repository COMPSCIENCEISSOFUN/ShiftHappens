/**
 * Settings Repository (Entity Layer)
 * 
 * Data access layer for company settings.
 * Each organization has one CompanySettings record that controls
 * configurable behaviors: allocation mode,
 * break rules, and notification preferences.
 * 
 * Uses getOrCreate pattern — settings are lazily initialized
 * with defaults when first accessed.
 */
import { prisma } from "@/lib/prisma";

export class SettingsRepository {
  /** Finds settings for an organization, returns null if not yet created */
  async findByOrgId(organizationId: string) {
    return prisma.companySettings.findUnique({
      where: { organizationId },
    });
  }

  /** Creates settings with default values for a new organization */
  async createDefaults(organizationId: string) {
    return prisma.companySettings.create({
      data: { organizationId },
    });
  }

  /**
   * Gets existing settings or creates defaults if none exist.
   * Ensures every org always has accessible settings.
   */
  async getOrCreate(organizationId: string) {
    const existing = await this.findByOrgId(organizationId);
    if (existing) return existing;
    return this.createDefaults(organizationId);
  }

  /** Updates company settings — only provided fields are changed */
  async update(
    organizationId: string,
    data: {
      allocationMode?: string;
      breakRuleHoursWorked?: number;
      breakRuleBreakHours?: number;
      smartAllocationWeights?: string;
      notificationPreferences?: string;
    }
  ) {
    return prisma.companySettings.update({
      where: { organizationId },
      data,
    });
  }
}
