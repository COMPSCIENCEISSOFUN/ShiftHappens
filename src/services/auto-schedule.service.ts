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
import {
  DEFAULT_TIMEZONE,
} from "@/lib/timezone";
import {
  EligibilityService,
  type ProvisionalAssignments,
  type CommittedAssignmentsCache,
} from "@/services/eligibility.service";

interface StaffInfo {
  membershipId: string;
  userId: string;
  name: string;
  role: string;
  departments: string[];
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

interface ScheduleContext {
  tasks: TaskInfo[];
  staff: StaffInfo[];
  workRules: { name: string; type: string; maxHours?: number | null; hoursThreshold?: number | null; breakHours?: number | null }[];
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
  private auditService = new AuditLogService();
  private notificationService = new NotificationService();

  async collectWeekData(organizationId: string, weekStart: Date): Promise<ScheduleContext> {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const allTasks = await this.taskRepo.findByOrganizationId(organizationId, { status: "open" });

    const tasks: TaskInfo[] = [];
    for (const task of allTasks) {
      if (!task.scheduledStart || !task.scheduledEnd) continue;
      const start = new Date(task.scheduledStart);
      const end = new Date(task.scheduledEnd);
      if (start >= weekEnd || end <= weekStart) continue;

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
      });
    }

    const members = await this.membershipRepo.findSchedulableStaff(organizationId);

    const staff: StaffInfo[] = [];
    for (const member of members) {
      const availability = await this.availRepo.getWeeklySchedule(member.id);
      const certs = await this.certRepo.getValidCertifications(member.id);

      const assignments = await this.assignmentRepo.findClockedWithinWindow(
        member.id,
        weekStart,
        weekEnd
      );

      let hoursThisWeek = 0;
      for (const a of assignments) {
        if (a.clockInTime && a.clockOutTime) {
          hoursThisWeek += (a.clockOutTime.getTime() - a.clockInTime.getTime()) / 3600000;
        }
      }

      staff.push({
        membershipId: member.id,
        userId: member.user.id,
        name: member.user.name || member.user.email,
        role: member.role,
        departments: member.departmentMemberships.map((dm) => dm.department.name),
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

    return {
      tasks: tasks.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)),
      staff,
      workRules: rules.map((r) => ({
        name: r.name, type: r.type, maxHours: r.maxHours,
        hoursThreshold: r.hoursThreshold, breakHours: r.breakHours,
      })),
    };
  }

