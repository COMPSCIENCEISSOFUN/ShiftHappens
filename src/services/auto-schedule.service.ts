/**
 * Auto-Schedule Service (Control Layer)
 *
 * Generates optimal weekly staff assignments using AI
 * with algorithmic fallback. Three-step workflow:
 * 1. collectWeekData — gathers tasks, staff, availability, rules
 * 2. generateSchedule — AI (with simple index mapping) or algorithmic fallback
 * 3. confirmSchedule — creates all assignments in batch
 *
 * AI strategy: Groq → Gemini → algorithmic fallback.
 * AI prompts use simple indices (Task 1, Staff A) instead of
 * database IDs to prevent hallucinated CUIDs.
 */
import { TaskRepository } from "@/repositories/task.repository";
import { AI_PROVIDERS, type AIProviderName } from "./ai-provider";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { CertificationRepository } from "@/repositories/certification.repository";
import { WorkRuleRepository } from "@/repositories/work-rule.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { MembershipRepository } from "@/repositories/membership.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { DEFAULT_TIMEZONE, SERVER_LOCALE } from "@/lib/timezone";
import { isAllowedByProjectTeam, type TeamRestriction } from "@/lib/project-staffing";
import { ProjectRepository } from "@/repositories/project.repository";
import {
  EligibilityService,
  type ProvisionalAssignments,
  type CommittedAssignmentsCache,
} from "@/services/eligibility.service";
import { CompositionService } from "@/services/composition.service";
import { EligibilityOverrideRepository } from "@/repositories/eligibility-override.repository";
import {
  describeRule,
  openCompositionGate,
  parseCompositionRules,
  type CompositionCandidate,
  type CompositionGate,
  type CompositionRule,
} from "@/lib/composition-rules";
import { occupiesSlot } from "@/lib/assignment-status";
import { isDepartmentInScope } from "@/lib/department-scope";
import { acceptsAssignments } from "@/lib/task-status";
import { aiTimeoutSignal, hasApiKey } from "@/lib/ai-limits";
import { FallbackRanker } from "@/services/fallback-ranker";
import { availabilityFit, certificationRelevance } from "@/lib/ranking-inputs";
import {
  parseWeights,
  describeWeightsForPrompt,
  type RankingWeights,
} from "@/lib/ranking-weights";
import type { RankedStaff } from "@/services/ai-provider";

interface StaffInfo {
  membershipId: string;
  userId: string;
  name: string;
  role: string;
  departments: string[];
  /**
   * The same departments by id, for looking a member up in the composition
   * index. Seniority is department-scoped, so a member's level has to be read
   * per department rather than once.
   */
  departmentIds: string[];
  availability: {
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    isAvailable: boolean;
  }[];
  certifications: string[];
  hoursThisWeek: number;
}

interface TaskInfo {
  id: string;
  title: string;
  departmentId: string | null;
  departmentName: string | null;
  priority: string;
  requiredHeadcount: number;
  currentAssignments: number;
  scheduledStart: Date;
  scheduledEnd: Date;
  /** Hard constraint in the engine, so the prompt has to state it. */
  requiredCertifications: string[];
  /**
   * Parsed from the row already loaded. Empty for most tasks, which lets a run
   * skip the whole composition mechanism rather than query per task to discover
   * there was nothing to enforce.
   *
   * Kept as the parsed rules rather than a boolean because the prompt has to
   * state them: enforcing a constraint the model is not told about makes it
   * propose rosters that are then silently discarded.
   */
  compositionRules: CompositionRule[];
  /**
   * Who currently holds a slot. Composition rules judge the whole shift, so the
   * people already on it are part of what a proposal is measured against.
   */
  assignedMembershipIds: string[];
  /**
   * The project this shift belongs to, if any.
   *
   * Carried on the context rather than re-read per task: `eligibleFor` needs
   * it to narrow candidates to a Project Team, and the row it comes from is
   * already loaded here.
   */
  projectId: string | null;
}

export interface DraftAssignment {
  taskId: string;
  taskTitle: string;
  membershipId: string;
  staffName: string;
  reasoning: string;
}

export interface DraftSchedule {
  /**
   * Which strategy produced this draft. Server-computed and returned to the
   * client so the confirm request can echo it back — see the note on
   * `confirmSchedule` about how far that is trusted.
   */
  provider: AIProviderName;
  assignments: DraftAssignment[];
  unfilledTasks: { taskId: string; taskTitle: string; reason: string }[];
  summary: {
    totalTasks: number;
    totalAssignments: number;
    totalUnfilled: number;
    hoursDistribution: { name: string; hours: number }[];
  };
}

/**
 * Composition candidates by department scope. Key is the department id, or the
 * empty string for the org-wide scope a task with no department uses.
 */
type CompositionIndex = Map<
  string,
  { departmentName: string | null; candidates: Map<string, CompositionCandidate> }
>;

interface ScheduleContext {
  tasks: TaskInfo[];
  staff: StaffInfo[];
  workRules: { name: string; type: string; maxHours?: number | null; hoursThreshold?: number | null; breakHours?: number | null }[];
  /** The organisation's ranking priorities, applied by `FallbackRanker`. */
  weights: RankingWeights;
  /**
   * Certifications each department's tasks call for, keyed by department id
   * ("" for org-wide work).
   *
   * Collected once for the week rather than per task: it is the same answer for
   * every shift in a department, and the builder walks dozens of them.
   */
  departmentCerts: Map<string, string[]>;
  /**
   * The weekly hour ceiling the workload dimension measures against.
   *
   * Taken from a `max_hours_weekly` work rule where one exists, so "how loaded
   * is this person" is answered against the organisation's own limit rather
   * than an invented constant.
   */
  maxWeeklyHours: number;
}

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0, high: 1, medium: 2, low: 3,
};

