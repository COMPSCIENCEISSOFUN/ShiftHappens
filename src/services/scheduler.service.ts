/**
 * Scheduler Service (Control Layer)
 *
 * Fans the per-organization background jobs out across ALL active tenants so a
 * single external cron hit (/api/cron) keeps the whole platform current:
 *
 *  - Recurring-task generation: materialise upcoming instances for every
 *    recurring series, so future shifts keep appearing without manual clicks.
 *  - Hour-limit alert scan: notify at-risk staff and their managers
 *    (US-72, US-85) as worked/committed hours approach or pass a limit.
 *  - Expiring-certification scan: warn holders before a certificate lapses.
 *    Eligibility drops silently the moment one expires, so without this a
 *    staff member stops being offered qualified work with no explanation.
 *
 * Both underlying jobs are idempotent and cooldown-guarded, so this is safe to
 * run on any cadence. Each organization is processed independently: a failure
 * in one tenant is logged and never aborts the run for the others.
 */
import { prisma } from "@/lib/prisma";
import {
  RecurringTaskService,
  DEFAULT_HORIZON_DAYS,
  type GenerationResult,
} from "@/services/recurring-task.service";
import { HourAlertService } from "@/services/hour-alert.service";
import { CertificationService } from "@/services/certification.service";

export interface RecurringRunSummary {
  orgsProcessed: number;
  totalCreated: number;
  perOrg: Array<{ organizationId: string } & GenerationResult>;
}

export interface HourAlertRunSummary {
  orgsProcessed: number;
  totalAlerted: number;
  perOrg: Array<{ organizationId: string; checked: number; alerted: number }>;
}

export interface CertExpiryRunSummary {
  orgsProcessed: number;
  totalNotified: number;
  perOrg: Array<{ organizationId: string; checked: number; notified: number }>;
}

export interface SchedulerRunSummary {
  recurring: RecurringRunSummary;
  hourAlerts: HourAlertRunSummary;
  certExpiry: CertExpiryRunSummary;
}

export class SchedulerService {
  private recurringTaskService = new RecurringTaskService();
  private hourAlertService = new HourAlertService();
  private certificationService = new CertificationService();

  /** IDs of every active (non-suspended) organization. */
  private async activeOrganizationIds(): Promise<string[]> {
    const orgs = await prisma.organization.findMany({
      where: { status: "active" },
      select: { id: true },
    });
    return orgs.map((o) => o.id);
  }

  /** Bounded fan-out prevents one large tenant list from exhausting DB slots. */
  private async runForOrganizations<T>(
    jobName: string,
    worker: (organizationId: string) => Promise<T>,
    concurrency = 5
  ): Promise<Array<{ organizationId: string; result: T }>> {
    const organizationIds = await this.activeOrganizationIds();
    const results: Array<{ organizationId: string; result: T } | undefined> =
      new Array(organizationIds.length);
    let nextIndex = 0;

    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, organizationIds.length) },
        async () => {
          while (nextIndex < organizationIds.length) {
            const index = nextIndex++;
            const organizationId = organizationIds[index];
            try {
              results[index] = {
                organizationId,
                result: await worker(organizationId),
              };
            } catch (error) {
              console.error(
                `[Scheduler] ${jobName} failed for org ${organizationId}:`,
                error
              );
            }
          }
        }
      )
    );

    return results.filter(
      (item): item is { organizationId: string; result: T } => Boolean(item)
    );
  }

  /**
   * Generates upcoming recurring-task instances for every active org.
   * Runs as the system (no acting user) — generated instances inherit their
   * series' creator, so `userId` is intentionally omitted.
   */
  async runRecurringGeneration(
    horizonDays: number = DEFAULT_HORIZON_DAYS
  ): Promise<RecurringRunSummary> {
    const results = await this.runForOrganizations(
      "recurring generation",
      (organizationId) =>
        this.recurringTaskService.generateForOrganization(
          organizationId,
          horizonDays
        )
    );
    const summary: RecurringRunSummary = {
      orgsProcessed: results.length,
      totalCreated: results.reduce((sum, item) => sum + item.result.created, 0),
      perOrg: results.map(({ organizationId, result }) => ({
        organizationId,
        ...result,
      })),
    };
    return summary;
  }

  /** Runs the hour-limit alert scan for every active org. */
  async runHourAlerts(): Promise<HourAlertRunSummary> {
    const results = await this.runForOrganizations(
      "hour-alert scan",
      (organizationId) => this.hourAlertService.checkOrganization(organizationId)
    );
    const summary: HourAlertRunSummary = {
      orgsProcessed: results.length,
      totalAlerted: results.reduce(
        (sum, item) => sum + item.result.alerted.length,
        0
      ),
      perOrg: results.map(({ organizationId, result }) => ({
        organizationId,
        checked: result.checked,
        alerted: result.alerted.length,
      })),
    };
    return summary;
  }

  /** Warns staff whose certifications are about to expire, for every active org. */
  async runCertificationExpiry(): Promise<CertExpiryRunSummary> {
    const results = await this.runForOrganizations(
      "certification expiry scan",
      (organizationId) => this.certificationService.notifyExpiring(organizationId)
    );
    const summary: CertExpiryRunSummary = {
      orgsProcessed: results.length,
      totalNotified: results.reduce(
        (sum, item) => sum + item.result.notified,
        0
      ),
      perOrg: results.map(({ organizationId, result }) => ({
        organizationId,
        checked: result.checked,
        notified: result.notified,
      })),
    };
    return summary;
  }

  /** Runs all scheduled jobs and returns a combined summary. */
  async runAll(
    horizonDays: number = DEFAULT_HORIZON_DAYS
  ): Promise<SchedulerRunSummary> {
    const [recurring, hourAlerts, certExpiry] = await Promise.all([
      this.runRecurringGeneration(horizonDays),
      this.runHourAlerts(),
      this.runCertificationExpiry(),
    ]);
    return { recurring, hourAlerts, certExpiry };
  }
}
