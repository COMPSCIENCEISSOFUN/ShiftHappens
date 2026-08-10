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
import { SettingsRepository } from "@/repositories/settings.repository";
import { SubscriptionService } from "@/services/subscription.service";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import {
  NotificationService,
  NOTIFICATION_TYPES,
} from "@/services/notification.service";
import { taskWatcherUserIds } from "@/services/task-watchers";
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
  /**
   * Instances the engine staffed. Always 0 outside "auto" allocation mode,
   * where filling them is not this job's business.
   */
  filled: number;
  /** Instances created in auto mode that nobody eligible could be found for. */
  unfilled: number;
}

export class RecurringTaskService {
  private taskRepo = new TaskRepository();
  private settingsRepo = new SettingsRepository();
  private auditService = new AuditLogService();
  private notificationService = new NotificationService();
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
      filled: 0,
      unfilled: 0,
    };

    /*
     * What was created this run, so auto mode can staff it afterwards.
     *
     * `createdById` is carried per instance rather than taken from the caller
     * because there is no caller — the hourly cron has no user — and the
     * honest answer to "who assigned this" is whoever set the series up.
     */
    const fresh: {
      taskId: string;
      createdById: string;
      departmentId: string | null;
      title: string;
      requiredHeadcount: number;
    }[] = [];
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

        const instance = await this.taskRepo.create({
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
        fresh.push({
          taskId: instance.id,
          createdById: template.createdById,
          departmentId: template.departmentId ?? null,
          title: template.title,
          requiredHeadcount: template.requiredHeadcount,
        });
      }
    }

    await this.staffNewInstances(organizationId, fresh, result);

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
          filled: result.filled,
          unfilled: result.unfilled,
          horizonDays,
        },
      });
    }

    return result;
  }

  /**
   * Staffs the instances this run created, when the organisation is in "auto"
   * allocation mode.
   *
   * ## Why this had to exist
   *
   * Auto mode was wired into `TaskService.create` and nowhere else, and this
   * service creates its instances through the REPOSITORY. So the shifts a
   * human typed in by hand were filled automatically and the shifts the system
   * generated on its own were not — in a rota product, where recurring shifts
   * are most of the week. An organisation that switched auto on got the
   * opposite of what it asked for on the majority of its work.
   *
   * ## Never the AI providers
   *
   * `useAI: false`. This runs from an hourly cron across every tenant, so the
   * organisation does not control how often it happens or how many tasks it
   * covers — one provider call per unfilled shift per hour is a bill nobody
   * agreed to, and a provider outage would become a rostering outage. Same
   * rule, and the same reasoning, as `findCover`.
   *
   * ## One message, not one per shift
   *
   * A fortnight of a daily series is fourteen instances. Fourteen "could not be
   * filled" notifications an hour is not an alert, it is a reason to turn
   * notifications off — so the run reports a count, once, per department, to
   * the people who can actually staff it.
   */
  private async staffNewInstances(
    organizationId: string,
    fresh: {
      taskId: string;
      createdById: string;
      departmentId: string | null;
      title: string;
      requiredHeadcount: number;
    }[],
    result: GenerationResult
  ) {
    if (fresh.length === 0) return;

    try {
      const settings = await this.settingsRepo.getOrCreate(organizationId);
      if (settings.allocationMode !== "auto") return;

      const { AllocationService } = await import(
        "@/services/allocation.service"
      );
      const allocation = new AllocationService();

      /** Unfilled count per department, for one message each. */
      const short = new Map<string | null, number>();

      for (const item of fresh) {
        /** How many people the engine actually placed on this instance. */
        let placed = 0;
        try {
          const assigned = await allocation.autoAllocate(
            item.taskId,
            organizationId,
            item.createdById,
            { useAI: false }
          );
          placed = Array.isArray(assigned) ? assigned.length : 0;
        } catch (error) {
          /*
           * "No eligible staff found" is the ordinary outcome here and not a
           * fault — a fortnight out, availability may simply not be in yet.
           *
           * Logged anyway, and this is not noise. An unbound `catch {}` here
           * reported a dropped connection, a bug in the ranker and a genuinely
           * empty roster as the same sentence — "nobody eligible was
           * available" — which is an affirmative claim about the roster made
           * when nothing had been read. The message below stays deliberately
           * vague about the cause for the same reason.
           */
          console.error(`[Recurring Staffing] ${item.taskId}`, error);
        }

        /*
         * Short is short, whether nobody came or only some did.
         *
         * `placed > 0` would have counted a three-person shift with one
         * volunteer as filled, and `autoAllocate` returns normally in exactly
         * that case — it takes the top N it can find. A run reporting
         * "14 filled" over fourteen third-staffed shifts is the dashboard alert
         * this feature exists to pre-empt, with a reassuring audit entry on top.
         */
        if (placed >= item.requiredHeadcount) {
          result.filled++;
        } else {
          result.unfilled++;
          short.set(item.departmentId, (short.get(item.departmentId) ?? 0) + 1);
        }
      }

      for (const [departmentId, count] of short) {
        /*
         * One department failing must not silence the rest.
         *
         * With the notify inside the outer try only, a deleted department or an
         * unreadable preference on the FIRST entry aborted the loop and left
         * every other department's unstaffed fortnight reported to a log line.
         */
        try {
          const watchers = await taskWatcherUserIds(organizationId, departmentId);
          await this.notificationService.notifyManyIfEnabled(
            organizationId,
            watchers,
            NOTIFICATION_TYPES.BACKFILL_NEEDED,
            "Upcoming shifts need staff",
            `${count} newly scheduled shift${count === 1 ? "" : "s"} could not be staffed automatically. They are on the board and need filling by hand.`,
            "task"
          );
        } catch (error) {
          console.error("[Recurring Staffing] notify failed", error);
        }
      }
    } catch (error) {
      // Generation succeeded; staffing it is a separate job and must not undo
      // it. The instances exist and a manager can fill them by hand.
      console.error("[Recurring Staffing Error]", error);
    }
  }
}
