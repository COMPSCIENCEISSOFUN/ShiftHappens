/**
 * Recurring Task Service (Control Layer)
 *
 * Expands recurring task "series" into real task instances.
 *
 * Model: a recurring task IS the first occurrence of its series and holds the
 * pattern. Future occurrences are created as ordinary tasks with
 * `parentTaskId` pointing back at it — so they show up in lists, the calendar,
 * and assignment flows with no special-casing anywhere else.
 *
 * Generation is:
 *  - Rolling: only occurrences within `horizonDays` are materialised, so a
 *    "weekly forever" series never creates a thousand rows.
 *  - Idempotent: an occurrence whose start time already exists for the series
 *    is skipped, so running this repeatedly (cron, task create, manual) is safe.
 *  - Tier-aware: instances count toward the org's `active_tasks` limit, so
 *    generation stops at the cap rather than silently blowing past it.
 */
import { TaskRepository } from "@/repositories/task.repository";
import { SubscriptionService } from "@/services/subscription.service";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { parseRecurrencePattern, occurrencesBetween } from "@/lib/recurrence";

/** How far ahead instances are materialised by default. */
export const DEFAULT_HORIZON_DAYS = 14;

export interface GenerationResult {
  seriesProcessed: number;
  created: number;
  /** Occurrences skipped because an instance already existed. */
  skippedExisting: number;
  /** Occurrences NOT created because the plan's active-task limit was hit. */
  skippedAtLimit: number;
  limitReached: boolean;
}

export class RecurringTaskService {
  private taskRepo = new TaskRepository();
  private auditService = new AuditLogService();
  private subscriptionService = new SubscriptionService();

  /**
   * Materialises instances for every recurring series in an org.
   * Safe to call repeatedly — existing occurrences are never duplicated.
   */
  async generateForOrganization(
    organizationId: string,
    horizonDays: number = DEFAULT_HORIZON_DAYS,
    userId?: string,
    /**
     * The caller's departments, or null/undefined for an unscoped caller.
     *
     * Without it a manager holding `tasks:create` but confined to one
     * department materialised future occurrences for EVERY series in the
     * organisation — and spent the org's active-task headroom doing it. The
     * `tasks` POST beside it has always been scoped; this path was not.
     *
     * The cron job and the create-a-recurring-task path pass nothing, which is
     * correct: neither has a caller whose departments could limit them.
     */
    departmentScope?: string[] | null
  ): Promise<GenerationResult> {
    const templates = await this.taskRepo.findRecurringTemplates(
      organizationId,
      departmentScope
    );

    const result: GenerationResult = {
      seriesProcessed: 0,
      created: 0,
      skippedExisting: 0,
      skippedAtLimit: 0,
      limitReached: false,
    };
    if (templates.length === 0) return result;

    // Remaining headroom under the plan's active-task limit (null = unlimited).
    const check = await this.subscriptionService.checkResourceLimit(
      organizationId,
      "active_tasks"
    );
    let remaining =
      check.limit === null ? Infinity : Math.max(0, check.limit - check.current);

    const now = new Date();
    const horizonEnd = new Date(now);
    horizonEnd.setDate(horizonEnd.getDate() + horizonDays);

    for (const template of templates) {
      const pattern = parseRecurrencePattern(template.recurringPattern);
      if (!pattern || !template.scheduledStart || !template.scheduledEnd) continue;

      result.seriesProcessed++;

      const occurrences = occurrencesBetween(
        pattern,
        template.scheduledStart,
        template.scheduledEnd,
        now,
        horizonEnd
      );
      if (occurrences.length === 0) continue;

      // Everything that already exists for this series: the template's own
      // occurrence plus any instance generated on a previous run.
      const existing = new Set<number>([
        template.scheduledStart.getTime(),
        ...(await this.taskRepo.findInstanceStarts(template.id)).map((d) =>
          d.getTime()
        ),
      ]);

      for (const occ of occurrences) {
        if (existing.has(occ.start.getTime())) {
          result.skippedExisting++;
          continue;
        }

        if (remaining <= 0) {
          result.skippedAtLimit++;
          result.limitReached = true;
          continue;
        }

        await this.taskRepo.create({
          title: template.title,
          description: template.description ?? undefined,
          organizationId,
          departmentId: template.departmentId ?? undefined,
          requiredHeadcount: template.requiredHeadcount,
          // Inherit the certification requirements. Omitting this let the
          // repository default them to [], so every generated occurrence of a
          // safety-critical recurring shift was eligible for everyone —
          // checkCertifications sees an empty list and passes unconditionally.
          requiredCertifications: template.requiredCertifications,
          priority: template.priority,
          scheduledStart: occ.start,
          scheduledEnd: occ.end,
          // Instances are plain tasks — only the template carries the pattern.
          isRecurring: false,
          parentTaskId: template.id,
          createdById: template.createdById,
        });

        existing.add(occ.start.getTime());
        remaining--;
        result.created++;
      }
    }

    if (result.created > 0 || result.limitReached) {
      void this.auditService.log({
        organizationId,
        userId,
        action: ACTIONS.RECURRING_TASKS_GENERATED,
        entityType: "task",
        details: {
          seriesProcessed: result.seriesProcessed,
          created: result.created,
          skippedAtLimit: result.skippedAtLimit,
          horizonDays,
        },
      });
    }

    return result;
  }
}
