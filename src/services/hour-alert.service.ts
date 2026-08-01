/**
 * Hour Limit Alert Service (Control Layer)
 *
 * Alerts staff and managers when a staff member is approaching — or has
 * exceeded — a working-hour limit (US-72 for managers, US-85 for staff).
 *
 * Limits checked for each member:
 *  1. The company break rule (settings.breakRuleHoursWorked) over the last 24h
 *  2. Any active work rule targeting them:
 *     - break_interval    → hours in last 24h vs hoursThreshold
 *     - max_hours_daily   → hours worked today vs maxHours
 *     - max_hours_weekly  → hours worked this week vs maxHours
 *
 * Severity: >= 100% of a limit is "exceeded", >= 80% is "approaching".
 *
 * Triggered automatically on clock-out (that's when worked hours change), and
 * available as an org-wide scan via the hour-alerts API so it can be run on a
 * schedule. Repeat alerts are suppressed for ALERT_COOLDOWN_HOURS so a staff
 * member clocking out repeatedly doesn't spam everyone.
 *
 * Honours the org's `hourLimitWarning` notification preference.
 */
import { EligibilityService } from "@/services/eligibility.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { SettingsRepository } from "@/repositories/settings.repository";
import { WorkRuleRepository } from "@/repositories/work-rule.repository";
import { MembershipRepository } from "@/repositories/membership.repository";

/** A member is "approaching" a limit at this fraction of it. */
export const APPROACHING_THRESHOLD = 0.8;

/** Don't re-send the same alert about a member within this window. */
export const ALERT_COOLDOWN_HOURS = 12;

export type AlertSeverity = "ok" | "approaching" | "exceeded";

export interface LimitStatus {
  label: string;
  used: number;
  limit: number;
  ratio: number;
  severity: AlertSeverity;
}

export interface MemberHourStatus {
  membershipId: string;
  userId: string;
  memberName: string;
  /** Worst severity across all of the member's limits. */
  severity: AlertSeverity;
  limits: LimitStatus[];
}

function severityFor(ratio: number): AlertSeverity {
  if (ratio >= 1) return "exceeded";
  if (ratio >= APPROACHING_THRESHOLD) return "approaching";
  return "ok";
}

/** Ranks severities so we can pick the worst one. */
const SEVERITY_RANK: Record<AlertSeverity, number> = {
  ok: 0,
  approaching: 1,
  exceeded: 2,
};

export class HourAlertService {
  private eligibilityService = new EligibilityService();
  private notificationService = new NotificationService();
  private settingsRepo = new SettingsRepository();
  private workRuleRepo = new WorkRuleRepository();
  private membershipRepo = new MembershipRepository();

  /**
   * Computes hour-limit status for a single member.
   * Returns null if the membership doesn't exist.
   */
  async getMemberStatus(
    membershipId: string,
    organizationId: string
  ): Promise<MemberHourStatus | null> {
    const member = await this.membershipRepo.findByIdWithDetails(membershipId);
    if (!member) return null;

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    const allRules = await this.workRuleRepo.findApplicableRules(organizationId);

    const memberDeptIds = (member.departmentMemberships || []).map(
      (dm) => dm.department.id
    );
    const rules = this.eligibilityService.filterApplicableRules(
      allRules,
      memberDeptIds,
      member.customRoleId ?? null
    );

    const now = new Date();
    const limits: LimitStatus[] = [];

    // Hours are only fetched for the windows we actually need.
    //
    // The `??=` memo already avoids re-computing a window; the shared cache
    // avoids re-QUERYING for it. All three windows are derived from the same
    // per-member assignment list, so without it a member subject to a break
    // rule, a daily cap and a weekly cap costs three identical queries. Scoped
    // to this member's check and discarded with it.
    const hoursCache = new Map();
    let hours24h: number | null = null;
    let hoursToday: number | null = null;
    let hoursWeek: number | null = null;
    const last24h = async () =>
      (hours24h ??= await this.eligibilityService.getHoursInLast24h(
        membershipId,
        undefined,
        hoursCache
      ));
    // The organisation's day boundary is passed through so the figure shown on
    // the dashboard is measured the same way as the one the eligibility engine
    // blocks on. Without it, a member could be told they had worked 4h today
    // while being refused a shift for having worked 11h that day — the same
    // question answered against two different days.
    const today = async () =>
      (hoursToday ??= await this.eligibilityService.getHoursOnDate(
        membershipId,
        now,
        undefined,
        hoursCache,
        settings.operatingHoursStart
      ));
    const week = async () =>
      (hoursWeek ??= await this.eligibilityService.getHoursInWeek(
        membershipId,
        now,
        undefined,
        hoursCache,
        settings.operatingHoursStart
      ));

    // 1. Company-wide break rule
    if (settings.breakRuleHoursWorked > 0) {
      const used = await last24h();
      const limit = settings.breakRuleHoursWorked;
      const ratio = used / limit;
      limits.push({
        label: `Break rule (${limit}h in 24h)`,
        used,
        limit,
        ratio,
        severity: severityFor(ratio),
      });
    }

    // 2. Work rules targeting this member
    for (const rule of rules) {
      let used: number | null = null;
      let limit: number | null = null;
      let label = rule.name;

      if (rule.type === "break_interval" && rule.hoursThreshold) {
        used = await last24h();
        limit = rule.hoursThreshold;
        label = `${rule.name} (${limit}h before break)`;
      } else if (rule.type === "max_hours_daily" && rule.maxHours) {
        used = await today();
        limit = rule.maxHours;
        label = `${rule.name} (${limit}h/day)`;
      } else if (rule.type === "max_hours_weekly" && rule.maxHours) {
        used = await week();
        limit = rule.maxHours;
        label = `${rule.name} (${limit}h/week)`;
      }

      if (used === null || limit === null || limit <= 0) continue;

      const ratio = used / limit;
      limits.push({ label, used, limit, ratio, severity: severityFor(ratio) });
    }

    const severity = limits.reduce<AlertSeverity>(
      (worst, l) =>
        SEVERITY_RANK[l.severity] > SEVERITY_RANK[worst] ? l.severity : worst,
      "ok"
    );

    return {
      membershipId,
      userId: member.userId,
      memberName: member.user.name || member.user.email,
      severity,
      limits,
    };
  }

