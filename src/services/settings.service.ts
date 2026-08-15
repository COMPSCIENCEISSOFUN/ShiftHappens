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
 * ## Operating hours are no longer range-checked
 *
 * This service used to reject any update whose merged result had
 * `operatingHoursEnd <= operatingHoursStart`. That rule looked like sensible
 * input validation and was in fact a modelling error: it made a window that
 * runs past midnight inexpressible, so a business trading 20:00–04:00 could
 * not enter its own hours, and every organisation was forced onto a day
 * boundary somewhere in the morning.
 *
 * Any pair of hours is now accepted and `end <= start` means the window wraps.
 * `@/lib/business-day` is the single place that interprets the pair.
 */
import {
  parseWeights,
  weightsProblem,
  WEIGHTS_ERROR_PREFIX,
} from "@/lib/ranking-weights";
import { SettingsRepository } from "@/repositories/settings.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { SubscriptionService } from "@/services/subscription.service";
import {
  effectiveAllocationMode,
  isAllocationModeDowngraded,
  type AllocationMode,
} from "@/lib/allocation-mode";
import { FeatureNotAvailableError } from "@/lib/subscription-tiers";
import type { UpdateCompanySettingsInput } from "@/lib/validations";

export class SettingsService {
  private settingsRepo = new SettingsRepository();
  private auditService = new AuditLogService();
  private subscriptionService = new SubscriptionService();

  /**
   * The allocation mode actually in force — the stored preference, stepped
   * down to what the plan includes.
   *
   * THE read for anything that acts on the mode. The five places that used to
   * read `settings.allocationMode` off the repository directly each had to be
   * trusted to remember the plan; this is the one that remembers it for them.
   * See `@/lib/allocation-mode` for why the column is resolved on read rather
   * than rewritten on downgrade.
   */
  async effectiveAllocationMode(
    organizationId: string
  ): Promise<AllocationMode> {
    const [settings, entitlements] = await Promise.all([
      this.settingsRepo.getOrCreate(organizationId),
      this.subscriptionService.allocationEntitlements(organizationId),
    ]);
    return effectiveAllocationMode(settings.allocationMode, entitlements);
  }

  /** Gets settings for an org, creating defaults if none exist */
  async getSettings(organizationId: string) {
    const [settings, entitlements] = await Promise.all([
      this.settingsRepo.getOrCreate(organizationId),
      this.subscriptionService.allocationEntitlements(organizationId),
    ]);
    /*
     * `smartAllocationWeights` is a JSON STRING in the column, and returning it
     * raw would make every caller parse it — including the settings screen,
     * which would then need its own opinion about a malformed or absent value.
     * `parseWeights` already has that opinion and falls back to the defaults,
     * so the shape a caller receives is always complete.
     */
    return {
      ...settings,
      /*
       * `allocationMode` is the EFFECTIVE mode, not the stored one.
       *
       * Every existing consumer of this field — the tasks board deciding
       * whether to offer Auto-assign, the settings screen, `findCover` —
       * wants to know what will actually happen, and giving them the raw
       * preference is how a Free organisation came to be shown an
       * Auto-assign button the server would refuse.
       *
       * The preference is still returned, under a name that says it is one.
       */
      allocationMode: effectiveAllocationMode(
        settings.allocationMode,
        entitlements
      ),
      /** What the organisation asked for, regardless of plan. */
      requestedAllocationMode: settings.allocationMode,
      /** True when the two differ, so the UI can say why. */
      allocationModeDowngraded: isAllocationModeDowngraded(
        settings.allocationMode,
        entitlements
      ),
      smartAllocationWeights: parseWeights(settings.smartAllocationWeights),
    };
  }

  /**
   * Returns only the fields any member of the organisation may see.
   *
   * The full settings read is company-admin only, and rightly so — it carries
   * allocation strategy, notification policy and smart-allocation weights. But
   * the calendar needs the operating hours to draw its grid, and it is rendered
   * for managers and staff too. Without this they received a 403, the fetch
   * failed silently, and the component fell back to its hard-coded 6–22
   * defaults: an admin who set 08:00–20:00 saw one grid and their staff saw a
   * different one, with no error anywhere to explain it.
   */
  async getDisplaySettings(organizationId: string) {
    const [settings, entitlements] = await Promise.all([
      this.settingsRepo.getOrCreate(organizationId),
      this.subscriptionService.allocationEntitlements(organizationId),
    ]);
    return {
      operatingHoursStart: settings.operatingHoursStart,
      operatingHoursEnd: settings.operatingHoursEnd,
      /*
       * The allocation mode, added for the same reason the operating hours
       * are here: the full settings read is admin-only, and the tasks board is
       * rendered for managers too.
       *
       * Without it that page fell back to a hard-coded "suggested" and drew
       * its Auto-assign and AI Suggest controls against a guess — the same
       * defect the operating hours had, where an admin set 08:00–20:00 and
       * their staff saw a 6–22 grid.
       *
       * The EFFECTIVE mode, so a manager is told what will actually happen
       * rather than what the column says.
       */
      allocationMode: effectiveAllocationMode(
        settings.allocationMode,
        entitlements
      ),
    };
  }

