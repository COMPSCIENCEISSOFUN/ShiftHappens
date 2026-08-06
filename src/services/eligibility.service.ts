/**
 * Eligibility Service (Control Layer)
 *
 * The core eligibility engine. Checks five dimensions to determine
 * if a staff member is eligible for a task assignment:
 *
 * 1. HOURS LIMIT — Has the member exceeded the company break rule threshold in
 *    the 24 hours before the shift begins?
 * 2. AVAILABILITY — Is the member available at the task's scheduled time?
 *    - Casual staff: weekly availability is a HARD CONSTRAINT
 *    - Full-time staff: SKIP — always available during operating hours
 * 3. SCHEDULING — Does the member have conflicting assignments?
 * 4. WORK RULES — Does the assignment violate any custom work rules?
 *    Rules can target globally, by department, or by custom role. Daily and
 *    weekly caps sum every window the shift touches; the rest-gap rule checks
 *    both sides of it.
 * 5. CERTIFICATIONS — Does the member hold every certification the task
 *    requires, unexpired?
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
import { DEFAULT_EMPLOYMENT_TYPE, canBeRostered, isFullTime } from "@/lib/role-config";
import { localDateInTimeZone, timeOfDayInTimeZone } from "@/lib/timezone";
import {
  DEFAULT_DAY_START_HOUR,
  businessDayRange,
  businessWeekRange,
  overlapHours,
} from "@/lib/business-day";
import { occupiesSlot, occupyingStatusFilter } from "@/lib/assignment-status";

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
 * All any hour calculation reads off an assignment. Structural on purpose, so a
 * provisional shift and a stored one are the same thing to everything below.
 */
interface CommittedInterval {
  /** Null for a provisional shift, which has no row yet. */
  taskId?: string | null;
  clockInTime: Date | null;
  clockOutTime: Date | null;
  task: { scheduledStart: Date | null; scheduledEnd: Date | null } | null;
}

/**
 * Shifts a caller has decided but not yet written to the database.
 *
 * The auto-scheduler builds a whole week before saving anything, so by the time
 * it evaluates the fifth task it has already committed the same people to four
 * others that the engine cannot see. It used to solve that with its own running
 * tallies and its own copies of the availability, conflict and work-rule
 * checks — copies that were weaker than the originals in two specific ways: the
 * daily cap compared ONE shift's length against the limit rather than summing
 * the day, so two six-hour shifts fitted under an eight-hour cap; and rest gaps
 * were not checked at all.
 *
 * Passing the draft in instead means the engine's own arithmetic — the same
 * windowing, clipping and rest-gap logic the assign screen uses — decides the
 * answer, and there is one implementation of each rule rather than two.
 *
 * Keyed by membershipId. Intervals need a title only so a conflict can name
 * what it clashes with.
 */
export type ProvisionalAssignments = Map<
  string,
  { start: Date; end: Date; title: string }[]
>;

/**
 * Per-evaluation memo of committed assignments, keyed by
 * `membershipId|excludeTaskId`. Created by the caller and passed down, so its
 * lifetime is one eligibility run — see `loadCommittedAssignments`.
 */
