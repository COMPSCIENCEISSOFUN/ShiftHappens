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
import { OrganizationRepository } from "@/repositories/organization.repository";
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
  private orgRepo = new OrganizationRepository();

  /** IDs of every active (non-suspended) organization. */
  private async activeOrganizationIds(): Promise<string[]> {
    return this.orgRepo.findActiveIds();
  }

  /**
   * Generates upcoming recurring-task instances for every active org.
   * Runs as the system (no acting user) — generated instances inherit their
   * series' creator, so `userId` is intentionally omitted.
   */
  async runRecurringGeneration(
    horizonDays: number = DEFAULT_HORIZON_DAYS
  ): Promise<RecurringRunSummary> {
    const orgIds = await this.activeOrganizationIds();
    const summary: RecurringRunSummary = {
      orgsProcessed: 0,
      totalCreated: 0,
      perOrg: [],
    };

    for (const organizationId of orgIds) {
      try {
        const result = await this.recurringTaskService.generateForOrganization(
          organizationId,
          horizonDays
        );
        summary.orgsProcessed++;
        summary.totalCreated += result.created;
        summary.perOrg.push({ organizationId, ...result });
      } catch (error) {
        // One tenant's failure must not stop the rest of the run.
        console.error(
          `[Scheduler] recurring generation failed for org ${organizationId}:`,
          error
        );
      }
    }

    return summary;
  }

  /** Runs the hour-limit alert scan for every active org. */
  async runHourAlerts(): Promise<HourAlertRunSummary> {
    const orgIds = await this.activeOrganizationIds();
    const summary: HourAlertRunSummary = {
      orgsProcessed: 0,
      totalAlerted: 0,
      perOrg: [],
    };

    for (const organizationId of orgIds) {
      try {
        const { checked, alerted } =
          await this.hourAlertService.checkOrganization(organizationId);
        summary.orgsProcessed++;
        summary.totalAlerted += alerted.length;
        summary.perOrg.push({
          organizationId,
          checked,
          alerted: alerted.length,
        });
      } catch (error) {
        console.error(
          `[Scheduler] hour-alert scan failed for org ${organizationId}:`,
          error
        );
      }
    }

    return summary;
  }

  /** Warns staff whose certifications are about to expire, for every active org. */
  async runCertificationExpiry(): Promise<CertExpiryRunSummary> {
    const orgIds = await this.activeOrganizationIds();
    const summary: CertExpiryRunSummary = {
      orgsProcessed: 0,
      totalNotified: 0,
      perOrg: [],
    };

    for (const organizationId of orgIds) {
      try {
        const { checked, notified } =
          await this.certificationService.notifyExpiring(organizationId);
        summary.orgsProcessed++;
        summary.totalNotified += notified;
        summary.perOrg.push({ organizationId, checked, notified });
      } catch (error) {
        console.error(
          `[Scheduler] certification expiry scan failed for org ${organizationId}:`,
          error
        );
      }
    }

    return summary;
  }

  /** Runs all scheduled jobs and returns a combined summary. */
  async runAll(
    horizonDays: number = DEFAULT_HORIZON_DAYS
  ): Promise<SchedulerRunSummary> {
    const recurring = await this.runRecurringGeneration(horizonDays);
    const hourAlerts = await this.runHourAlerts();
    const certExpiry = await this.runCertificationExpiry();
    return { recurring, hourAlerts, certExpiry };
  }
}
