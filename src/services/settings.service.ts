/**
 * Settings Service (Control Layer)
 *
 * Business logic for company settings management.
 * Uses lazy initialization — settings are created with defaults
 * on first access, so no explicit setup step is needed.
 *
 * Notification preferences are stored as JSON string in the database
 * but accepted as objects in the API for ease of use.
 *
 * Operating hours are validated in merged state — even partial
 * updates are checked against existing values to ensure end > start.
 */
import { SettingsRepository } from "@/repositories/settings.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import type { UpdateCompanySettingsInput } from "@/lib/validations";

export class SettingsService {
  private settingsRepo = new SettingsRepository();
  private auditService = new AuditLogService();

  /** Gets settings for an org, creating defaults if none exist */
  async getSettings(organizationId: string) {
    return this.settingsRepo.getOrCreate(organizationId);
  }

  /**
   * Updates company settings.
   * Ensures settings exist before updating (lazy init).
   * Validates operating hours in merged state (partial updates
   * are checked against existing values so end > start always holds).
   * Serializes notification preferences to JSON for storage.
   */
  async updateSettings(
    organizationId: string,
    input: UpdateCompanySettingsInput,
    userId?: string
  ) {
    // Ensure settings exist and get current values for merge validation
    const existing = await this.settingsRepo.getOrCreate(organizationId);

    // Build update data, serializing nested objects to JSON
    const updateData: {
      allocationMode?: string;
      breakRuleHoursWorked?: number;
      breakRuleBreakHours?: number;
      operatingHoursStart?: number;
      operatingHoursEnd?: number;
      notificationPreferences?: string;
    } = {};

    if (input.allocationMode !== undefined) updateData.allocationMode = input.allocationMode;
    if (input.breakRuleHoursWorked !== undefined) updateData.breakRuleHoursWorked = input.breakRuleHoursWorked;
    if (input.breakRuleBreakHours !== undefined) updateData.breakRuleBreakHours = input.breakRuleBreakHours;
    if (input.operatingHoursStart !== undefined) updateData.operatingHoursStart = input.operatingHoursStart;
    if (input.operatingHoursEnd !== undefined) updateData.operatingHoursEnd = input.operatingHoursEnd;
    if (input.notificationPreferences !== undefined) {
      updateData.notificationPreferences = JSON.stringify(input.notificationPreferences);
    }

    // Validate operating hours in merged state
    const effectiveStart = updateData.operatingHoursStart ?? existing.operatingHoursStart;
    const effectiveEnd = updateData.operatingHoursEnd ?? existing.operatingHoursEnd;

    if (effectiveEnd <= effectiveStart) {
      throw new Error("Operating hours end must be after start");
    }

    const settings = await this.settingsRepo.update(organizationId, updateData);

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.SETTINGS_UPDATED,
      entityType: "settings",
      details: updateData,
    });

    return settings;
  }
}