  /**
   * Hour-limit status for every active, non-admin member of an org.
   *
   * `departmentIds` null/undefined = unrestricted (company admin); an array
   * limits the result to members of those departments, matching
   * `TaskService.getByOrganization`. An empty array therefore returns nothing —
   * a manager who belongs to no department supervises nobody. Without this a
   * manager scoped to one department could read every staff member's worked
   * hours in the organisation.
   */
  async getOrganizationStatus(
    organizationId: string,
    departmentIds?: string[] | null
  ): Promise<MemberHourStatus[]> {
    const members = await this.membershipRepo.findByOrgId(organizationId);
    const scope = departmentIds != null ? new Set(departmentIds) : null;
    const staff = members.filter(
      (m) =>
        m.status === "active" &&
        m.role !== "company_admin" &&
        (scope === null ||
          (m.departmentMemberships ?? []).some((dm) =>
            scope.has(dm.department.id)
          ))
    );

    const statuses: MemberHourStatus[] = [];
    for (const m of staff) {
      const status = await this.getMemberStatus(m.id, organizationId);
      if (status) statuses.push(status);
    }
    return statuses;
  }

  /**
   * Checks one member and sends alerts if they're approaching or over a limit.
   * Fire-and-forget safe — never throws. Returns the status (or null).
   */
  async checkAndAlertMember(
    membershipId: string,
    organizationId: string
  ): Promise<MemberHourStatus | null> {
    try {
      const status = await this.getMemberStatus(membershipId, organizationId);
      if (!status || status.severity === "ok") return status;

      await this.sendAlerts(organizationId, status);
      return status;
    } catch (error) {
      console.error("[HourAlert Error]", error);
      return null;
    }
  }

  /**
   * Scans a whole org and alerts on every at-risk member.
   * Intended for a scheduled run (cron) or a manual manager-triggered check.
   *
   * `departmentIds` carries the caller's department scope through to the scan
   * so a manager triggering it by hand cannot fan notifications out across
   * departments they do not supervise. The scheduled run passes nothing and
   * stays org-wide.
   */
  async checkOrganization(
    organizationId: string,
    departmentIds?: string[] | null
  ): Promise<{ checked: number; alerted: MemberHourStatus[] }> {
    const statuses = await this.getOrganizationStatus(
      organizationId,
      departmentIds
    );
    const atRisk = statuses.filter((s) => s.severity !== "ok");

    for (const status of atRisk) {
      await this.sendAlerts(organizationId, status);
    }

    return { checked: statuses.length, alerted: atRisk };
  }

  /**
   * Notifies the staff member and the org's managers/admins about a
   * breached or nearly-breached limit. Suppresses repeats within the cooldown.
   */
  private async sendAlerts(
    organizationId: string,
    status: MemberHourStatus
  ): Promise<void> {
    // Report on the most severe limit.
    const worst = [...status.limits]
      .filter((l) => l.severity !== "ok")
      .sort((a, b) => b.ratio - a.ratio)[0];
    if (!worst) return;

    const exceeded = status.severity === "exceeded";
    const pct = Math.round(worst.ratio * 100);
    const detail = `${worst.used.toFixed(1)}h of ${worst.limit}h — ${worst.label}`;

    const since = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000);

    // ── Staff member (US-85) ──
    const alreadyToldStaff = await this.notificationService.wasNotifiedSince(
      status.userId,
      organizationId,
      NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
      since,
      status.membershipId
    );
    if (!alreadyToldStaff) {
      await this.notificationService.notifyIfEnabled(
        organizationId,
        status.userId,
        NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
        exceeded ? "You've exceeded an hour limit" : "You're approaching an hour limit",
        exceeded
          ? `You've worked ${detail}. Your manager has been notified.`
          : `You've worked ${detail} (${pct}%).`,
        "membership",
        status.membershipId
      );
    }

    // ── Managers and admins (US-72) ──
    const members = await this.membershipRepo.findByOrgId(organizationId);
    const managers = members.filter(
      (m) =>
        m.status === "active" &&
        ["company_admin", "manager"].includes(m.role) &&
        m.userId !== status.userId
    );

    const toNotify: string[] = [];
    for (const manager of managers) {
      const already = await this.notificationService.wasNotifiedSince(
        manager.userId,
        organizationId,
        NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
        since,
        status.membershipId
      );
      if (!already) toNotify.push(manager.userId);
    }

    await this.notificationService.notifyManyIfEnabled(
      organizationId,
      toNotify,
      NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
      exceeded ? "Staff exceeded hour limit" : "Staff approaching hour limit",
      `${status.memberName} has worked ${detail} (${pct}%).`,
      "membership",
      status.membershipId
    );
  }
}