  async generateSchedule(organizationId: string, weekStart: Date): Promise<DraftSchedule> {
    const context = await this.collectWeekData(organizationId, weekStart);

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

    /** How many slots this week actually needs filling. */
    const demand = context.tasks.reduce(
      (n, t) => n + Math.max(0, t.requiredHeadcount - t.currentAssignments),
      0
    );

    let aiDraft: DraftSchedule | null = null;
    try {
      aiDraft = await this.generateWithAI(context, organizationId, hoursCache);
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
      hoursCache
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
    hoursCache: CommittedAssignmentsCache
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
        .filter((v) => v.eligible && !settled.has(v.membershipId))
        .map((v) => v.membershipId)
    );
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
    sharedHoursCache?: CommittedAssignmentsCache
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

    for (const task of context.tasks) {
      const slotsNeeded = task.requiredHeadcount - task.currentAssignments;
      if (slotsNeeded <= 0) continue;

      const taskDuration =
        (task.scheduledEnd.getTime() - task.scheduledStart.getTime()) / 3600000;
      const eligible = await this.eligibleFor(
        task.id,
        organizationId,
        provisional,
        hoursCache
      );

      const candidates = context.staff
        .filter((s) => eligible.has(s.membershipId))
        .map((s) => {
          const hours = cumulativeHours.get(s.membershipId) || 0;
          const inDepartment = task.departmentName
            ? s.departments.includes(task.departmentName)
            : false;
          return {
            ...s,
            score: 100 - Math.min(hours, 100) + (inDepartment ? 25 : 0) + 25,
            hours,
            inDepartment,
          };
        })
        .sort((a, b) => b.score - a.score);

      const assignedToThisTask: DraftAssignment[] = [];
      for (let i = 0; i < candidates.length && assignedToThisTask.length < slotsNeeded; i++) {
        const c = candidates[i];
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
        unfilledTasks.push({
          taskId: task.id,
          taskTitle: task.title,
          reason: `${assignedToThisTask.length} of ${slotsNeeded} filled — no eligible staff remaining`,
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
    sharedHoursCache?: CommittedAssignmentsCache
  ): Promise<DraftAssignment[]> {
    const byTask = new Map<string, DraftAssignment[]>();
    for (const p of proposals) {
      byTask.set(p.taskId, [...(byTask.get(p.taskId) ?? []), p]);
    }

    const accepted: DraftAssignment[] = [];
    const provisional: ProvisionalAssignments = new Map();
    const hoursCache: CommittedAssignmentsCache = sharedHoursCache ?? new Map();

    for (const task of context.tasks) {
      const proposed = byTask.get(task.id);
      if (!proposed || proposed.length === 0) continue;

      const eligible = await this.eligibleFor(
        task.id,
        organizationId,
        provisional,
        hoursCache
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
    hoursCache: CommittedAssignmentsCache
  ): Promise<DraftSchedule> {
    const { prompt, taskMap, staffMap } = this.buildAIPrompt(context);

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
      hoursCache
    );
    return { ...draft, provider };
  }

  /**
   * Builds AI prompt using simple indices instead of database IDs.
   * Returns the prompt plus mapping dictionaries to convert back.
   */
  private buildAIPrompt(context: ScheduleContext): {
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
      const day = t.scheduledStart.toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: DEFAULT_TIMEZONE,
      });
      const start = t.scheduledStart.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: DEFAULT_TIMEZONE,
      });
      const end = t.scheduledEnd.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: DEFAULT_TIMEZONE,
      });
      const certs = t.requiredCertifications.length > 0
        ? `, REQUIRES certs: ${t.requiredCertifications.join(", ")}`
        : "";
      return `  Task ${num}: "${t.title}" (${t.departmentName || "no dept"}, ${t.priority}, needs ${t.requiredHeadcount - t.currentAssignments} staff, ${day} ${start}-${end}${certs})`;
    }).join("\n");

    const staffLines = context.staff.map((s, i) => {
      const label = STAFF_LABELS[i] || `S${i}`;
      staffMap.set(label, s.membershipId);
      const avail = s.availability
        .filter((a) => a.isAvailable)
        .map((a) => {
          const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
          return `${days[a.dayOfWeek]} ${a.startTime}-${a.endTime}`;
        }).join(", ");
      return `  Staff ${label}: ${s.name} (${s.departments.join("/") || "no dept"}, ${Math.round(s.hoursThisWeek)}h worked, certs: ${s.certifications.join(", ") || "none"}, available: ${avail || "none"})`;
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

PREFERENCES — apply these only among staff who satisfy every hard rule:
6. Distribute hours fairly — prefer staff with fewer hours worked.

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
    hoursCache: CommittedAssignmentsCache
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
      hoursCache
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
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: "llama-3.1-8b-instant", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 2000 }),
    });
    if (!res.ok) throw new Error(`Groq error: ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  private async callGemini(prompt: string): Promise<string> {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
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
    draftProvider?: string
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
    const ownTaskIds = new Set(ownTasks.map((t) => t.id));
    const ownMemberIds = new Set(ownMembers.map((m) => m.id));

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
    const headcount = new Map(ownTasks.map((t) => [t.id, t.requiredHeadcount]));
    const slotsLeft = new Map<string, number>();
    await Promise.all(
      [...ownTaskIds].map(async (taskId) => {
        const taken = await this.assignmentRepo.countActiveByTaskId(taskId);
        slotsLeft.set(taskId, (headcount.get(taskId) ?? 0) - taken);
      })
    );

    // A draft naming the same person on the same task twice cannot produce two
    // rows — `(taskId, membershipId)` is unique — so the second is dropped
    // here instead of becoming a swallowed constraint error below.
    const seenPairs = new Set<string>();

    const created = [];
    const rejected: string[] = [];
    const overCapacity: string[] = [];
    for (const draft of assignments) {
      if (!ownTaskIds.has(draft.taskId) || !ownMemberIds.has(draft.membershipId)) {
        rejected.push(draft.taskId);
        console.error(
          `[Auto-Schedule] Refused cross-tenant draft row: task=${draft.taskId} membership=${draft.membershipId} org=${organizationId}`
        );
        continue;
      }
      const pair = `${draft.taskId}|${draft.membershipId}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);

      if ((slotsLeft.get(draft.taskId) ?? 0) <= 0) {
        overCapacity.push(draft.taskId);
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

        const member = await this.membershipRepo.findById(draft.membershipId);
        if (member) {
          void this.notificationService.notify(
            organizationId, member.userId, NOTIFICATION_TYPES.TASK_ASSIGNED,
            "New task assignment", `You've been assigned to "${draft.taskTitle}"`,
            "assignment", draft.taskId
          );
        }
      } catch (error) {
        console.error(`[Auto-Schedule] Failed: ${draft.staffName} → ${draft.taskTitle}:`, error);
      }
    }

    await this.auditService.log({
      organizationId, userId: confirmedById,
      action: ACTIONS.TASK_ASSIGNED, entityType: "auto-schedule",
      details: { assignmentsCreated: created.length, totalPlanned: assignments.length, status: assignmentStatus, rejectedCrossTenant: rejected.length, skippedOverCapacity: overCapacity.length, allocationProvider: provider ?? null },
    });

    return {
      created: created.length,
      failed: assignments.length - created.length,
      rejected: rejected.length,
      overCapacity: overCapacity.length,
    };
  }
}