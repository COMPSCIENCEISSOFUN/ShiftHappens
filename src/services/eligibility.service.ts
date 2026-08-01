/**
 * Eligibility Service (Control Layer)
 *
 * The core eligibility engine. Checks four dimensions to determine
 * if a staff member is eligible for a task assignment:
 *
 * 1. HOURS LIMIT — Has the member exceeded the company break rule threshold?
 * 2. AVAILABILITY — Is the member available at the task's scheduled time?
 *    - Casual staff: weekly availability is a HARD CONSTRAINT
 *    - Full-time staff: SKIP — always available during operating hours
 * 3. SCHEDULING — Does the member have conflicting assignments?
 * 4. WORK RULES — Does the assignment violate any custom work rules?
 *    Rules can target globally, by department, or by custom role.
 *    Checks task duration against daily/weekly limits.
 *
 * Each dimension returns eligible/ineligible with a reason.
 * Eligibility overrides can bypass specific rules with documentation.
 */
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { CertificationRepository } from "@/repositories/certification.repository";
import { EligibilityOverrideRepository } from "@/repositories/eligibility-override.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { MembershipRepository } from "@/repositories/membership.repository";
import { WorkRuleRepository } from "@/repositories/work-rule.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { DEFAULT_EMPLOYMENT_TYPE } from "@/lib/role-config";
import { localDateInTimeZone, timeOfDayInTimeZone } from "@/lib/timezone";
import {
  DEFAULT_DAY_START_HOUR,
  businessDayRange,
  businessWeekRange,
  overlapHours,
} from "@/lib/business-day";

interface EligibilityCheck {
  eligible: boolean;
  reason?: string;
}

interface StaffEligibility {
  membershipId: string;
  memberName: string;
  employmentType: string;
  eligible: boolean;
  checks: {
    hoursLimit: EligibilityCheck;
    availability: EligibilityCheck;
    scheduling: EligibilityCheck;
    workRules: EligibilityCheck;
    certifications: EligibilityCheck;
  };
  overrides: string[];
}

/**
 * Per-evaluation memo of committed assignments, keyed by
 * `membershipId|excludeTaskId`. Created by the caller and passed down, so its
 * lifetime is one eligibility run — see `loadCommittedAssignments`.
 */
type CommittedAssignmentsCache = Map<
  string,
  ReturnType<TaskAssignmentRepository["findCommittedWithSchedule"]>
>;

export class EligibilityService {
  private availRepo = new AvailabilityRepository();
  private certRepo = new CertificationRepository();
  private overrideRepo = new EligibilityOverrideRepository();
  private settingsRepo = new SettingsRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private taskRepo = new TaskRepository();
  private membershipRepo = new MembershipRepository();
  private workRuleRepo = new WorkRuleRepository();
  private auditService = new AuditLogService();

  /**
   * Maps each dimension of the eligibility check to the `ruleOverridden`
   * key stored on an EligibilityOverride. A single "all" override waives
   * every warning for a member on a task (used by the assignment flow).
   */
  private readonly OVERRIDE_KEYS = {
    hoursLimit: "hours_limit",
    availability: "availability",
    scheduling: "scheduling",
    workRules: "work_rules",
    certifications: "certification",
  } as const;