export type CommittedAssignmentsCache = Map<
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
    organizationId: string,
    /**
     * Shifts the caller has decided but not yet saved. Only the auto-scheduler
     * passes this — see `ProvisionalAssignments`.
     */
    provisional?: ProvisionalAssignments,
    /**
     * A memo of per-member commitments that OUTLIVES this call.
     *
     * One evaluation is cheap; a whole generated week is not. Without a shared
     * memo the auto-scheduler reloaded every member's assignments for every
     * task — 100 tasks against 100 members is 10,000 identical round trips for
     * data that does not change during the run.
     *
     * Only a caller that owns a bounded run should pass one, because a stale
     * entry is a wrong verdict. The assign screen passes nothing and gets a
     * fresh memo per call, which is the safe default.
     */
    sharedHoursCache?: CommittedAssignmentsCache
  ): Promise<StaffEligibility[]> {
    const task = await this.taskRepo.findByIdWithoutRelations(taskId);
    // Cross-tenant tasks are invisible — never evaluate another org's task.
    if (!task || task.organizationId !== organizationId) throw new Error("Task not found");

    const settings = await this.settingsRepo.getOrCreate(organizationId);

    // Get all active work rules for this org
    const allWorkRules = await this.workRuleRepo.findApplicableRules(organizationId);

    /*
     * Who gets evaluated.
     *
     * This method answers two questions at once, and they need different
     * candidate sets:
     *
     *   "who could I put on this shift?"     — department scope applies
     *   "is the person already on it still
     *    OK?"                                — department scope cannot apply
     *
     * The department filter alone answered only the first, which made the
     * second unanswerable for anyone outside the task's department. That is not
     * a hypothetical: moving a task from Kitchen to Front of House leaves every
     * assigned Kitchen member in place and simultaneously invisible to every
     * check. Worse, `notifyIneligibleAssignees` runs on precisely that update,
     * finds nobody to look at, and reports all clear — a reassuring silence at
     * the moment something is most likely to be wrong. From then on those
     * assignments are exempt from hour limits, availability and certification
     * checks permanently.
     *
     * So: department members, PLUS anyone already holding a live assignment,
     * whatever department they are in. Purely additive — no verdict on an
     * existing candidate changes, and the extra per-member work only appears
     * when a cross-department assignment actually exists.
     */
    const allMembers = await this.membershipRepo.findByOrgId(organizationId);
    const activeMembers = allMembers.filter(
      (m) => m.status === "active" && canBeRostered(m.role)
    );

    let eligibleMembers = activeMembers;
    if (task.departmentId) {
      const committed = await this.committedMembershipIds(taskId);
      eligibleMembers = activeMembers.filter(
        (m) =>
          committed.has(m.id) ||
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
    // times each. Scoped to this call unless a caller supplied one, in which
    // case it lives as long as that caller's run.
    const hoursCache: CommittedAssignmentsCache = sharedHoursCache ?? new Map();

    /*
     * Members are evaluated CONCURRENTLY.
     *
     * Each one is independent — nothing in the loop reads another member's
     * result — but the body awaits four to six queries, so running it in series
     * made the wall-clock cost the sum of every member's round trips. On a
     * generated week that is the difference between a page load and a timeout.
     *
     * Safe with the shared memo because the memo stores the PROMISE, not the
     * resolved rows: two members starting at once either find the same pending
     * promise or insert their own, and neither can observe a half-filled cache.
     */
    const results = await Promise.all(
      eligibleMembers.map(async (member) => {
      const memberEmploymentType = member.employmentType || DEFAULT_EMPLOYMENT_TYPE;

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
        await this.checkHoursLimit(
          member.id,
          settings.breakRuleHoursWorked,
          task.id,
          hoursCache,
          provisional,
          // Judged at the shift, not at the clock. Everything else in this
          // method is evaluated at the task's own moment; this check was the
          // last one still measuring the day the manager happened to click.
          task.scheduledStart && task.scheduledEnd
            ? { start: task.scheduledStart, end: task.scheduledEnd }
            : undefined
        )
      );

      /*
       * 2. Availability — a hard constraint for EVERYONE.
       *
       * This used to read `memberEmploymentType === "casual"`, on the reasoning
       * that a full-timer is "always available during operating hours". That
       * was true while a full-timer had nothing meaningful to say: no
       * contracted pattern, no way to record an absence.
       *
       * It stopped being true, and stopped silently. Leave requests gave a
       * full-timer an approved absence that `isAvailableAt` honours — and this
       * branch never asked, so an approved leave request made the member
       * unavailable at the repository and left them fully eligible here. The
       * assign screen went on offering them, the auto-scheduler went on
       * rostering them, and every test of the feature passed because they all
       * asserted against `isAvailableAt` rather than against eligibility.
       *
       * Both employment types now have a real pattern — a casual declares
       * theirs, a full-timer's is contracted and opened to the whole week by
       * default — so the same question is meaningful for both.
       */
      let availCheck: EligibilityCheck = { eligible: true };
      if (task.scheduledStart && task.scheduledEnd) {
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
          endTime,
          // A contracted member's unwritten day is open, not refused.
          isFullTime(memberEmploymentType)
        );
        availCheck = applyOverride(this.OVERRIDE_KEYS.availability, {
          eligible: availResult.available,
          reason: availResult.reason,
        });
      }

      // 3. Scheduling conflicts
      const schedulingCheck = applyOverride(
        this.OVERRIDE_KEYS.scheduling,
        await this.checkSchedulingConflicts(member.id, task, provisional)
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
          settings.operatingHoursStart,
          provisional
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

      return {
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
      };
      })
    );

    return results;
  }

  /** Builds a map of membershipId → set of overridden rule keys for a task. */
  /**
   * Members holding a live assignment on this task.
   *
   * "Live" is the same set that occupies a headcount slot — everything except
   * rejected and withdrawn, so a decline or a withdrawal awaiting a manager's
   * decision still counts. Someone who rejected or withdrew is not on the
   * shift, so there is nothing about them left to validate.
   */
  private async committedMembershipIds(taskId: string): Promise<Set<string>> {
    const assignments = await this.assignmentRepo.findByTaskId(taskId);
    return new Set(
      assignments
        .filter((a) =>
          occupiesSlot(a.status)
        )
        .map((a) => a.membershipId)
    );
  }

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
   * Checks a member against the company break rule: a cap on hours in any
   * rolling 24 hours.
   *
   * ## What this used to ask, and why it was wrong twice
   *
   * It summed the 24 hours ending at `new Date()` and refused when that total
   * reached the cap. Two separate faults, and correcting the first exposed the
   * second.
   *
   * The window was anchored to the CLOCK, not the shift. Rostering someone
   * three weeks out was judged on what they had worked the day before the
   * manager clicked — so a heavy yesterday blocked a shift next month, while
   * two back-to-back shifts next Tuesday passed because neither had happened
   * yet. That is the same fault the rest-gap rule was rewritten to remove.
   *
   * And it never looked at the shift being PROPOSED. It compared prior hours
   * alone against the cap, at-or-over. With the default of 8, a member rostered
   * Monday 09:00–17:00 was refused the identical Tuesday shift: the 24 hours
   * before Tuesday 09:00 land exactly on Monday 09:00, so Monday's whole eight
   * hours fall inside and eight is "at" eight. Nothing was actually wrong —
   * those shifts are a day apart and no 24-hour window holds more than eight
   * hours of work — but the most ordinary roster there is was refused.
   *
   * ## What it asks now
   *
   * Whether the proposed shift PUSHES a 24-hour window over the cap, which is
   * how `max_hours_daily` and `max_hours_weekly` already work. Three hour rules
   * that phrase the same question three ways is how one of them comes to be
   * wrong without anybody noticing.
   *
   * ## Which windows
   *
   * Two, because a 24-hour window can be worst on either side of the shift:
   *
   *   [end − 24h, end]     work done just BEFORE the shift, plus the shift
   *   [start, start + 24h] the shift, plus work coming just AFTER it
   *
   * Checking only one is order-dependent in exactly the way the rest-gap rule
   * was. A 2-hour shift proposed the night before an existing 8-hour day would
   * pass an end-anchored window (which sees nothing) while genuinely putting
   * ten hours into the day that follows it.
   *
   * The true worst window is always flush against one of the two shift edges,
   * so these two bound it — a window sitting strictly between them contains
   * less of the proposed shift and no more of anything else.
   *
   * `shift` omitted falls back to the 24 hours up to now, which answers a
   * question about the present rather than about a shift. Only callers with no
   * shift in hand should use it.
   */
  async checkHoursLimit(
    membershipId: string,
    maxHours: number,
    excludeTaskId?: string,
    cache?: CommittedAssignmentsCache,
    provisional?: ProvisionalAssignments,
    shift?: { start: Date; end: Date }
  ): Promise<EligibilityCheck> {
    const DAY_MS = 24 * 60 * 60 * 1000;

    if (!shift) {
      const now = await this.getHoursInLast24h(
        membershipId,
        excludeTaskId,
        cache,
        provisional
      );
      return now >= maxHours
        ? {
            eligible: false,
            reason: `${now.toFixed(1)}h in last 24h (limit: ${maxHours}h)`,
          }
        : { eligible: true, reason: `${now.toFixed(1)}h of ${maxHours}h limit` };
    }

    const committed = await this.loadCommittedAssignments(
      membershipId,
      excludeTaskId,
      cache,
      provisional
    );

    const windows = [
      { start: new Date(shift.end.getTime() - DAY_MS), end: shift.end },
      { start: shift.start, end: new Date(shift.start.getTime() + DAY_MS) },
    ];

    let worst = 0;
    for (const window of windows) {
      const total =
        this.sumHoursInWindow(committed, window.start, window.end) +
        overlapHours(shift.start, shift.end, window.start, window.end);
      if (total > worst) worst = total;
    }

    if (worst > maxHours) {
      return {
        eligible: false,
        reason: `Would total ${worst.toFixed(1)}h in 24h (limit: ${maxHours}h)`,
      };
    }

    return {
      eligible: true,
      reason: `${worst.toFixed(1)}h of ${maxHours}h limit`,
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
    task: { id: string; scheduledStart: Date | null; scheduledEnd: Date | null },
    provisional?: ProvisionalAssignments
  ): Promise<EligibilityCheck> {
    if (!task.scheduledStart || !task.scheduledEnd) {
      return { eligible: true, reason: "No schedule set" };
    }

    // A pending withdrawal still occupies the schedule until resolved.
    const stored = await this.taskRepo.findConflictingTaskTitles(
      membershipId,
      task.scheduledStart,
      task.scheduledEnd,
      task.id
    );

    /*
     * Draft shifts clash too. A whole-week draft decides several shifts before
     * saving any of them, so the database cannot answer this on its own — and
     * without it a draft would happily put one person on two overlapping shifts
     * and only discover it when the confirm failed.
     */
    const drafted = (provisional?.get(membershipId) ?? []).filter(
      (d) => task.scheduledStart! < d.end && task.scheduledEnd! > d.start
    );

    const titles = [...stored.map((c) => c.title), ...drafted.map((d) => d.title)];
    if (titles.length > 0) {
      return {
        eligible: false,
        reason: `Conflicts with: ${titles.join(", ")}`,
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
    dayStartHour: number = DEFAULT_DAY_START_HOUR,
    provisional?: ProvisionalAssignments
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
        /*
         * A REST GAP between shifts, measured against the shift being judged.
         *
         * What this replaced was neither of those things. It asked
         * `getHoursInLast24h`, which anchors its window to `new Date()` — so
         * assigning someone to a shift three weeks out was judged on what they
         * had worked in the day before the manager clicked, and the check
         * failed in both directions at once: a double yesterday blocked a shift
         * next month, while two back-to-back shifts next Tuesday passed
         * because nothing had been worked yet.
         *
         * And `breakHours` was never read. The form demands it, validation
         * refuses to save without it, the auto-schedule prompt quotes it — and
         * no enforcement path touched it, so "a 1-hour break after 6 hours"
         * meant "blocked after 6 hours", with no way to express the break at
         * all. What remained was a third hour cap wearing a break rule's name.
         *
         * The daily and weekly caps were corrected for this same class of bug
         * (see the comment below); this one was left behind.
         */
        case "break_interval": {
          if (!rule.hoursThreshold || !rule.breakHours) break;
          if (!task.scheduledStart || !task.scheduledEnd) break;

          const clash = await this.findRestGapBreach(
            membershipId,
            task.id,
            task.scheduledStart,
            task.scheduledEnd,
            rule.hoursThreshold,
            rule.breakHours,
            cache,
            provisional
          );
          if (clash) {
            violated = true;
            /*
             * Which shift is named depends on which one earned the rest, and a
             * manager has to be able to tell which of the two to move. The
             * earlier version ran one phrasing through an inverted ternary and
             * described a preceding shift as coming after the gap.
             */
            const where =
              clash.side === "before"
                ? `since a ${clash.shiftHours.toFixed(1)}h shift ending just before it`
                : `after this ${clash.shiftHours.toFixed(1)}h shift, before the next one starts`;
            reason =
              `Only ${clash.gapHours.toFixed(1)}h rest ${where} ` +
              `(rule "${rule.name}": ${rule.breakHours}h break after ${rule.hoursThreshold}h worked)`;
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
              dayStartHour,
              provisional
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
              dayStartHour,
              provisional
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
  private static readonly COMMITTED_STATUSES = occupyingStatusFilter();

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
    cache?: CommittedAssignmentsCache,
    provisional?: ProvisionalAssignments
  ): Promise<CommittedInterval[]> {
    const stored = await this.loadStoredAssignments(
      membershipId,
      excludeTaskId,
      cache
    );

    const drafted = provisional?.get(membershipId);
    if (!drafted || drafted.length === 0) return stored;

    /*
     * Draft shifts are shaped as unclocked scheduled ones, so `effectiveInterval`
     * reads them exactly as it reads a real assignment and every downstream
     * calculation — the 24h window, the daily and weekly sums, the rest gap —
     * works on them without knowing they are provisional.
     *
     * Appended to a COPY. The array behind `stored` may be the memoised one, and
     * mutating it would leave one evaluation's draft visible to the next read
     * of the same key.
     *
     * Mutation testing could not kill this: emptying the cached array still
     * produces the right answer today, because every read within a single
     * `checkEligibilityForTask` recomputes from the same freshly-loaded list
     * and the draft is re-appended each time. It stays because the property it
     * protects is one nobody would think to re-check — the memo is shared by
     * every member in a run, and a mutation here would surface as one member's
     * hours quietly going missing rather than as an error.
     */
    return [
      ...stored,
      ...drafted.map((d) => ({
        clockInTime: null,
        clockOutTime: null,
        task: { scheduledStart: d.start, scheduledEnd: d.end },
      })),
    ];
  }

  /** The database half of `loadCommittedAssignments`, with the memo. */
  private async loadStoredAssignments(
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

    /*
     * Keyed on the MEMBER alone, with the exclusion applied afterwards.
     *
     * The key used to include `excludeTaskId`, which is different for every
     * task — so the memo could never be reused across tasks, and a caller
     * evaluating a whole week reloaded every member's commitments once per
     * task. At 100 tasks and 100 members that is 10,000 round trips for data
     * that changes once.
     *
     * Excluding in memory is equivalent because the query is the same set minus
     * one row, and the row is identified by an id we now select.
     */
    const cached = cache.get(membershipId);
    const all = cached ?? this.loadAllCommitted(membershipId);
    if (!cached) cache.set(membershipId, all);

    const rows = await all;
    return excludeTaskId
      ? rows.filter((r) => r.taskId !== excludeTaskId)
      : rows;
  }

  private loadAllCommitted(membershipId: string) {
    return this.assignmentRepo.findCommittedWithSchedule(
      membershipId,
      EligibilityService.COMMITTED_STATUSES
    );
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
   * The nearest shift that leaves too little rest either side of `[start, end)`.
   *
   * Both sides on purpose. A manager does not only add shifts after existing
   * ones — inserting an early shift the morning after a late one is the same
   * breach seen from the other end, and checking only backwards would let the
   * roster be built in the order that hides it.
   *
   * `hoursThreshold` gates which pairs count: a rule reading "11 hours off
   * after 8 hours worked" should say nothing about a two-hour shift. It is
   * compared against whichever of the two shifts is WORKED FIRST, because that
   * is the one that earns the rest — and which shift that is depends on the
   * side:
   *
   *   neighbour, rest, [proposed]   → the neighbour earned it
   *   [proposed], rest, neighbour   → the proposed shift earned it
   *
   * Gating on the neighbour in both directions was the bug that made this
   * order-dependent, which is the exact fault the two-sided check was written
   * to remove. Under "11h after 8h": an existing 10h shift then a proposed 2h
   * one two hours later was refused, while the same pair entered the other way
   * round — existing 2h, proposed 10h — was allowed, because the 2h neighbour
   * fell under the threshold. Same roster, same breach, different answer
   * depending on which one the manager happened to create first.
   *
   * Overlapping shifts are left alone. A negative gap is a double-booking,
   * which the scheduling-conflict check already refuses with a message that
   * names the clash; reporting it here as "-3.0h rest" would be a second,
   * worse explanation of a problem already handled.
   *
   * `shiftHours` in the result is the EARNING shift's length, and `side` says
   * where the neighbour sits relative to the shift being judged.
   */
  private async findRestGapBreach(
    membershipId: string,
    excludeTaskId: string,
    start: Date,
    end: Date,
    hoursThreshold: number,
    breakHours: number,
    cache?: CommittedAssignmentsCache,
    provisional?: ProvisionalAssignments
  ): Promise<{ gapHours: number; shiftHours: number; side: "before" | "after" } | null> {
    const assignments = await this.loadCommittedAssignments(
      membershipId,
      excludeTaskId,
      cache,
      provisional
    );
    const required = breakHours * 60 * 60 * 1000;
    const HOUR = 60 * 60 * 1000;
    const proposedHours = (end.getTime() - start.getTime()) / HOUR;

    for (const a of assignments) {
      const other = this.effectiveInterval(a);
      if (!other) continue;

      const neighbourHours = (other.end.getTime() - other.start.getTime()) / HOUR;

      // Neighbour is worked first — it earns the rest, so it is the one the
      // threshold judges.
      if (other.end <= start) {
        if (neighbourHours < hoursThreshold) continue;
        const gap = start.getTime() - other.end.getTime();
        if (gap < required) {
          return {
            gapHours: gap / HOUR,
            shiftHours: neighbourHours,
            side: "before",
          };
        }
        continue;
      }

      // Proposed shift is worked first — it earns the rest, so the threshold
      // judges IT and the neighbour's length is irrelevant.
      if (other.start >= end) {
        if (proposedHours < hoursThreshold) continue;
        const gap = other.start.getTime() - end.getTime();
        if (gap < required) {
          return {
            gapHours: gap / HOUR,
            shiftHours: proposedHours,
            side: "after",
          };
        }
      }
    }

    return null;
  }

  /**
   * Total committed hours in the 24 hours ending at `anchor` (default: now).
   *
   * Counts actual clocked time where it exists, otherwise the schedule, and
   * counts only the portion of each that falls inside the window — so the
   * result can never exceed 24, and a shift still in progress contributes the
   * hours already worked rather than nothing.
   *
   * The anchor exists because two callers ask genuinely different questions of
   * the same window. The dashboard's hour alert asks "how loaded is this person
   * RIGHT NOW", and `new Date()` is the correct anchor for it. The eligibility
   * engine asks "how loaded will they be when this shift begins", and using
   * `new Date()` there was wrong in both directions at once: a heavy yesterday
   * blocked a shift three weeks out, while two back-to-back shifts next Tuesday
   * passed because neither had been worked yet.
   *
   * That is the same fault the rest-gap rule was rewritten to remove; this
   * caller was left on the old anchor.
   */
  async getHoursInLast24h(
    membershipId: string,
    excludeTaskId?: string,
    cache?: CommittedAssignmentsCache,
    provisional?: ProvisionalAssignments,
    anchor?: Date
  ): Promise<number> {
    const end = anchor ?? new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const assignments = await this.loadCommittedAssignments(membershipId, excludeTaskId, cache, provisional);
    return this.sumHoursInWindow(assignments, start, end);
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
    dayStartHour: number = DEFAULT_DAY_START_HOUR,
    provisional?: ProvisionalAssignments
  ): Promise<number> {
    // Resolved in the organisation's timezone, not the server's. On Vercel a
    // naive setHours(0,0,0,0) starts the day at 08:00 Singapore time, so a
    // morning shift counts against the previous day's cap.
    const { start, end } = businessDayRange(date, dayStartHour);

    const assignments = await this.loadCommittedAssignments(membershipId, excludeTaskId, cache, provisional);
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
    dayStartHour: number = DEFAULT_DAY_START_HOUR,
    provisional?: ProvisionalAssignments
  ): Promise<number> {
    const { start, end } = businessWeekRange(date, dayStartHour);

    const assignments = await this.loadCommittedAssignments(membershipId, excludeTaskId, cache, provisional);
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