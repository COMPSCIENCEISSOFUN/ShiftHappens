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
import { AvailabilityService } from "@/services/availability.service";
import { HourAlertService } from "@/services/hour-alert.service";
import { CertificationService } from "@/services/certification.service";
import { AllocationService } from "@/services/allocation.service";

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

export interface AutoStaffingRunSummary {
  orgsProcessed: number;
  totalFilled: number;
  perOrg: { organizationId: string; considered: number; filled: number }[];
}

export interface LeaveSweepRunSummary {
  orgsProcessed: number;
  totalReminded: number;
  totalEscalated: number;
  totalLapseNotified: number;
  perOrg: {
    organizationId: string;
    reminded: number;
    escalated: number;
    lapseNotified: number;
  }[];
}

export interface SchedulerRunSummary {
  recurring: RecurringRunSummary;
  hourAlerts: HourAlertRunSummary;
  certExpiry: CertExpiryRunSummary;
  autoStaffing: AutoStaffingRunSummary;
  leaveSweep: LeaveSweepRunSummary;
}

export class SchedulerService {
  private recurringTaskService = new RecurringTaskService();
  private hourAlertService = new HourAlertService();
  private certificationService = new CertificationService();
  private allocationService = new AllocationService();
  private availabilityService = new AvailabilityService();
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

  /**
   * Chases leave requests running out of time, and tells members about any
   * that ran out.
   *
   * Per organisation and inside its own try, like every other job here: one
   * tenant's failure must not stop the sweep for the rest, which is the whole
   * reason these loops are written this way rather than with `Promise.all`.
   *
   * Idempotent by the marks it writes, not by a cooldown. Running the cron
   * twice in a minute sends nothing twice, because a chased row carries
   * `remindedAt` and drops out of the query.
   */
  async runLeaveSweep(
    horizonDays: number = DEFAULT_HORIZON_DAYS
  ): Promise<LeaveSweepRunSummary> {
    const orgIds = await this.activeOrganizationIds();
    const summary: LeaveSweepRunSummary = {
      orgsProcessed: 0,
      totalReminded: 0,
      totalEscalated: 0,
      totalLapseNotified: 0,
      perOrg: [],
    };

    for (const organizationId of orgIds) {
      try {
        const result = await this.availabilityService.sweepPendingLeave(
          organizationId,
          new Date(),
          horizonDays
        );
        summary.orgsProcessed++;
        summary.totalReminded += result.reminded;
        summary.totalEscalated += result.escalated;
        summary.totalLapseNotified += result.lapseNotified;
        summary.perOrg.push({ organizationId, ...result });
      } catch (error) {
        console.error(
          `[Scheduler] leave sweep failed for org ${organizationId}:`,
          error
        );
      }
    }

    return summary;
  }

  /**
   * Second attempt at shifts auto mode could not staff when they were made.
   *
   * Only organisations in `auto` mode do anything here — the service checks,
   * and for everyone else this is one settings read per run.
   *
   * Ordered AFTER recurring generation on purpose: that pass creates the next
   * fortnight and staffs what it can, so running the sweep first would look at
   * a board missing the very shifts most likely to need it, and the newly
   * created ones would then wait a whole hour for their second chance.
   */
  async runAutoStaffing(
    horizonDays: number = DEFAULT_HORIZON_DAYS
  ): Promise<AutoStaffingRunSummary> {
    const orgIds = await this.activeOrganizationIds();
    const summary: AutoStaffingRunSummary = {
      orgsProcessed: 0,
      totalFilled: 0,
      perOrg: [],
    };

    for (const organizationId of orgIds) {
      try {
        const { considered, filled } =
          await this.allocationService.staffUnfilled(organizationId, horizonDays);
        summary.orgsProcessed++;
        summary.totalFilled += filled;
        summary.perOrg.push({ organizationId, considered, filled });
      } catch (error) {
        // One tenant's failure must not stop the rest — the same isolation
        // every job in this file has.
        console.error(
          `[Scheduler] auto staffing failed for org ${organizationId}:`,
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
    const autoStaffing = await this.runAutoStaffing(horizonDays);
    const leaveSweep = await this.runLeaveSweep(horizonDays);
    return { recurring, hourAlerts, certExpiry, autoStaffing, leaveSweep };
  }
}