  /**
   * Checks eligibility for all active staff in an organization
   * against a specific task. Returns a list of staff with
   * their eligibility status and reasons.
   */
  async checkEligibilityForTask(
    taskId: string,
    organizationId: string
  ): Promise<StaffEligibility[]> {
    const task = await this.taskRepo.findByIdWithoutRelations(taskId);
    // Cross-tenant tasks are invisible — never evaluate another org's task.
    if (!task || task.organizationId !== organizationId) throw new Error("Task not found");

    const settings = await this.settingsRepo.getOrCreate(organizationId);

    // Get all active work rules for this org
    const allWorkRules = await this.workRuleRepo.findApplicableRules(organizationId);

    // Get all active non-admin members. When the task belongs to a department,
    // only staff in that department are candidates (PRD §7.4 department scope);
    // department-less tasks consider everyone.
    const allMembers = await this.membershipRepo.findByOrgId(organizationId);
    let eligibleMembers = allMembers.filter(
      (m) => m.status === "active" && m.role !== "company_admin"
    );
    if (task.departmentId) {
      eligibleMembers = eligibleMembers.filter((m) =>
        (m.departmentMemberships ?? []).some(
          (dm: { department: { id: string } }) => dm.department.id === task.departmentId
        )
      );
    }

    // Load all overrides for this task once, grouped by member.
    const overridesByMember = await this.getOverrideMap(taskId);

    // One memo for the whole evaluation. Every member is checked against the
    // break rule, the daily cap and the weekly cap, and all three read the same
    // per-member assignment list — without this they issue that query three
    // times each. Scoped to this call, so it cannot go stale between requests.
    const hoursCache: CommittedAssignmentsCache = new Map();

    const results: StaffEligibility[] = [];

    for (const member of eligibleMembers) {
      // TODO: Remove cast after running `npx prisma generate` — employmentType
      // is on the Membership model; Prisma types will include it natively.
      const memberEmploymentType =
        (member as typeof member & { employmentType?: string | null }).employmentType || DEFAULT_EMPLOYMENT_TYPE;

      const memberOverrides = overridesByMember.get(member.id) ?? new Set<string>();
      // A member is waived on a dimension by a matching key or a blanket "all".
      const isOverridden = (key: string) =>
        memberOverrides.has("all") || memberOverrides.has(key);

      // Applies an override to a failing check — keeps the original reason
      // visible so the manager knows what was waived.
      const applyOverride = (
        key: string,
        check: EligibilityCheck
      ): EligibilityCheck =>
        !check.eligible && isOverridden(key)
          ? { eligible: true, reason: `Overridden — was: ${check.reason}` }
          : check;

      // 1. Hours limit
      const hoursCheck = applyOverride(
        this.OVERRIDE_KEYS.hoursLimit,
        await this.checkHoursLimit(member.id, settings.breakRuleHoursWorked, task.id, hoursCache)
      );

      // 2. Availability
      //    Casual: weekly availability is a hard constraint — fail if not available
      //    Full-time: always available during operating hours — skip check
      let availCheck: EligibilityCheck = { eligible: true };
      if (
        memberEmploymentType === "casual" &&
        task.scheduledStart &&
        task.scheduledEnd
      ) {
        // Availability windows are stored as local wall-clock strings ("09:00"),
        // so the task must be expressed the same way. getHours() returns the
        // SERVER's hour: on Vercel a 09:00 shift reads as 01:00 and falls
        // outside every daytime window, marking all casual staff unavailable.
        const startTime = timeOfDayInTimeZone(task.scheduledStart);
        const endTime = timeOfDayInTimeZone(task.scheduledEnd);

        const availResult = await this.availRepo.isAvailableAt(
          member.id,
          task.scheduledStart,
          startTime,
          endTime
        );
        availCheck = applyOverride(this.OVERRIDE_KEYS.availability, {
          eligible: availResult.available,
          reason: availResult.reason,
        });
      }

      // 3. Scheduling conflicts
      const schedulingCheck = applyOverride(
        this.OVERRIDE_KEYS.scheduling,
        await this.checkSchedulingConflicts(member.id, task)
      );

      // 4. Work rules — filtered by member's departments and custom role
      const memberDeptIds = (member.departmentMemberships || []).map(
        (dm: { department: { id: string } }) => dm.department.id
      );
      const memberCustomRoleId = (member as Record<string, unknown>).customRoleId as string | null;

      const workRulesCheck = applyOverride(
        this.OVERRIDE_KEYS.workRules,
        await this.checkWorkRules(
          member.id,
          allWorkRules,
          task,
          memberDeptIds,
          memberCustomRoleId || null,
          hoursCache,
          settings.operatingHoursStart
        )
      );

      // 5. Certifications — member must hold every cert the task requires
      //    (verified + non-expired). No requirement → always passes.
      const certCheck = applyOverride(
        this.OVERRIDE_KEYS.certifications,
        await this.checkCertifications(
          member.id,
          (task as { requiredCertifications?: string[] }).requiredCertifications ?? []
        )
      );

      const eligible =
        hoursCheck.eligible &&
        availCheck.eligible &&
        schedulingCheck.eligible &&
        workRulesCheck.eligible &&
        certCheck.eligible;

      results.push({
        membershipId: member.id,
        memberName: (member as { user: { name: string | null; email: string } }).user.name ||
          (member as { user: { name: string | null; email: string } }).user.email,
        employmentType: memberEmploymentType,
        eligible,
        checks: {
          hoursLimit: hoursCheck,
          availability: availCheck,
          scheduling: schedulingCheck,
          workRules: workRulesCheck,
          certifications: certCheck,
        },
        overrides: Array.from(memberOverrides),
      });
    }

    return results;
  }