  /**
   * Updates company settings.
   * Ensures settings exist before updating (lazy init).
   * Serializes notification preferences to JSON for storage.
   */
  async updateSettings(
    organizationId: string,
    input: UpdateCompanySettingsInput,
    userId?: string
  ) {
    // Lazy init. The return value was previously bound in order to merge the
    // operating hours before range-checking them; that rule is gone, so this is
    // now purely "make sure the row exists before we update it" — the repository
    // update would otherwise fail for an organisation that has never opened its
    // settings page.
    const existing = await this.settingsRepo.getOrCreate(organizationId);

    // Build update data, serializing nested objects to JSON
    const updateData: {
      allocationMode?: string;
      experiencedShiftThreshold?: number;
      seniorShiftThreshold?: number;
      workingDayHours?: number;
      operatingHoursStart?: number;
      operatingHoursEnd?: number;
      notificationPreferences?: string;
      smartAllocationWeights?: string;
    } = {};

    /*
     * The mode is plan-gated on WRITE as well as resolved on read.
     *
     * The read-side step-down already makes a stored `"auto"` harmless, so
     * this is not what stops the behaviour — it is what stops the SCREEN
     * lying. Without it a Free admin could save "auto", the settings page
     * would reload showing "manual", and nothing would say why. Refusing the
     * write names the plan and the feature.
     *
     * Checked only when the field is being changed. An organisation that
     * downgrades keeps its stored preference and may still edit its operating
     * hours or its notification policy without being made to give it up.
     */
    if (input.allocationMode !== undefined) {
      if (input.allocationMode !== existing.allocationMode) {
        const tier = await this.subscriptionService.getOrganizationTier(
          organizationId
        );
        const entitlements =
          await this.subscriptionService.allocationEntitlements(organizationId);
        if (input.allocationMode === "auto" && !entitlements.auto) {
          throw new FeatureNotAvailableError("auto_allocation", tier);
        }
        if (input.allocationMode === "suggested" && !entitlements.suggestions) {
          throw new FeatureNotAvailableError("smart_suggestions", tier);
        }
      }
      updateData.allocationMode = input.allocationMode;
    }
    if (input.workingDayHours !== undefined) updateData.workingDayHours = input.workingDayHours;
    if (input.operatingHoursStart !== undefined) updateData.operatingHoursStart = input.operatingHoursStart;
    if (input.operatingHoursEnd !== undefined) updateData.operatingHoursEnd = input.operatingHoursEnd;
    if (input.experiencedShiftThreshold !== undefined) {
      updateData.experiencedShiftThreshold = input.experiencedShiftThreshold;
    }
    if (input.seniorShiftThreshold !== undefined) {
      updateData.seniorShiftThreshold = input.seniorShiftThreshold;
    }
    if (input.notificationPreferences !== undefined) {
      updateData.notificationPreferences = JSON.stringify(input.notificationPreferences);
    }

    /*
     * Ranking priorities, checked as a SET rather than per field.
     *
     * The two rules that matter can only be judged on the whole object: all
     * zeroes gives every candidate the same score and makes the order
     * arbitrary, and one dimension above 70% of the total collapses the
     * ranking onto a single factor. Both are states somebody reaches by
     * dragging one slider to the end, and neither is visible from the field
     * being dragged.
     */
    if (input.smartAllocationWeights !== undefined) {
      const problem = weightsProblem(input.smartAllocationWeights);
      if (problem) throw new Error(`${WEIGHTS_ERROR_PREFIX} ${problem}`);
      updateData.smartAllocationWeights = JSON.stringify(
        input.smartAllocationWeights
      );
    }

    // The seniority thresholds are the one pair here with a cross-field rule.
    // Unlike operating hours — where every in-range pair names a real window —
    // an inverted or equal pair makes "senior" either unreachable or the same
    // thing as "experienced", so the scale silently collapses to two levels.
    // Checked against the merged values, not just the submitted ones: raising
    // only the experienced threshold past the senior one is the likely way to
    // get here, and the request would otherwise pass because the second field
    // was never touched.
    const nextExperienced =
      updateData.experiencedShiftThreshold ?? existing.experiencedShiftThreshold;
    const nextSenior = updateData.seniorShiftThreshold ?? existing.seniorShiftThreshold;
    if (nextSenior <= nextExperienced) {
      throw new Error(
        "Senior threshold must be higher than the experienced threshold"
      );
    }

    // No cross-field check on operating hours — see the note at the top of this
    // file. Zod has already bounded each hour individually, and every pair
    // within those bounds names a real window.

    await this.settingsRepo.update(organizationId, updateData);

    await this.auditService.log({
      organizationId,
      userId,
      action: ACTIONS.SETTINGS_UPDATED,
      entityType: "settings",
      details: updateData,
    });

    /*
     * Re-read through `getSettings` rather than returning the repository row.
     *
     * The PATCH route returns this straight to the client, and the GET route
     * returns `getSettings` — so a raw row here meant the two disagreed about
     * what `allocationMode` means. Saving would put the STORED preference on
     * screen and the next reload would replace it with the EFFECTIVE mode,
     * which on a downgraded plan is a different word appearing for no visible
     * reason.
     *
     * It also fixes a smaller inconsistency that predates the plan gate:
     * `smartAllocationWeights` came back as a JSON string from a save and as a
     * parsed object from a read.
     *
     * One extra read on a settings save, which is a rare, human-initiated
     * action — cheap for having one shape of settings in the product.
     */
    return this.getSettings(organizationId);
  }
}