const STAFF_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export class AutoScheduleService {
  private taskRepo = new TaskRepository();
  private availRepo = new AvailabilityRepository();
  private certRepo = new CertificationRepository();
  private workRuleRepo = new WorkRuleRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private settingsRepo = new SettingsRepository();
  private membershipRepo = new MembershipRepository();
  private eligibilityService = new EligibilityService();
  private compositionService = new CompositionService();
  private overrideRepo = new EligibilityOverrideRepository();
  private projectRepo = new ProjectRepository();
  private auditService = new AuditLogService();
  private notificationService = new NotificationService();

  async collectWeekData(
    organizationId: string,
    weekStart: Date,
    /**
     * The caller's departments, or null for a company admin.
     *
     * Scopes WHAT IT FILLS and WHO IT MAY USE — never what it counts. Hours,
     * rest gaps and scheduling conflicts are facts about a person, not a
     * department: a Kitchen manager's draft that ignored Sam's Front-of-House
     * shifts would roster him into a rest-gap breach. Those all run through
     * `checkEligibilityForTask`, which is org-wide and stays that way; only the
     * two lists below narrow.
     *
     * A task with NO department is admin-only, matching `isDepartmentInScope`
     * — a scoped caller cannot see org-wide work, so they must not be able to
     * roster it either.
     */
    departmentScope?: string[] | null
  ): Promise<ScheduleContext> {
    const scope =
      departmentScope === undefined || departmentScope === null
        ? null
        : new Set(departmentScope);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const allTasks = await this.taskRepo.findByOrganizationId(organizationId, { status: "open" });

    const tasks: TaskInfo[] = [];
    for (const task of allTasks) {
      if (!task.scheduledStart || !task.scheduledEnd) continue;
      const start = new Date(task.scheduledStart);
      const end = new Date(task.scheduledEnd);
      if (start >= weekEnd || end <= weekStart) continue;

      // Out of scope entirely: not a shift this caller may fill. Checked before
      // the assignment count so a scoped run does not pay for tasks it will
      // discard.
      if (scope && !isDepartmentInScope(task.department?.id ?? null, [...scope])) {
        continue;
      }

      const currentAssignments = await this.assignmentRepo.countActiveByTaskId(task.id);
      if (currentAssignments >= task.requiredHeadcount) continue;

      tasks.push({
        id: task.id,
        title: task.title,
        departmentId: task.department?.id || null,
        departmentName: task.department?.name || null,
        priority: task.priority,
        requiredHeadcount: task.requiredHeadcount,
        currentAssignments,
        scheduledStart: start,
        scheduledEnd: end,
        requiredCertifications: task.requiredCertifications ?? [],
        compositionRules: parseCompositionRules(task.compositionRules),
        projectId: task.projectId ?? null,
        // From the rows already loaded — same filter `countActiveByTaskId`
        // uses, so this list and `currentAssignments` cannot disagree.
        assignedMembershipIds: task.assignments
          .filter((a) => occupiesSlot(a.status))
          .map((a) => a.membershipId),
      });
    }

    const allMembers = await this.membershipRepo.findSchedulableStaff(organizationId);
    // Somebody in ANY of the caller's departments is usable — a member of both
    // Kitchen and Front of House is a legitimate candidate for a Kitchen
    // manager's draft.
    const members = scope
      ? allMembers.filter((m) =>
          m.departmentMemberships.some((dm) => scope.has(dm.department.id))
        )
      : allMembers;

    const staff: StaffInfo[] = [];
    for (const member of members) {
      const availability = await this.availRepo.getWeeklySchedule(member.id);
      const certs = await this.certRepo.getValidCertifications(member.id);

      /*
       * Hours COMMITTED this week, not hours clocked.
       *
       * This read `findClockedWithinWindow`, which requires a clock-in — so a
       * shift booked for next Tuesday counted as zero. Two runs of the
       * scheduler in the same week therefore piled work onto the same people:
       * the first run booked them, the second read them as untouched, and
       * `hoursThisWeek` carries the ranker's largest single weight at 30% for
       * "fewest hours worked". Every hard rule still passed, so nothing flagged
       * it — the roster was simply unfair, quietly.
       *
       * Actuals where they exist, the planned window otherwise. A finished
       * shift that overran is worth what it really took; one that has not
       * happened yet is worth what it is scheduled to take.
       */
      const assignments = await this.assignmentRepo.findCommitmentsWithinWindow(
        member.id,
        weekStart,
        weekEnd
      );

      let hoursThisWeek = 0;
      for (const a of assignments) {
        if (a.clockInTime && a.clockOutTime) {
          hoursThisWeek += (a.clockOutTime.getTime() - a.clockInTime.getTime()) / 3600000;
        } else if (a.task.scheduledStart && a.task.scheduledEnd) {
          hoursThisWeek +=
            (a.task.scheduledEnd.getTime() - a.task.scheduledStart.getTime()) / 3600000;
        }
      }

      staff.push({
        membershipId: member.id,
        userId: member.user.id,
        name: member.user.name || member.user.email,
        role: member.role,
        departments: member.departmentMemberships.map((dm) => dm.department.name),
        departmentIds: member.departmentMemberships.map((dm) => dm.department.id),
        availability: availability.map((a) => ({
          dayOfWeek: a.dayOfWeek,
          startTime: a.startTime,
          endTime: a.endTime,
          isAvailable: a.isAvailable,
        })),
        certifications: certs.map((c) => c.name),
        hoursThisWeek,
      });
    }

    const rules = await this.workRuleRepo.findApplicableRules(organizationId);
    const settings = await this.settingsRepo.getOrCreate(organizationId);

    /*
     * One lookup per DEPARTMENT present in the week, not per task. The
     * requirement set is identical for every shift in a department, and a week
     * can carry dozens of them.
     */
    const departmentCerts = new Map<string, string[]>();
    for (const departmentId of new Set(tasks.map((t) => t.departmentId ?? ""))) {
      departmentCerts.set(
        departmentId,
        await this.taskRepo.requiredCertificationsInDepartment(
          organizationId,
          departmentId || null
        )
      );
    }

    /*
     * The organisation's own weekly ceiling where it has one. Falling back to
     * 40 rather than inventing a bigger number: the workload dimension measures
     * a RATIO, so an inflated cap would make everybody look equally unloaded
     * and quietly flatten the dimension.
     */
    const weeklyRule = rules.find(
      (r) => r.type === "max_hours_weekly" && r.maxHours
    );

    return {
      tasks: tasks.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)),
      staff,
      workRules: rules.map((r) => ({
        name: r.name, type: r.type, maxHours: r.maxHours,
        hoursThreshold: r.hoursThreshold, breakHours: r.breakHours,
      })),
      weights: parseWeights(settings.smartAllocationWeights),
      departmentCerts,
      maxWeeklyHours: weeklyRule?.maxHours ?? 40,
    };
  }

  async generateSchedule(
    organizationId: string,
    weekStart: Date,
    /** See `collectWeekData` — null for an admin, the caller's departments otherwise. */
    departmentScope?: string[] | null
  ): Promise<DraftSchedule> {
    const context = await this.collectWeekData(
      organizationId,
      weekStart,
      departmentScope
    );

    if (context.tasks.length === 0) {
      return { provider: "algorithmic", assignments: [], unfilledTasks: [], summary: { totalTasks: 0, totalAssignments: 0, totalUnfilled: 0, hoursDistribution: [] } };
    }

    /*
     * One memo for BOTH strategies.
     *
     * They read the same member commitments, and nothing is written until
     * `confirmSchedule`, so a shared snapshot is correct — and it is what makes
     * running the second path affordable enough to compare against the first.
     */
    const hoursCache: CommittedAssignmentsCache = new Map();

    /*
     * Composition data, gathered once for the same reason.
     *
     * Both strategies must produce drafts the confirm step will actually write.
     * Before this, neither considered composition at all: a draft could show
     * twenty assignments and write seventeen, with the three missing ones
     * unexplained. The gate now runs during generation, so a person who cannot
     * be admitted is reported as an unfilled slot with a reason, and the
     * enforcement at confirm becomes the backstop it should be rather than the
     * first place anybody hears about it.
     */
    const compositionData = await this.collectCompositionData(
      organizationId,
      context
    );

    /** How many slots this week actually needs filling. */
    const demand = context.tasks.reduce(
      (n, t) => n + Math.max(0, t.requiredHeadcount - t.currentAssignments),
      0
    );

    let aiDraft: DraftSchedule | null = null;
    try {
      aiDraft = await this.generateWithAI(
        context,
        organizationId,
        hoursCache,
        compositionData
      );
    } catch (error) {
      console.log("[Auto-Schedule] AI failed, using algorithmic fallback:", error);
    }

    /*
     * The AI draft is preferred only when it actually fills the week.
     *
     * It used to be preferred whenever it returned anything at all. That was
     * defensible while the AI path validated nothing — it returned roughly what
     * it proposed — but every proposal is now screened against the eligibility
     * engine, and the model is shown the whole staff list rather than each
     * task's eligible subset. So it routinely proposes people who are then
     * discarded, and a draft that filled three of twenty slots still won.
     *
     * A partial draft is not "the model did worse"; it is a roster with
     * seventeen empty shifts that a manager has to fill by hand. When the model
     * has not filled the week, the algorithmic pass runs too and whichever
     * filled more slots is returned.
     */
    if (aiDraft && aiDraft.assignments.length >= demand && demand > 0) {
      return aiDraft;
    }

    if (aiDraft && aiDraft.assignments.length > 0) {
      console.log(
        `[Auto-Schedule] AI filled ${aiDraft.assignments.length}/${demand} slots — comparing with the algorithmic pass`
      );
    } else {
      // Zero assignments counts as a failure, not as an AI result — otherwise a
      // model that returned nothing useful still shows up in the provider
      // charts as the engine having worked.
      console.log("[Auto-Schedule] AI produced no valid assignments, using algorithmic fallback");
    }

    const algorithmic = await this.generateAlgorithmic(
      context,
      organizationId,
      hoursCache,
      compositionData
    );

    // Ties go to the model: it was asked, it answered legally, and its
    // reasoning strings are the more useful of the two.
    return aiDraft && aiDraft.assignments.length >= algorithmic.assignments.length
      ? aiDraft
      : algorithmic;
  }

  /**
   * Who may take this task, given everything already committed AND everything
   * this draft has provisionally decided.
   *
   * The one gate both draft strategies pass through. It delegates to the
   * eligibility engine — the same code the assign screen uses — rather than
   * re-deriving the rules here.
   *
   * ## What this replaced
   *
   * `generateAlgorithmic` carried its own copy of the availability, conflict
   * and work-rule checks, and the copy was weaker than the original in two
   * specific ways:
   *
   *   - The daily cap read `taskDuration > rule.maxHours` — ONE shift's length
   *     against the limit. It never summed the day, so under an eight-hour cap
   *     a member could be given two six-hour shifts on the same day.
   *   - Rest gaps were not consulted at all, so `break_interval` had no effect
   *     on a generated week.
   *
   * It also skipped certifications entirely, and the AI path skipped every
   * check: `parseAIResponse` validated headcount and nothing else, while
   * `generateSchedule` PREFERS the AI draft whenever it returns anything. The
   * default path could therefore roster someone unavailable, uncertified,
   * double-booked and over their cap, and the first anyone heard of it was the
   * confirm failing.
   *
   * One engine call per task rather than per proposal: the verdict depends on
   * the draft so far, which changes only when a task is filled.
   *
   * ## Why anyone already on the task is removed
   *
   * `checkEligibilityForTask` deliberately INCLUDES members who already hold a
   * row on the task, and excludes that task from every conflict, hours and
   * rest-gap check, so their existing commitment can be re-validated rather
   * than reported as a clash with itself. The consequence is that an existing
   * assignee comes back `eligible: true` almost every time.
   *
   * That widening is for CHECKING, not for proposing, and it leaks straight
   * into a draft without this filter. `TaskAssignment` is unique on
   * `(taskId, membershipId)`, so a second row is impossible whatever its
   * status — the draft would look full and the write would fail at confirm.
   * The rejected case is worse than the duplicate one: a rejected row does not
   * occupy the slot, so the task reads as understaffed, and the member who
   * turned the shift down is the top-ranked candidate to be put back on it.
   *
   * ALL statuses, not just occupying ones, precisely because the constraint
   * does not care about status. `AllocationService.getRankedSuggestions`
   * carries the same filter for the same reason.
   */
  private async eligibleFor(
    taskId: string,
    organizationId: string,
    provisional: ProvisionalAssignments,
    /**
     * A per-RUN memo of member commitments, threaded from the caller.
     *
     * The engine's own memo lives for one call, so a generated week reloaded
     * every member's assignments once per task — 100 tasks against 100 members
     * is 10,000 identical round trips. It is safe to share across a run because
     * a run reads a snapshot: nothing is written until `confirmSchedule`, and
     * the draft's own decisions travel separately in `provisional`.
     */
    hoursCache: CommittedAssignmentsCache,
    /**
     * The task's Project Team, or null when it places no restriction.
     *
     * Passed in for the same reason `hoursCache` is. Discovering it here cost
     * a task re-read on every call — in a method whose own contract is that a
     * generated week does not reload per task — and the caller is already
     * holding the row it would have read.
     */
    projectTeam: TeamRestriction
  ): Promise<Set<string>> {
    const [verdicts, existing] = await Promise.all([
      this.eligibilityService.checkEligibilityForTask(
        taskId,
        organizationId,
        provisional,
        hoursCache
      ),
      this.assignmentRepo.findByTaskId(taskId),
    ]);
    const settled = new Set(existing.map((a) => a.membershipId));
    return new Set(
      verdicts
        .filter(
          (v) =>
            v.eligible &&
            isAllowedByProjectTeam(projectTeam, v.membershipId) &&
            !settled.has(v.membershipId)
        )
        .map((v) => v.membershipId)
    );
  }

  /**
   * Everyone the week's composition rules might judge, described once **per
   * department** rather than once per task.
   *
   * ## Why per department
   *
   * The three things a rule looks at are a member's seniority, their valid
   * certificates and their employment type. Only the first is task-sensitive,
   * and only as far as the task's DEPARTMENT — a kitchen veteran is a novice
   * behind the bar, but they are the same kitchen veteran on all forty kitchen
   * shifts that week. Describing them per task rebuilt an identical answer
   * every time: measured at 1663ms for a hundred constrained tasks against a
   * hundred staff, versus 41ms for one build. Everything that genuinely varies
   * per task — who is already on it, and its headcount — is already in
   * `ScheduleContext` and costs nothing.
   *
   * The empty-string key is the org-wide scope, used by tasks with no
   * department. Not merged with the others: org-wide seniority counts every
   * completed shift, so it is a different number, not a default.
   *
   * Built once in `generateSchedule` and shared by both draft strategies, for
   * the same reason `hoursCache` is. The GATES are not shared — each pass
   * proposes its own roster and needs its own running tally.
   */
  private async collectCompositionData(
    organizationId: string,
    context: ScheduleContext
  ): Promise<CompositionIndex> {
    const constrained = context.tasks.filter((t) => t.compositionRules.length > 0);
    if (constrained.length === 0) return new Map();

    const scopes = new Map<string, { id: string | null; name: string | null }>();
    for (const task of constrained) {
      scopes.set(task.departmentId ?? "", {
        id: task.departmentId,
        name: task.departmentName,
      });
    }

    // Anyone already on a constrained task is included even if they are not
    // schedulable staff — a rule judging the shift has to see them, and a task
    // moved between departments leaves assignees behind who no longer appear in
    // the candidate list.
    const ids = [
      ...new Set([
        ...context.staff.map((s) => s.membershipId),
        ...constrained.flatMap((t) => t.assignedMembershipIds),
      ]),
    ];

    const built = await Promise.all(
      [...scopes].map(async ([key, scope]) => {
        const described = await this.compositionService.buildCandidates(
          organizationId,
          ids,
          scope.id,
          scope.name
        );
        return [
          key,
          {
            departmentName: scope.name,
            candidates: new Map(described.map((c) => [c.membershipId, c])),
          },
        ] as const;
      })
    );

    return new Map(built);
  }

  /** A fresh set of gates over the shared index — one pass's running tally. */
  private openGates(
    index: CompositionIndex,
    context: ScheduleContext
  ): Map<string, CompositionGate> {
    const gates = new Map<string, CompositionGate>();
    if (index.size === 0) return gates;

    for (const task of context.tasks) {
      if (task.compositionRules.length === 0) continue;
      const scope = index.get(task.departmentId ?? "");
      if (!scope) continue;

      const assignedIds = new Set(task.assignedMembershipIds);
      const assigned = task.assignedMembershipIds
        .map((id) => scope.candidates.get(id))
        .filter((c): c is CompositionCandidate => Boolean(c));

      gates.set(
        task.id,
        openCompositionGate(
          task.compositionRules,
          assigned,
          task.requiredHeadcount,
          // Anyone already on the shift is excluded: proposing them is a
          // duplicate the unique constraint refuses anyway, and admitting them
          // would count one person twice against every rule.
          new Map([...scope.candidates].filter(([id]) => !assignedIds.has(id)))
        )
      );
    }
    return gates;
  }

  /** Records a decision so later tasks in the same draft can see it. */
  private remember(
    provisional: ProvisionalAssignments,
    membershipId: string,
    task: TaskInfo
  ) {
    const existing = provisional.get(membershipId) ?? [];
    existing.push({
      start: task.scheduledStart,
      end: task.scheduledEnd,
      title: task.title,
    });
    provisional.set(membershipId, existing);
  }

  private async generateAlgorithmic(
    context: ScheduleContext,
    organizationId: string,
    /** Shared with the AI pass when both run — see `generateSchedule`. */
    sharedHoursCache?: CommittedAssignmentsCache,
    /** Shared for the same reason; the gates built from it are not. */
    compositionData?: CompositionIndex
  ): Promise<DraftSchedule> {
    const assignments: DraftAssignment[] = [];
    const unfilledTasks: { taskId: string; taskTitle: string; reason: string }[] = [];
    const provisional: ProvisionalAssignments = new Map();

    // Still tracked, but only to SCORE — spreading work toward whoever has
    // least. Nothing is refused on this number any more; the engine decides
    // that, and it counts hours properly windowed rather than as a flat weekly
    // running total.
    const cumulativeHours = new Map<string, number>();
    for (const s of context.staff) cumulativeHours.set(s.membershipId, s.hoursThisWeek);

    // One memo for the whole generation — see `eligibleFor`.
    const hoursCache: CommittedAssignmentsCache = sharedHoursCache ?? new Map();
    const gates = this.openGates(
      compositionData ?? (await this.collectCompositionData(organizationId, context)),
      context
    );

    // One batched read for the whole run, like the hours memo above: a week
    // of shifts usually belongs to a handful of projects, and most to none.
    const projectTeams = await this.projectRepo.findTeamRestrictions(
      context.tasks.map((task) => task.projectId),
      organizationId
    );


    for (const task of context.tasks) {
      const slotsNeeded = task.requiredHeadcount - task.currentAssignments;
      if (slotsNeeded <= 0) continue;
      const gate = gates.get(task.id);

      const taskDuration =
        (task.scheduledEnd.getTime() - task.scheduledStart.getTime()) / 3600000;
      const eligible = await this.eligibleFor(
        task.id,
        organizationId,
        provisional,
        hoursCache,
        task.projectId ? (projectTeams.get(task.projectId) ?? null) : null
      );

      /*
       * Ranked by `FallbackRanker`, the same engine the single-task paths use.
       *
       * This had its own formula — `100 - hours + (inDepartment ? 25 : 0) + 25`
       * — so the organisation got a different answer depending on which SCREEN
       * asked: fill one shift and certifications and availability counted, one
       * of them wrongly; generate the week and neither existed, plus a constant
       * 25 that was identical for everybody and therefore did nothing at all.
       * Nothing explained the difference because nothing intended it.
       *
       * It also meant the configurable priorities could never reach the
       * flagship feature: weights the ranker reads are worth little if the
       * whole-week builder scores by a private rule.
       */
      const eligibleStaff = context.staff.filter((s) =>
        eligible.has(s.membershipId)
      );
      const ranked = FallbackRanker.rank(
        eligibleStaff.map((s) => ({
          membershipId: s.membershipId,
          name: s.name,
          // Hours accumulated by THIS draft, not the week's starting figure —
          // a person placed on Monday must look busier by Tuesday.
          hoursWorkedToday: cumulativeHours.get(s.membershipId) || 0,
          maxHours: context.maxWeeklyHours,
          certifications: s.certifications,
          availableHours: "",
          departmentHistory: task.departmentName
            ? s.departments.includes(task.departmentName)
              ? 1
              : 0
            : 0,
          availabilityFit: availabilityFit(s.availability, {
            start: task.scheduledStart,
            end: task.scheduledEnd,
          }),
          certificationRelevance: certificationRelevance(
            s.certifications,
            context.departmentCerts.get(task.departmentId ?? "") ?? []
          ),
        })),
        context.weights
      );
      const byMembership = new Map(eligibleStaff.map((s) => [s.membershipId, s]));
      const candidates = ranked
        .map((r: RankedStaff) => {
          const staff = byMembership.get(r.membershipId)!;
          const hours = cumulativeHours.get(r.membershipId) || 0;
          return {
            ...staff,
            score: r.score,
            hours,
            inDepartment: task.departmentName
              ? staff.departments.includes(task.departmentName)
              : false,
          };
        });

      const assignedToThisTask: DraftAssignment[] = [];
      for (let i = 0; i < candidates.length && assignedToThisTask.length < slotsNeeded; i++) {
        const c = candidates[i];

        // Eligibility says this person may work the shift; the gate says
        // whether the shift is still a legal roster with them on it. Skipped
        // rather than stopping the task — a later candidate may be exactly who
        // an unmet rule is waiting for.
        if (gate && !gate.admit(c.membershipId)) continue;

        const reasons: string[] = [];
        if (c.inDepartment) reasons.push("department match");
        reasons.push(`${Math.round(c.hours)}h this week`);
        if (c.certifications.length > 0) reasons.push("certified");

        assignedToThisTask.push({
          taskId: task.id,
          taskTitle: task.title,
          membershipId: c.membershipId,
          staffName: c.name,
          reasoning: reasons.join(", "),
        });

        cumulativeHours.set(c.membershipId, (cumulativeHours.get(c.membershipId) || 0) + taskDuration);
        this.remember(provisional, c.membershipId, task);
      }

      assignments.push(...assignedToThisTask);
      if (assignedToThisTask.length < slotsNeeded) {
        // Naming the composition rule matters here. "No eligible staff
        // remaining" sends a manager looking for more people when the problem
        // is the mix — there may be plenty of candidates and no legal one.
        const why =
          gate && gate.refused > 0
            ? "no remaining candidate fits the shift's composition rules"
            : "no eligible staff remaining";
        unfilledTasks.push({
          taskId: task.id,
          taskTitle: task.title,
          reason: `${assignedToThisTask.length} of ${slotsNeeded} filled — ${why}`,
        });
      }
    }

    return this.buildSummary(assignments, unfilledTasks, context);
  }

  /**
   * Drops anything in a proposed draft that the engine will not allow.
   *
   * Used on the AI path, whose proposals arrive unchecked. Walks tasks in the
   * same order the algorithmic path does, so a member the model put on two
   * overlapping shifts keeps the first and loses the second rather than the
   * outcome depending on the order the model happened to list them.
   */
  private async screenProposals(
    proposals: DraftAssignment[],
    context: ScheduleContext,
    organizationId: string,
    sharedHoursCache?: CommittedAssignmentsCache,
    compositionData?: CompositionIndex
  ): Promise<DraftAssignment[]> {
    const byTask = new Map<string, DraftAssignment[]>();
    for (const p of proposals) {
      byTask.set(p.taskId, [...(byTask.get(p.taskId) ?? []), p]);
    }

    const accepted: DraftAssignment[] = [];
    const provisional: ProvisionalAssignments = new Map();
    const hoursCache: CommittedAssignmentsCache = sharedHoursCache ?? new Map();
    const gates = this.openGates(
      compositionData ?? (await this.collectCompositionData(organizationId, context)),
      context
    );

    // One batched read for the whole run, like the hours memo above: a week
    // of shifts usually belongs to a handful of projects, and most to none.
    const projectTeams = await this.projectRepo.findTeamRestrictions(
      context.tasks.map((task) => task.projectId),
      organizationId
    );


    for (const task of context.tasks) {
      const proposed = byTask.get(task.id);
      if (!proposed || proposed.length === 0) continue;
      const gate = gates.get(task.id);

      const eligible = await this.eligibleFor(
        task.id,
        organizationId,
        provisional,
        hoursCache,
        task.projectId ? (projectTeams.get(task.projectId) ?? null) : null
      );
      /*
       * The eligible set is computed ONCE per task, before any of that task's
       * proposals are accepted, so it cannot notice a name appearing twice.
       * A model that answers `[{task:1,staff:"ALEX"},{task:1,staff:"alex"}]`
       * resolves both to the same membership, and both would be accepted,
       * counted against headcount, and remembered — double-charging that
       * person's provisional hours for the rest of the run before failing the
       * unique constraint at confirm.
       */
      const takenHere = new Set<string>();
      for (const p of proposed) {
        if (!eligible.has(p.membershipId)) continue;
        if (takenHere.has(p.membershipId)) continue;
        // After the duplicate check, not before: admitting the same person
        // twice would count them twice against every composition rule and
        // exhaust the gate on a row that was never going to be written.
        if (gate && !gate.admit(p.membershipId)) continue;
        takenHere.add(p.membershipId);
        accepted.push(p);
        this.remember(provisional, p.membershipId, task);
      }
    }

    return accepted;
  }

  private async generateWithAI(
    context: ScheduleContext,
    organizationId: string,
    hoursCache: CommittedAssignmentsCache,
    compositionData?: CompositionIndex
  ): Promise<DraftSchedule> {
    const { prompt, taskMap, staffMap } = this.buildAIPrompt(
      context,
      compositionData
    );

    let aiResponse: string | null = null;
    let provider: AIProviderName = "groq";
    try {
      aiResponse = await this.callGroq(prompt);
    } catch {
      try {
        aiResponse = await this.callGemini(prompt);
        provider = "gemini";
      } catch {
        throw new Error("Both AI providers failed");
      }
    }

    if (!aiResponse) throw new Error("Empty AI response");
    const draft = await this.parseAIResponse(
      aiResponse,
      context,
      taskMap,
      staffMap,
      organizationId,
      hoursCache,
      compositionData
    );
    return { ...draft, provider };
  }

  /**
   * Builds AI prompt using simple indices instead of database IDs.
   * Returns the prompt plus mapping dictionaries to convert back.
   */
  /**
   * The exact prompt the model would be sent for this week.
   *
   * Public because the prompt's CONTENT is a correctness concern rather than a
   * formatting detail: the draft is screened against constraints, and any
   * constraint the model is not told about turns into proposals that are
   * silently discarded. That is testable only by reading what it is sent.
   */
  async previewPrompt(
    organizationId: string,
    weekStart: Date,
    departmentScope?: string[] | null
  ): Promise<string> {
    const context = await this.collectWeekData(
      organizationId,
      weekStart,
      departmentScope
    );
    const index = await this.collectCompositionData(organizationId, context);
    return this.buildAIPrompt(context, index).prompt;
  }

  private buildAIPrompt(
    context: ScheduleContext,
    /**
     * Present whenever some task this week carries composition rules. The model
     * cannot apply a rule about seniority or employment type without being told
     * each person's, and the gate discards proposals that break one — so
     * withholding this makes the AI pass fill fewer slots and then lose the
     * "whichever filled more" comparison to the algorithmic pass.
     */
    index?: CompositionIndex
  ): {
    prompt: string;
    taskMap: Map<number, string>;
    staffMap: Map<string, string>;
  } {
    const taskMap = new Map<number, string>();
    const staffMap = new Map<string, string>();

    const taskLines = context.tasks.map((t, i) => {
      const num = i + 1;
      taskMap.set(num, t.id);
      // Pin the timezone: without it these format in the server's zone, so the
      // model is shown shift times eight hours from what the roster actually
      // says and reasons about the wrong part of the day.
      const day = t.scheduledStart.toLocaleDateString(SERVER_LOCALE, {
        weekday: "short",
        timeZone: DEFAULT_TIMEZONE,
      });
      const start = t.scheduledStart.toLocaleTimeString(SERVER_LOCALE, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: DEFAULT_TIMEZONE,
      });
      const end = t.scheduledEnd.toLocaleTimeString(SERVER_LOCALE, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: DEFAULT_TIMEZONE,
      });
      const certs = t.requiredCertifications.length > 0
        ? `, REQUIRES certs: ${t.requiredCertifications.join(", ")}`
        : "";
      // `describeRule` is the same sentence the assign screen and the refusal
      // message use, so the model is told the constraint in the words a manager
      // would read it in.
      const composition = t.compositionRules.length > 0
        ? `, COMPOSITION: ${t.compositionRules.map(describeRule).join("; ")}`
        : "";
      return `  Task ${num}: "${t.title}" (${t.departmentName || "no dept"}, ${t.priority}, needs ${t.requiredHeadcount - t.currentAssignments} staff, ${day} ${start}-${end}${certs}${composition})`;
    }).join("\n");

    /*
     * Only the attributes some rule this week actually reads.
     *
     * Certificates are already listed for every member, so a certification rule
     * needs nothing extra. Seniority and employment type are added only when a
     * rule of that kind exists — a prompt that grows with headcount should not
     * also grow with facts nothing in it refers to.
     */
    const kinds = new Set(
      context.tasks.flatMap((t) => t.compositionRules.map((r) => r.kind))
    );
    const showSeniority = kinds.has("seniority") && index !== undefined;
    const showEmployment = kinds.has("employment_type") && index !== undefined;

    /*
     * The rule itself is stated only when some task carries one. A week with no
     * composition rules should not be told how to obey them — the same reason
     * the attributes above are conditional, and the numbering follows so the
     * list never has a gap.
     */
    /*
     * The organisation's ranking priorities, as a sentence.
     *
     * `context.weights` was parsed on every run and read in exactly one place —
     * the algorithmic branch — so whenever the AI draft won the fill-count
     * comparison, the priorities an admin had configured influenced nothing.
     * Worse, unlike the single-task prompt they were not even mentioned, so the
     * model was inventing its own preference order.
     *
     * Told, not enforced: the models reason in language and cannot multiply by
     * 0.30, which is the same bargain the single-task path makes and the same
     * one the settings screen describes.
     */
    const priorities = describeWeightsForPrompt(context.weights);

    const compositionRule = kinds.size === 0
      ? ""
      : `6. Composition. Where a task lists COMPOSITION, the SET of people on that
   task must satisfy it — these constrain the mix, not each person individually,
   and are judged against everyone already on the shift plus everyone you add.
   If a task needs 2 staff and says "At most 1 assignee at Junior or below", one
   junior is fine and two is not, so leave the second seat for somebody senior
   rather than filling it with a junior who will be dropped.
`;

    /*
     * Seniority is quoted PER DEPARTMENT, because that is how the rule reads it:
     * a kitchen veteran is a novice behind the bar, and one number would be
     * wrong for every task outside whichever department it came from.
     *
     * Only the departments the member belongs to, plus the org-wide figure when
     * some constrained task has no department — the scope the rule would use in
     * that case, and a different number rather than a fallback.
     */
    const seniorityFor = (s: StaffInfo): string => {
      if (!index || !showSeniority) return "";
      const parts: string[] = [];
      for (const [key, scope] of index) {
        if (key !== "" && !s.departmentIds.includes(key)) continue;
        const level = scope.candidates.get(s.membershipId)?.seniority;
        if (!level) continue;
        parts.push(`${key === "" ? "org-wide" : scope.departmentName ?? key}=${level}`);
      }
      return parts.length > 0 ? `, seniority: ${parts.join(" ")}` : "";
    };

    const employmentFor = (s: StaffInfo): string => {
      if (!index || !showEmployment) return "";
      const type = [...index.values()]
        .map((scope) => scope.candidates.get(s.membershipId)?.employmentType)
        .find((t) => t);
      return type ? `, employment: ${type}` : "";
    };

    const staffLines = context.staff.map((s, i) => {
      const label = STAFF_LABELS[i] || `S${i}`;
      staffMap.set(label, s.membershipId);
      const avail = s.availability
        .filter((a) => a.isAvailable)
        .map((a) => {
          const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
          return `${days[a.dayOfWeek]} ${a.startTime}-${a.endTime}`;
        }).join(", ");
      return `  Staff ${label}: ${s.name} (${s.departments.join("/") || "no dept"}, ${Math.round(s.hoursThisWeek)}h worked, certs: ${s.certifications.join(", ") || "none"}${seniorityFor(s)}${employmentFor(s)}, available: ${avail || "none"})`;
    }).join("\n");

    const ruleLines = context.workRules.map((r) => {
      if (r.type === "max_hours_weekly") return `  - ${r.name}: max ${r.maxHours}h/week`;
      if (r.type === "max_hours_daily") return `  - ${r.name}: max ${r.maxHours}h/day`;
      // Named both halves. The prompt quoted only the threshold, so the
      // model was told a break existed but never how long it had to be.
      return `  - ${r.name}: ${r.breakHours}h rest after any shift of ${r.hoursThreshold}h or more`;
    }).join("\n");

    const prompt = `You are a workforce scheduler. Assign staff to tasks optimally.

TASKS:
${taskLines}

STAFF:
${staffLines}

WORK RULES:
${ruleLines || "  None"}

HARD RULES — a proposal breaking any of these is discarded, so proposing it
wastes the slot and leaves the shift unfilled:
1. Department must MATCH. If a task names a department, only staff listed in
   that department may be assigned to it. This is not a preference.
2. Certifications must be held. If a task lists REQUIRES certs, the staff
   member's certs must include every one of them.
3. Staff must be available for the FULL duration of the task.
4. No double-booking — one task at a time per staff member.
5. Respect the work rules above (hour limits and rest between shifts).
${compositionRule}
PREFERENCES — apply these only among staff who satisfy every hard rule, in
this order of importance:
${priorities || "Distribute hours fairly — prefer staff with fewer hours worked."}

Respond with ONLY a JSON array using task numbers and staff letters:
[{"task": 1, "staff": "A", "reason": "brief reason"}, ...]

Use the exact task numbers (1, 2, 3...) and staff letters (A, B, C...) from above. Do not invent new ones.`;

    return { prompt, taskMap, staffMap };
  }

  private async parseAIResponse(
    response: string,
    context: ScheduleContext,
    taskMap: Map<number, string>,
    staffMap: Map<string, string>,
    organizationId: string,
    hoursCache: CommittedAssignmentsCache,
    compositionData?: CompositionIndex
  ): Promise<DraftSchedule> {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found");

    const raw = JSON.parse(jsonMatch[0]) as { task: number; staff: string; reason: string }[];

    const assignments: DraftAssignment[] = [];
    const taskAssignCounts = new Map<string, number>();

    for (const entry of raw) {
      const taskId = taskMap.get(entry.task);
      const membershipId = staffMap.get(entry.staff?.toUpperCase());
      if (!taskId || !membershipId) continue;

      const task = context.tasks.find((t) => t.id === taskId);
      const staff = context.staff.find((s) => s.membershipId === membershipId);
      if (!task || !staff) continue;

      // Enforce headcount limit per task
      const needed = task.requiredHeadcount - task.currentAssignments;
      const assigned = taskAssignCounts.get(taskId) || 0;
      if (assigned >= needed) continue;

      assignments.push({
        taskId,
        taskTitle: task.title,
        membershipId,
        staffName: staff.name,
        reasoning: entry.reason || "AI recommended",
      });
      taskAssignCounts.set(taskId, assigned + 1);
    }

    /*
     * Everything above only checked that the model named a real task, a real
     * staff member, and did not exceed headcount. Nothing checked whether the
     * person could actually work the shift — and this is the path
     * `generateSchedule` PREFERS, so an unavailable, uncertified,
     * double-booked or over-cap roster was the default output.
     */
    const screened = await this.screenProposals(
      assignments,
      context,
      organizationId,
      hoursCache,
      compositionData
    );
    const unfilledTasks = this.findUnfilledTasks(screened, context);
    return this.buildSummary(screened, unfilledTasks, context);
  }

  private findUnfilledTasks(assignments: DraftAssignment[], context: ScheduleContext) {
    const counts = new Map<string, number>();
    for (const a of assignments) counts.set(a.taskId, (counts.get(a.taskId) || 0) + 1);

    return context.tasks
      .filter((t) => {
        const needed = t.requiredHeadcount - t.currentAssignments;
        return (counts.get(t.id) || 0) < needed;
      })
      .map((t) => ({
        taskId: t.id, taskTitle: t.title,
        reason: `${counts.get(t.id) || 0} of ${t.requiredHeadcount - t.currentAssignments} filled`,
      }));
  }

  private buildSummary(
    assignments: DraftAssignment[],
    unfilledTasks: { taskId: string; taskTitle: string; reason: string }[],
    context: ScheduleContext
  ): DraftSchedule {
    const hoursMap = new Map<string, number>();
    for (const a of assignments) {
      const task = context.tasks.find((t) => t.id === a.taskId);
      if (task) {
        const duration = (task.scheduledEnd.getTime() - task.scheduledStart.getTime()) / 3600000;
        hoursMap.set(a.staffName, (hoursMap.get(a.staffName) || 0) + duration);
      }
    }

    return {
      // Overridden by generateWithAI when a model produced the draft. The
      // default is correct for the algorithmic path, which is the only other
      // caller.
      provider: "algorithmic",
      assignments,
      unfilledTasks,
      summary: {
        totalTasks: context.tasks.length,
        totalAssignments: assignments.length,
        totalUnfilled: unfilledTasks.length,
        hoursDistribution: Array.from(hoursMap.entries())
          .map(([name, hours]) => ({ name, hours: Math.round(hours) }))
          .sort((a, b) => b.hours - a.hours),
      },
    };
  }

  private async callGroq(prompt: string): Promise<string> {
    /*
     * Guarded and bounded, matching every other provider call in the codebase.
     *
     * This one checked nothing: with no key configured it sent `Bearer
     * undefined` to Groq and then `?key=undefined` to Gemini — two real
     * outbound round-trips before the deterministic scheduler ran. And with no
     * timeout, a hung connection meant `generateAlgorithmic` — a complete
     * working scheduler sitting right there — was never reached at all.
     */
    if (!hasApiKey(process.env.GROQ_API_KEY)) {
      throw new Error("Groq API key not configured");
    }
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: aiTimeoutSignal(),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: "llama-3.1-8b-instant", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 2000 }),
    });
    if (!res.ok) throw new Error(`Groq error: ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  private async callGemini(prompt: string): Promise<string> {
    // See `callGroq` above — same guard, same bound, same reason.
    if (!hasApiKey(process.env.GEMINI_API_KEY)) {
      throw new Error("Gemini API key not configured");
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        signal: aiTimeoutSignal(),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 2000 } }),
      }
    );
    if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  /**
   * Writes a confirmed draft.
   *
   * `draftProvider` is echoed back by the client, so it is a claim rather than
   * a fact — it is validated against the known provider names and otherwise
   * dropped. Worth being explicit about: `allocationSource` here IS
   * trustworthy, because reaching this method at all means the auto-schedule
   * confirm endpoint ran. Only the model attribution is caller-asserted, and
   * the worst a caller can do is mislabel its own organisation's chart.
   */
  async confirmSchedule(
    organizationId: string,
    assignments: DraftAssignment[],
    confirmedById: string,
    draftProvider?: string,
    /**
     * The caller's departments, or null for a company admin.
     *
     * The draft is client-supplied, so scoping the GENERATE call alone would be
     * theatre — a scoped manager could post rows for any task in the
     * organisation. Refused as "rejected" alongside the cross-tenant rows,
     * which is the same answer for the same reason.
     */
    departmentScope?: string[] | null
  ) {
    const provider =
      draftProvider && (AI_PROVIDERS as readonly string[]).includes(draftProvider)
        ? draftProvider
        : undefined;

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    const assignmentStatus = settings.taskAcceptanceMode === "auto_accept" ? "accepted" : "pending";

    // The draft comes back from the client, so every id in it is caller-supplied
    // and must be re-checked against this organisation before anything is
    // written. Without this an admin of org A could post org B's taskId and
    // membershipId and create a real assignment inside org B — the per-row catch
    // below would even keep the response 200. Both sets are loaded once rather
    // than per row to keep this O(1) queries instead of O(n).
    const draftTaskIds = [...new Set(assignments.map((d) => d.taskId))];
    const draftMembershipIds = [...new Set(assignments.map((d) => d.membershipId))];
    const [ownTasks, ownMembers] = await Promise.all([
      this.taskRepo.findManyByIdsInOrg(draftTaskIds, organizationId),
      this.membershipRepo.findManyByIdsInOrg(draftMembershipIds, organizationId),
    ]);
    /*
     * Scope, and then state.
     *
     * A draft is generated from tasks with `status: "open"`, but it is confirmed
     * later — sometimes days later — and a shift cancelled in between is still
     * named in the draft rows the client sends back. Dropping it here rather
     * than writing the assignment matches `assignStaff`, which refuses the same
     * thing on the single-assignment path; the two used to disagree, and this
     * is exactly the window where the disagreement showed.
     *
     * Filtered out rather than reported as a rejection: the shift being called
     * off is not something the manager confirming the week did wrong, and it
     * would land in a list headed as refusals.
     */
    const inScopeTasks = (
      departmentScope === undefined || departmentScope === null
        ? ownTasks
        : ownTasks.filter((t) =>
            isDepartmentInScope(t.departmentId, departmentScope)
          )
    ).filter((t) => acceptsAssignments(t.status));
    const ownTaskIds = new Set(inScopeTasks.map((t) => t.id));
    const ownMemberIds = new Set(ownMembers.map((m) => m.id));
    const taskById = new Map(inScopeTasks.map((t) => [t.id, t]));

    /*
     * Headcount, re-checked here rather than trusted from the draft.
     *
     * This is the one write path that never went through `assignStaff`, so it
     * was also the one place over-assignment was reachable: a stale draft
     * generated before someone else filled the shift, or a tampered one, wrote
     * as many rows as it carried. Seeded from what is actually on the task now
     * and decremented as rows land, so concurrent drafts cannot both spend the
     * same slot.
     */
    const headcount = new Map(inScopeTasks.map((t) => [t.id, t.requiredHeadcount]));
    const slotsLeft = new Map<string, number>();
    await Promise.all(
      [...ownTaskIds].map(async (taskId) => {
        const taken = await this.assignmentRepo.countActiveByTaskId(taskId);
        slotsLeft.set(taskId, (headcount.get(taskId) ?? 0) - taken);
      })
    );

    /*
     * Composition rules, re-checked here for the same reason headcount is.
     *
     * The draft is generated with these in mind, so in the ordinary case this
     * refuses nothing. It is not therefore redundant: the draft round-trips
     * through the browser, so it can be stale — someone else filled the shift,
     * or a rule changed, between generating and confirming — or edited outright.
     * This is the only write path that never passes through `assignStaff`, and
     * without the check it was the one place a roster the manual path refuses
     * could be written.
     *
     * Only tasks that actually carry rules are loaded, which is why
     * `findManyByIdsInOrg` returns the column.
     */
    const gates = new Map<string, CompositionGate>();
    await Promise.all(
      inScopeTasks
        .filter((t) => parseCompositionRules(t.compositionRules).length > 0)
        .map(async (t) => {
          const data = await this.compositionService.buildGateData(t.id, [
            ...ownMemberIds,
          ]);
          if (data) {
            gates.set(
              t.id,
              openCompositionGate(
                data.rules,
                data.assigned,
                data.requiredHeadcount,
                data.byMembership
              )
            );
          }
        })
    );

    /*
     * Person-level constraints, re-checked here for the same reason headcount
     * and composition are.
     *
     * Those two were re-read from live state; conflicts, hour limits, rest gaps
     * and availability were not — they were evaluated once, when the draft was
     * built. So two drafts made from the same starting state could each put one
     * person on a different overlapping shift, and both would write: the slots
     * were different, the composition fine, and the clash invisible because
     * neither draft knew about the other. Sequential runs had the milder
     * version of it, where leave approved between generating and confirming no
     * longer removed anybody.
     *
     * One engine call per DISTINCT TASK, not per row, with the memo and the
     * provisional map threaded exactly as the generate path does — so the cost
     * matches drafting, and `tests/services/eligibility-query-count.test.ts`
     * keeps holding.
     */
    /*
     * Project Team staffing, re-checked here for the same reason the three
     * above are.
     *
     * The draft is built from team members only, so in the ordinary case this
     * removes nobody. It is not therefore redundant: this is the one write
     * path that never passes through `assignStaff`, so the gate that refuses
     * an outsider on the manual path never runs here — and the draft the
     * client posts back can name anyone. Every other way onto a project work
     * item asks this question; confirm did not, which made it the way round.
     *
     * One batched read for the whole draft, keyed by project, rather than a
     * lookup per task: a week of work items usually belongs to a handful of
     * projects, and most belong to none at all.
     */
    const projectTeams = await this.projectRepo.findTeamRestrictions(
      inScopeTasks.map((task) => task.projectId),
      organizationId
    );

    const hoursCache: CommittedAssignmentsCache = new Map();
    const provisional: ProvisionalAssignments = new Map();
    const eligibleByTask = new Map<string, Set<string>>();
    const eligibleFor = async (taskId: string) => {
      const cached = eligibleByTask.get(taskId);
      if (cached) return cached;
      const verdicts = await this.eligibilityService.checkEligibilityForTask(
        taskId,
        organizationId,
        provisional,
        hoursCache
      );
      const projectId = taskById.get(taskId)?.projectId;
      const team = projectId ? (projectTeams.get(projectId) ?? null) : null;
      const ok = new Set(
        verdicts
          .filter((v) => v.eligible && isAllowedByProjectTeam(team, v.membershipId))
          .map((v) => v.membershipId)
      );
      eligibleByTask.set(taskId, ok);
      return ok;
    };

    // A draft naming the same person on the same task twice cannot produce two
    // rows — `(taskId, membershipId)` is unique — so the second is dropped
    // here instead of becoming a swallowed constraint error below.
    const seenPairs = new Set<string>();

    const created = [];
    const rejected: string[] = [];
    const overCapacity: string[] = [];
    const brokeComposition: string[] = [];
    const noLongerEligible: string[] = [];
    let duplicates = 0;
    let writeErrors = 0;
    for (const draft of assignments) {
      if (!ownTaskIds.has(draft.taskId) || !ownMemberIds.has(draft.membershipId)) {
        rejected.push(draft.taskId);
        console.error(
          `[Auto-Schedule] Refused cross-tenant draft row: task=${draft.taskId} membership=${draft.membershipId} org=${organizationId}`
        );
        continue;
      }
      const pair = `${draft.taskId}|${draft.membershipId}`;
      if (seenPairs.has(pair)) {
        duplicates++;
        continue;
      }
      seenPairs.add(pair);

      if ((slotsLeft.get(draft.taskId) ?? 0) <= 0) {
        overCapacity.push(draft.taskId);
        continue;
      }

      const gate = gates.get(draft.taskId);
      if (gate && !gate.admit(draft.membershipId)) {
        // The same escape hatch `assignStaff` offers: a manager who documented
        // a reason may proceed. Looked up only for a row the gate turned away,
        // so the ordinary path costs nothing.
        const overridden = (
          await Promise.all([
            this.overrideRepo.hasOverride(
              draft.taskId,
              draft.membershipId,
              "composition"
            ),
            this.overrideRepo.hasOverride(
              draft.taskId,
              draft.membershipId,
              "all"
            ),
          ])
        ).some(Boolean);

        if (!overridden) {
          brokeComposition.push(draft.taskId);
          continue;
        }
        // Recorded even though the rule refused them, because they are about to
        // be on the shift and later rows must be judged against the roster as
        // it will really be. (If the write below then fails, the gate is one
        // person pessimistic for the rest of this task — which can only refuse
        // more, never admit something illegal.)
        gate.force(draft.membershipId);
      }

      /*
       * Deliberately AFTER the composition gate, so a row refused by both is
       * reported under the rule that is easier to act on. An eligibility
       * override is honoured by `checkEligibilityForTask` itself, so a manager
       * who documented a reason still gets through here without a second
       * escape hatch.
       */
      if (!(await eligibleFor(draft.taskId)).has(draft.membershipId)) {
        noLongerEligible.push(draft.taskId);
        continue;
      }

      try {
        const assignment = await this.assignmentRepo.create({
          taskId: draft.taskId, membershipId: draft.membershipId,
          assignedById: confirmedById, status: assignmentStatus,
          allocationSource: "auto_scheduled",
          allocationProvider: provider,
        });
        created.push(assignment);
        slotsLeft.set(draft.taskId, (slotsLeft.get(draft.taskId) ?? 1) - 1);

        /*
         * This row is now part of the roster the remaining rows are judged
         * against — without it, a draft naming one person for two overlapping
         * shifts would pass both checks, because each was evaluated against a
         * database that did not yet contain the other.
         *
         * The memo for OTHER tasks is cleared rather than the whole map,
         * because a verdict computed before this write no longer accounts for
         * it. This task's own entry stays: `checkEligibilityForTask` excludes
         * the task under evaluation from its own conflict and hours checks, so
         * the remaining rows on this shift are unaffected by it.
         */
        const task = taskById.get(draft.taskId);
        if (task?.scheduledStart && task?.scheduledEnd) {
          const existing = provisional.get(draft.membershipId) ?? [];
          existing.push({
            start: task.scheduledStart,
            end: task.scheduledEnd,
            title: task.title ?? draft.taskTitle,
          });
          provisional.set(draft.membershipId, existing);
        }
        for (const key of [...eligibleByTask.keys()]) {
          if (key !== draft.taskId) eligibleByTask.delete(key);
        }

        const member = await this.membershipRepo.findById(draft.membershipId);
        if (member) {
          void this.notificationService.notify(
            organizationId, member.userId, NOTIFICATION_TYPES.TASK_ASSIGNED,
            "New task assignment", `You've been assigned to "${draft.taskTitle}"`,
            "assignment", draft.taskId
          );
        }
      } catch (error) {
        writeErrors++;
        console.error(`[Auto-Schedule] Failed: ${draft.staffName} → ${draft.taskTitle}:`, error);
      }
    }

    await this.auditService.log({
      organizationId, userId: confirmedById,
      action: ACTIONS.TASK_ASSIGNED, entityType: "assignment",
      details: { assignmentsCreated: created.length, totalPlanned: assignments.length, status: assignmentStatus, rejectedCrossTenant: rejected.length, skippedOverCapacity: overCapacity.length, skippedComposition: brokeComposition.length, skippedIneligible: noLongerEligible.length, allocationProvider: provider ?? null },
    });

    /*
     * `failed` stays "everything that did not get written", which is what the
     * caller has always been told. The rest of the fields break that number
     * down into reasons that need different responses — a write error is a
     * database problem worth retrying, a composition skip is a roster the rules
     * refuse, and a cross-tenant rejection means the draft carried a row it
     * should never have had.
     *
     * They partition it exactly:
     *   failed === rejected + overCapacity + brokeComposition + ineligible
     *             + duplicates + writeErrors
     * which is worth asserting in a test — a category added later without a
     * counter would silently disappear into `failed` otherwise. `ineligible`
     * is that category: the person-level re-check refuses rows the draft
     * believed were fine, and without its own counter those would have looked
     * like unexplained write failures.
     */
    return {
      created: created.length,
      failed: assignments.length - created.length,
      rejected: rejected.length,
      overCapacity: overCapacity.length,
      brokeComposition: brokeComposition.length,
      ineligible: noLongerEligible.length,
      duplicates,
      writeErrors,
    };
  }
}