  /** Builds a map of membershipId → set of overridden rule keys for a task. */
  private async getOverrideMap(taskId: string): Promise<Map<string, Set<string>>> {
    const overrides = await this.overrideRepo.findByTaskId(taskId);
    const map = new Map<string, Set<string>>();
    for (const o of overrides) {
      const set = map.get(o.membershipId) ?? new Set<string>();
      set.add(o.ruleOverridden);
      map.set(o.membershipId, set);
    }
    return map;
  }

  /**
   * Checks a member against the company break rule (hours in a rolling 24h).
   * Counts actual clocked time plus any committed shift that started within
   * the window. `excludeTaskId` drops the task being evaluated so it isn't
   * counted against itself.
   */
  async checkHoursLimit(
    membershipId: string,
    maxHours: number,
    excludeTaskId?: string,
    cache?: CommittedAssignmentsCache
  ): Promise<EligibilityCheck> {
    const totalHours = await this.getHoursInLast24h(membershipId, excludeTaskId, cache);

    if (totalHours >= maxHours) {
      return {
        eligible: false,
        reason: `${totalHours.toFixed(1)}h in last 24h (limit: ${maxHours}h)`,
      };
    }

    return {
      eligible: true,
      reason: `${totalHours.toFixed(1)}h of ${maxHours}h limit`,
    };
  }

  /**
   * Checks whether a member holds every certification a task requires.
   * Only verified, non-expired certifications count (delegated to the repo).
   * Matching is case-insensitive and trims surrounding whitespace so
   * "  food safety " matches a stored "Food Safety".
   */
  async checkCertifications(
    membershipId: string,
    required: string[]
  ): Promise<EligibilityCheck> {
    if (!required || required.length === 0) {
      return { eligible: true };
    }

    const validCerts = await this.certRepo.getValidCertifications(membershipId);
    const held = new Set(validCerts.map((c) => c.name.trim().toLowerCase()));

    const missing = required.filter(
      (name) => !held.has(name.trim().toLowerCase())
    );

    if (missing.length > 0) {
      return {
        eligible: false,
        reason: `Missing required certification(s): ${missing
          .map((m) => m.trim())
          .join(", ")}`,
      };
    }

    return { eligible: true, reason: "Has all required certifications" };
  }

  /**
   * Checks for scheduling conflicts with existing assignments.
   */
  private async checkSchedulingConflicts(
    membershipId: string,
    task: { id: string; scheduledStart: Date | null; scheduledEnd: Date | null }
  ): Promise<EligibilityCheck> {
    if (!task.scheduledStart || !task.scheduledEnd) {
      return { eligible: true, reason: "No schedule set" };
    }

    // A pending withdrawal still occupies the schedule until resolved.
    const conflicts = await this.taskRepo.findConflictingTaskTitles(
      membershipId,
      task.scheduledStart,
      task.scheduledEnd,
      task.id
    );

    if (conflicts.length > 0) {
      return {
        eligible: false,
        reason: `Conflicts with: ${conflicts.map((c) => c.title).join(", ")}`,
      };
    }

    return { eligible: true };
  }

  /**
   * Checks applicable work rules against a staff member.
   * Rules are filtered by targeting:
   * - Global rules (no roleId, no departmentId) → apply to all
   * - Department rules → apply if member is in that department
   * - Role rules → apply if member has that custom role
   * - Both set → apply if member matches both
   *
   * The part of the task falling inside the window is added to already-worked
   * hours before comparing against daily/weekly limits — both halves of that
   * sum are clipped to the same business day or week, so they are measured the
   * same way.
   *
   * Returns ineligible with the first violated rule's name and reason.
   */
  private async checkWorkRules(
    membershipId: string,
    rules: Awaited<ReturnType<WorkRuleRepository["findApplicableRules"]>>,
    task: { id: string; scheduledStart: Date | null; scheduledEnd: Date | null },
    memberDepartmentIds: string[],
    memberCustomRoleId: string | null,
    cache?: CommittedAssignmentsCache,
    dayStartHour: number = DEFAULT_DAY_START_HOUR
  ): Promise<EligibilityCheck> {
    if (rules.length === 0) {
      return { eligible: true };
    }

    const applicableRules = this.filterApplicableRules(
      rules,
      memberDepartmentIds,
      memberCustomRoleId
    );

    for (const rule of applicableRules) {
      let violated = false;
      let reason = "";

      switch (rule.type) {
        case "break_interval": {
          if (!rule.hoursThreshold) break;
          const hours = await this.getHoursInLast24h(membershipId, task.id, cache);
          if (hours >= rule.hoursThreshold) {
            violated = true;
            reason = `${hours.toFixed(1)}h in last 24h (rule "${rule.name}": max ${rule.hoursThreshold}h before break)`;
          }
          break;
        }

        /*
         * Both cap rules below check EVERY window the task touches, and clip
         * the task to each one. The previous implementation did neither, and
         * the two omissions cancelled each other out badly enough to look
         * plausible:
         *
         *   - It added the task's WHOLE duration to a total that was already
         *     clipped to the day — two conventions in one sum. A 22:00–06:00
         *     shift charged all eight hours to the day it began, and a
         *     three-day task charged all 72 against a DAILY cap.
         *   - It checked only the window containing the task's START. The
         *     hours spilling into the next day were therefore never tested
         *     against that day's cap at all: a shift could be refused for
         *     hours it would work tomorrow, while genuinely overloading
         *     tomorrow went unnoticed.
         *
         * Iterating costs nothing extra in queries — every call shares the
         * per-evaluation assignment cache, so only the arithmetic repeats.
         */
        case "max_hours_daily": {
          if (!rule.maxHours || !task.scheduledStart || !task.scheduledEnd) break;

          for (const window of this.windowsSpanned(
            task.scheduledStart,
            task.scheduledEnd,
            (d) => businessDayRange(d, dayStartHour)
          )) {
            const taskHours = overlapHours(
              task.scheduledStart,
              task.scheduledEnd,
              window.start,
              window.end
            );
            if (taskHours <= 0) continue;

            // Hours already committed that day (clocked + scheduled), excluding
            // this task so it isn't counted against itself.
            const committed = await this.getHoursOnDate(
              membershipId,
              window.start,
              task.id,
              cache,
              dayStartHour
            );
            if (committed + taskHours > rule.maxHours) {
              violated = true;
              reason = `Would total ${(committed + taskHours).toFixed(1)}h on ${localDateInTimeZone(window.start)} (rule "${rule.name}": max ${rule.maxHours}h/day)`;
              break;
            }
          }
          break;
        }

        case "max_hours_weekly": {
          if (!rule.maxHours || !task.scheduledStart || !task.scheduledEnd) break;

          for (const window of this.windowsSpanned(
            task.scheduledStart,
            task.scheduledEnd,
            (d) => businessWeekRange(d, dayStartHour)
          )) {
            const taskHours = overlapHours(
              task.scheduledStart,
              task.scheduledEnd,
              window.start,
              window.end
            );
            if (taskHours <= 0) continue;

            const committed = await this.getHoursInWeek(
              membershipId,
              window.start,
              task.id,
              cache,
              dayStartHour
            );
            if (committed + taskHours > rule.maxHours) {
              violated = true;
              reason = `Would total ${(committed + taskHours).toFixed(1)}h in the week of ${localDateInTimeZone(window.start)} (rule "${rule.name}": max ${rule.maxHours}h/week)`;
              break;
            }
          }
          break;
        }
      }

      if (violated) {
        return { eligible: false, reason };
      }
    }

    return { eligible: true };
  }

  /**
   * Filters work rules to those targeting a given member.
   * - Global rule (no role, no department) → applies to everyone
   * - Department rule → member must be in that department
   * - Role rule → member must hold that custom role
   * - Both → member must match both
   * Shared with the hour-limit alerting so both use identical targeting.
   */
  filterApplicableRules<T extends { roleId?: string | null }>(
    rules: T[],
    memberDepartmentIds: string[],
    memberCustomRoleId: string | null
  ): T[] {
    return rules.filter((rule) => {
      const ruleRoleId = rule.roleId || null;
      const ruleDeptId = (rule as Record<string, unknown>).departmentId as
        | string
        | null;

      if (!ruleRoleId && !ruleDeptId) return true;

      if (ruleDeptId && !ruleRoleId) {
        return memberDepartmentIds.includes(ruleDeptId);
      }

      if (ruleRoleId && !ruleDeptId) {
        return memberCustomRoleId === ruleRoleId;
      }

      if (ruleRoleId && ruleDeptId) {
        return (
          memberDepartmentIds.includes(ruleDeptId) &&
          memberCustomRoleId === ruleRoleId
        );
      }

      return false;
    });
  }

  /**
   * Assignment statuses that represent a real or committed time commitment.
   * rejected/withdrawn are excluded — they no longer occupy the person's time.
   */
  private static readonly COMMITTED_STATUSES = [
    "pending",
    "accepted",
    "withdrawal_requested",
    "clocked_out",
    "completed",
  ];

  /**
   * The effective time interval an assignment occupies:
   * - actual clock in/out when both are recorded (hours truly worked)
   * - otherwise the task's scheduled window (a future/committed shift)
   * Returns null when neither is known (unscheduled and not yet worked).
   */
  private effectiveInterval(a: {
    clockInTime: Date | null;
    clockOutTime: Date | null;
    task: { scheduledStart: Date | null; scheduledEnd: Date | null } | null;
  }): { start: Date; end: Date } | null {
    if (a.clockInTime && a.clockOutTime) {
      return { start: a.clockInTime, end: a.clockOutTime };
    }
    if (a.task?.scheduledStart && a.task?.scheduledEnd) {
      return { start: a.task.scheduledStart, end: a.task.scheduledEnd };
    }
    return null;
  }

  /**
   * Loads a member's committed/worked assignments with their task schedule,
   * so hour totals can count BOTH clocked time and future scheduled shifts.
   * `excludeTaskId` drops the task currently being evaluated to avoid
   * counting it against itself (e.g. when re-checking after a reschedule).
   *
   * ## The cache
   *
   * `getHoursInLast24h`, `getHoursOnDate` and `getHoursInWeek` each called this
   * independently, so evaluating one member against a break rule, a daily cap
   * and a weekly cap issued the SAME query three times. Multiplied across every
   * member of an organisation and run sequentially, a 150-staff org spent
   * hundreds of serial round trips on one eligibility check — and that check
   * runs fire-and-forget on every reschedule.
   *
   * The cache is a PARAMETER, deliberately, not a field on the service. This
   * class is held as a long-lived field by `TaskService` and others, so
   * instance state would be shared by every request that instance ever serves:
   * stale hour totals across requests, and two interleaved requests reading
   * each other's data. Passing it in scopes it to a single evaluation and makes
   * that scope visible at every call site.
   *
   * It caches the PROMISE rather than the resolved value, so concurrent callers
   * for the same member share one query instead of racing to start two.
   */
  private async loadCommittedAssignments(
    membershipId: string,
    excludeTaskId?: string,
    cache?: CommittedAssignmentsCache
  ) {
    if (!cache) {
      return this.assignmentRepo.findCommittedWithSchedule(
        membershipId,
        EligibilityService.COMMITTED_STATUSES,
        excludeTaskId
      );
    }

    const key = `${membershipId}|${excludeTaskId ?? ""}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const pending = this.assignmentRepo.findCommittedWithSchedule(
      membershipId,
      EligibilityService.COMMITTED_STATUSES,
      excludeTaskId
    );
    cache.set(key, pending);
    return pending;
  }

  /**
   * Every consecutive window (business day, business week) that `[start, end)`
   * touches, in order.
   *
   * `windowFor` must return a window CONTAINING the instant it is given and
   * must tile the timeline without gaps — both `businessDayRange` and
   * `businessWeekRange` do. The cursor therefore always advances by a full
   * window and the loop terminates.
   *
   * The iteration cap is a backstop against corrupt data, not a policy: a task
   * with a scheduled end years after its start would otherwise spin here. It is
   * set far above anything a real roster contains, and hitting it truncates the
   * check rather than hanging the request — an under-check on absurd data,
   * which is the safer failure of the two available.
   */
  private *windowsSpanned(
    start: Date,
    end: Date,
    windowFor: (date: Date) => { start: Date; end: Date }
  ): Generator<{ start: Date; end: Date }> {
    const MAX_WINDOWS = 400;

    let window = windowFor(start);
    for (let i = 0; i < MAX_WINDOWS; i++) {
      yield window;
      if (window.end.getTime() >= end.getTime()) return;
      window = windowFor(window.end);
    }
  }

  /**
   * Sums the portion of each assignment that OVERLAPS [windowStart, windowEnd).
   * A null windowEnd means "no upper bound".
   *
   * ## Why overlap, and not "starts within"
   *
   * This previously selected intervals whose START fell inside the window and
   * then added the interval's ENTIRE duration. That is wrong in both
   * directions, and both were reachable:
   *
   *  - OVER-COUNT. A long shift beginning inside the window contributed all of
   *    its hours, including those outside it. Production showed
   *    "168.0h of 6h (2800%)" on a rolling 24-hour break rule — 168 hours is
   *    exactly seven days, and a 24-hour window cannot contain more than 24
   *    hours of work, so the figure was impossible rather than merely odd. The
   *    visible cost is false rest-break alarms.
   *
   *  - UNDER-COUNT. A shift that began BEFORE the window and is still running
   *    was skipped entirely. Someone twelve hours into an overnight shift read
   *    as zero hours worked, so a break rule that should have fired did not.
   *    This is the dangerous half: a false alarm is noise, a missed rest break
   *    is a safety failure.
   *
   * Clipping each interval to the window fixes both at once, and makes the
   * total bounded by the window's own length — which is the property that made
   * the original bug self-evident once anyone looked at the number.
   */
  private sumHoursInWindow(
    assignments: {
      clockInTime: Date | null;
      clockOutTime: Date | null;
      task: { scheduledStart: Date | null; scheduledEnd: Date | null } | null;
    }[],
    windowStart: Date,
    windowEnd: Date | null
  ): number {
    // An open-ended window is expressed as a far-future end rather than a
    // branch, so there is exactly one overlap calculation in the codebase.
    const end = windowEnd ?? new Date(8.64e15);

    let total = 0;
    for (const a of assignments) {
      const interval = this.effectiveInterval(a);
      if (!interval) continue;
      total += overlapHours(interval.start, interval.end, windowStart, end);
    }
    return Math.round(total * 10) / 10;
  }

  /**
   * Total committed hours in the last 24 hours (rolling). Counts actual
   * clocked time where it exists, otherwise the schedule, and counts only the
   * portion of each that falls inside the window — so the result can never
   * exceed 24, and a shift still in progress contributes the hours already
   * worked rather than nothing.
   */
  async getHoursInLast24h(
    membershipId: string,
    excludeTaskId?: string,
    cache?: CommittedAssignmentsCache
  ): Promise<number> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const assignments = await this.loadCommittedAssignments(membershipId, excludeTaskId, cache);
    return this.sumHoursInWindow(assignments, oneDayAgo, now);
  }

  /**
   * Total committed hours on the BUSINESS DAY containing `date` — clocked time
   * AND scheduled shifts — so daily caps prevent over-scheduling future work.
   *
   * `dayStartHour` is the organisation's `operatingHoursStart`, and it decides
   * where one day ends and the next begins. It defaults to midnight so that
   * every existing caller keeps its previous behaviour until it opts in.
   *
   * Why the boundary is configurable at all: a restaurant's Friday ends when
   * the kitchen closes at 2am, not at midnight. Judged against midnight, a
   * single 22:00–02:00 shift is split across two days and a daily cap fires on
   * work nobody thinks of as belonging to either. Moving the boundary to 06:00
   * puts the whole shift where the people working it would put it.
   */
  async getHoursOnDate(
    membershipId: string,
    date: Date,
    excludeTaskId?: string,
    cache?: CommittedAssignmentsCache,
    dayStartHour: number = DEFAULT_DAY_START_HOUR
  ): Promise<number> {
    // Resolved in the organisation's timezone, not the server's. On Vercel a
    // naive setHours(0,0,0,0) starts the day at 08:00 Singapore time, so a
    // morning shift counts against the previous day's cap.
    const { start, end } = businessDayRange(date, dayStartHour);

    const assignments = await this.loadCommittedAssignments(membershipId, excludeTaskId, cache);
    return this.sumHoursInWindow(assignments, start, end);
  }

  /**
   * Total committed hours in the business week (Mon–Sun) containing the date —
   * clocked time AND scheduled shifts — so weekly caps prevent over-scheduling.
   *
   * The week is built from business days, so with a 06:00 boundary a shift at
   * 03:00 on Monday belongs to Sunday's business day and therefore to the week
   * that is ending. Reading the weekday off the raw instant would file it under
   * the new week instead, and the small hours of Monday would escape both
   * weeks' caps.
   */
  async getHoursInWeek(
    membershipId: string,
    date: Date,
    excludeTaskId?: string,
    cache?: CommittedAssignmentsCache,
    dayStartHour: number = DEFAULT_DAY_START_HOUR
  ): Promise<number> {
    const { start, end } = businessWeekRange(date, dayStartHour);

    const assignments = await this.loadCommittedAssignments(membershipId, excludeTaskId, cache);
    return this.sumHoursInWindow(assignments, start, end);
  }

  /**
   * Creates an eligibility override for a specific member and task.
   * Used by managers to bypass eligibility blocks with documentation.
   */
  async createOverride(
    taskId: string,
    membershipId: string,
    overriddenById: string,
    reason: string,
    ruleOverridden: string,
    organizationId: string
  ) {
    // Scope both the task and the member to the caller's org before writing —
    // an override must not be created against another tenant's task/member.
    const task = await this.taskRepo.findOrgAndTitleById(taskId);
    if (!task || task.organizationId !== organizationId) {
      throw new Error("Task not found");
    }

    const membership = await this.membershipRepo.findById(membershipId);
    if (!membership || membership.organizationId !== organizationId) {
      throw new Error("Staff member does not belong to this organization");
    }
    // Same reasoning as TaskService.assignStaff: findById does not filter on
    // status, and there is no point overriding an eligibility rule for someone
    // who may not be assigned at all.
    if (membership.status !== "active") {
      throw new Error("Staff member is deactivated");
    }

    const override = await this.overrideRepo.create({
      taskId,
      membershipId,
      overriddenById,
      reason,
      ruleOverridden,
    });

    // Audit — records who waived which rule and why.
    void this.auditService.log({
      organizationId: task.organizationId,
      userId: overriddenById,
      action: ACTIONS.ELIGIBILITY_OVERRIDDEN,
      entityType: "task",
      entityId: taskId,
      details: {
        taskTitle: task.title,
        membershipId,
        ruleOverridden,
        reason,
      },
    });

    return override;
  }

  /** Gets all overrides for a task */
  async getOverridesForTask(taskId: string) {
    return this.overrideRepo.findByTaskId(taskId);
  }
}