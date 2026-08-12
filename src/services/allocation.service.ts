/**
 * Allocation Service (Control Layer)
 * 
 * Orchestrates the three allocation modes:
 * 1. Manual — admin picks from eligibility list (handled by existing UI)
 * 2. Suggested — AI ranks eligible staff, admin confirms
 * 3. Auto — AI ranks and assigns top N automatically
 * 
 * Uses the Strategy pattern to swap AI providers.
 * Gathers staff attributes from multiple sources (hours worked,
 * certifications, availability, department history) and sends
 * them to the AI provider for intelligent ranking.
 */
import { FallbackRanker, byRank } from "./fallback-ranker";
import { availabilityFit, certificationRelevance } from "@/lib/ranking-inputs";
import {
  DEFAULT_WEIGHTS,
  describeWeightsForPrompt,
  parseWeights,
  type RankingWeights,
} from "@/lib/ranking-weights";
import type {
  AIProvider,
  StaffCandidate,
  RankedStaff,
  RankingResult,
} from "./ai-provider";
import { GroqProvider } from "./providers/groq.provider";
import { GeminiProvider } from "./providers/gemini.provider";
import { EligibilityService } from "./eligibility.service";
import { isAllowedByProjectTeam } from "@/lib/project-staffing";
import { ProjectRepository } from "@/repositories/project.repository";
import { CertificationRepository } from "@/repositories/certification.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { MembershipRepository } from "@/repositories/membership.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { TaskService } from "./task.service";
import { countOccupied } from "@/lib/assignment-status";

/**
 * How close to a shift automation stops acting on it.
 *
 * The same 48 hours `AvailabilityService` uses for cover, kept as its own
 * constant rather than imported because the two answer different questions —
 * that one is about replacing a person, this one about filling an empty slot —
 * and a shared constant would make a later change to one silently change the
 * other.
 */
const SHORT_NOTICE_MS = 48 * 60 * 60 * 1000;

export class AllocationService {
  private providers: AIProvider[];
  private eligibilityService = new EligibilityService();
  private certRepo = new CertificationRepository();
  private settingsRepo = new SettingsRepository();
  private taskRepo = new TaskRepository();
  private membershipRepo = new MembershipRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private availRepo = new AvailabilityRepository();
  private projectRepo = new ProjectRepository();
  private taskService = new TaskService();

  constructor() {
    const primary = process.env.AI_PROVIDER || "groq";

    if (primary === "gemini") {
      this.providers = [new GeminiProvider(), new GroqProvider()];
    } else {
      this.providers = [new GroqProvider(), new GeminiProvider()];
    }
  }

  /**
   * Tries each AI provider in order. If one fails, falls back to the next.
   * If all fail, uses the algorithmic fallback ranker.
   *
   * Returns which strategy won as well as the ranking. That is the whole
   * change: the failover was previously write-only — a `console.error` on a
   * serverless host nobody reads — so a revoked API key would degrade the
   * product to the algorithmic ranker permanently and silently. The caller can
   * now record it against the assignment.
   */
  private async rankWithFailover(
    task: Parameters<AIProvider["rankStaff"]>[0],
    candidates: Parameters<AIProvider["rankStaff"]>[1],
    /**
     * The organisation's priorities. Reaches the providers as a sentence in the
     * prompt and the fallback as arithmetic — the same intent applied by the
     * two mechanisms each is capable of.
     */
    weights: RankingWeights = DEFAULT_WEIGHTS
  ): Promise<RankingResult> {
    for (const provider of this.providers) {
      try {
        const rankings = await provider.rankStaff(task, candidates);
        return { rankings: byRank(rankings), provider: provider.name };
      } catch (error) {
        console.error("[AI Failover] Provider failed, trying next:", error);
      }
    }

    console.error("[AI Failover] All providers failed, using algorithmic ranking");
    return {
      rankings: FallbackRanker.rank(candidates, weights),
      provider: "algorithmic",
    };
  }

  /**
   * Gets AI-ranked suggestions for a task.
   *
   * Kept returning a bare `RankedStaff[]` because that is what the suggest
   * route and its UI consume. `getRankedSuggestions` is the same work with the
   * provider attached, for callers that go on to persist the decision.
   */
  async getSuggestions(
    taskId: string,
    organizationId: string
  ): Promise<RankedStaff[]> {
    const { rankings } = await this.getRankedSuggestions(taskId, organizationId);
    return rankings;
  }

  /** As `getSuggestions`, but reports which strategy produced the ranking. */
  async getRankedSuggestions(
    taskId: string,
    organizationId: string
  ): Promise<RankingResult> {
    /*
     * The shared builder, which this used NOT to use.
     *
     * It had its own copy of the eligible-and-not-already-assigned filter and
     * its own candidate loop — and the loop passed four arguments where the
     * builder passes six. The two omitted are `departmentCerts` and `shift`,
     * both of which default, so nothing failed: `certificationRelevance` and
     * `availabilityFit` simply returned null for every candidate, the ranker
     * substituted NEUTRAL for both, and HALF the weighted score became a
     * constant on the suggest and auto-allocate paths.
     *
     * `buildCandidatePool`'s own docblock said it existed "so the AI path and
     * the algorithmic path cannot disagree about who is a candidate". The AI
     * path did not call it. The duplication is what drifted, so the fix is to
     * remove the duplicate rather than add the two arguments to it.
     */
    const { task, candidates } = await this.buildCandidatePool(
      taskId,
      organizationId
    );

    if (candidates.length === 0) {
      // No candidates means no strategy ran. Reporting a provider here would
      // put a phantom row in the AI-vs-fallback split for work never done.
      return { rankings: [], provider: "algorithmic" };
    }

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    const weights = parseWeights(settings.smartAllocationWeights);
    return this.rankWithFailover(
      {
        title: task.title,
        department: task.department?.name || null,
        priority: task.priority,
        priorities: describeWeightsForPrompt(weights),
        scheduledStart: task.scheduledStart?.toISOString() || null,
        scheduledEnd: task.scheduledEnd?.toISOString() || null,
        requiredHeadcount: task.requiredHeadcount,
      },
      candidates,
      weights
    );
  }

  /**
   * The same candidate list, ranked WITHOUT calling an AI provider.
   *
   * ## Why a second entry point rather than a flag
   *
   * `getRankedSuggestions` exists because a human asked for a suggestion and is
   * sitting there waiting for it — spending an API call is the point. This one
   * runs off the back of somebody's leave being approved, which is a background
   * consequence, not a request. Routing that through the providers would put an
   * AI call on an event the org does not control the rate of: approve eight
   * requests on a Monday morning and the free tier is gone before anybody opens
   * the assign panel.
   *
   * `FallbackRanker` is not a degraded mode here. It scores hours, availability
   * fit, certifications and department experience — everything the ranking
   * actually needs to name a sensible replacement.
   */
  async rankWithoutAI(
    taskId: string,
    organizationId: string
  ): Promise<RankingResult> {
    const { candidates } = await this.buildCandidatePool(taskId, organizationId);
    if (candidates.length === 0) {
      return { rankings: [], provider: "algorithmic" };
    }
    const settings = await this.settingsRepo.getOrCreate(organizationId);
    return {
      rankings: FallbackRanker.rank(
        candidates,
        parseWeights(settings.smartAllocationWeights)
      ),
      provider: "algorithmic",
    };
  }

  /**
   * A second look at shifts auto mode could not staff the first time.
   *
   * ## Why this exists
   *
   * Auto allocation ran ONCE, when a task was created or generated, and never
   * again. A shift a fortnight out that nobody was eligible for at that moment
   * — because availability had not been entered yet, or a certificate had not
   * been verified — stayed empty until a human noticed. The organisation had
   * asked the system to do its rostering and the system tried once and gave up
   * permanently, which is the difference between an automatic feature and a
   * feature that fires on an event.
   *
   * ## Why it stops 48 hours out
   *
   * The same line `findCover` draws, for a related but not identical reason.
   * There, filling a shift at short notice needs a phone call rather than a
   * notification nobody reads. Here it is narrower: in `auto_accept` mode this
   * ASSIGNS rather than offers, and putting somebody on tomorrow's rota by
   * background job — hours after they last looked at the app — is a surprise
   * the product should not spring. Inside the window the dashboard's
   * understaffed alert is the honest surface, because it faces a human who can
   * pick up the phone.
   *
   * ## Why it says nothing
   *
   * Deliberately silent, and this is the design decision most likely to be
   * questioned. Every one of these shifts was ALREADY reported once, when it
   * was created or generated and could not be filled. A sweep that re-reported
   * the same unfilled shift every hour would not be an alert; it would be the
   * reason somebody turns notifications off, and it would bury the first
   * message that actually said something new. It fills what it can and stays
   * quiet.
   *
   * ## Cost
   *
   * `useAI: false`, for the reason every cron path uses it: the organisation
   * controls neither how often this runs nor how many shifts it covers.
   */
  async staffUnfilled(
    organizationId: string,
    horizonDays = 14
  ): Promise<{ considered: number; filled: number }> {
    const result = { considered: 0, filled: 0 };

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    if (settings.allocationMode !== "auto") return result;

    const now = Date.now();
    const notBefore = now + SHORT_NOTICE_MS;
    const notAfter = now + horizonDays * 24 * 60 * 60 * 1000;

    const tasks = await this.taskRepo.findByOrganizationId(organizationId, {
      status: "open",
    });

    for (const task of tasks) {
      const start = task.scheduledStart?.getTime();
      // An undated task is a backlog item nobody is standing up for, and it has
      // no moment to be "too close to". Left to a human, same as `isShortNotice`
      // treats it.
      if (start === undefined || start < notBefore || start > notAfter) continue;

      /*
       * Counted with the shared rule, never `assignments.length`. A shift
       * everyone rejected has rows and no people on it, and treating those rows
       * as staff is precisely how the dashboard and the reporting layer came to
       * report two different numbers for one shift.
       */
      if (countOccupied(task.assignments) >= task.requiredHeadcount) continue;

      result.considered++;
      try {
        await this.autoAllocate(task.id, organizationId, task.createdById, {
          useAI: false,
        });
        result.filled++;
      } catch (error) {
        // Still nobody. The ordinary outcome, and not worth a line per shift
        // per hour in the log either — only a genuine fault is.
        if (
          !(error instanceof Error) ||
          !error.message.includes("No eligible staff")
        ) {
          console.error(`[Auto Staffing] ${task.id}`, error);
        }
      }
    }

    return result;
  }

  /**
   * Who could take this shift, for a manager deciding whether to let somebody
   * off it.
   *
   * ## Why this is a read and not an assignment
   *
   * A withdrawal request is a QUESTION, and the question underneath it is
   * "can I cover this?". Until now a manager had to leave the decision, open
   * the assign panel and work it out, so in practice they answered without
   * knowing — and the most useful answer this can give is the empty list,
   * which is the one nobody was in a position to see.
   *
   * ## Why the deterministic ranker
   *
   * A manager may open the same decision several times, and this must not cost
   * a provider call each time or stop working when a provider is down. It is
   * also the same ranking `findCover` will use if the request is approved in
   * `auto` mode, so what the manager is shown is what the system would do —
   * rather than a second opinion from a different engine.
   *
   * ## The person asking to leave is not in this list
   *
   * `buildCandidatePool` excludes anyone holding a row on the shift, and a
   * pending request still holds one. That is the whole reason the request has
   * to stay `withdrawal_requested` until it is answered, and the reason an
   * APPROVED withdrawal now keeps its row too — see
   * `TaskAssignmentRepository.withdraw`.
   */
  async coverOptions(
    taskId: string,
    organizationId: string,
    limit = 3
  ): Promise<
    { membershipId: string; name: string; rank: number; score: number }[]
  > {
    /*
     * `rankWithoutAI`, not a second call to the ranker.
     *
     * The first version of this built the pool and invoked `FallbackRanker`
     * itself, which is what `rankWithoutAI` already does — so the preview a
     * manager reads and the ranking that runs when they approve were two
     * implementations of one rule, free to drift on any change to either. The
     * docblock above promises they are the same ranking; this is what makes
     * that true rather than currently true.
     *
     * The pool is built a second time only for the NAMES, which the ranker
     * does not carry. That is one extra read on a manager-initiated action,
     * and the alternative — widening `RankedStaff` — would touch both provider
     * strategies and their tests for a field only this caller wants.
     */
    const { rankings } = await this.rankWithoutAI(taskId, organizationId);
    if (rankings.length === 0) return [];

    const { candidates } = await this.buildCandidatePool(taskId, organizationId);
    const nameOf = new Map(candidates.map((c) => [c.membershipId, c.name]));

    return rankings.slice(0, limit).map((r) => ({
      membershipId: r.membershipId,
      name: nameOf.get(r.membershipId) ?? "A staff member",
      rank: r.rank,
      score: r.score,
    }));
  }

  /**
   * Everybody eligible for a task who does not already have a row on it,
   * built into ranker input.
   *
   * Shared so the AI path and the algorithmic path cannot disagree about who is
   * a candidate — the exclusion of already-assigned members in particular is
   * subtle enough that a second copy would eventually drift.
   */
  private async buildCandidatePool(
    taskId: string,
    organizationId: string
  ): Promise<{
    task: NonNullable<Awaited<ReturnType<TaskRepository["findById"]>>>;
    candidates: StaffCandidate[];
  }> {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== organizationId) {
      throw new Error("Task not found");
    }

    const eligibility = await this.eligibilityService.checkEligibilityForTask(
      taskId,
      organizationId
    );

    /*
     * Anyone who ALREADY HAS a row on this shift is not a candidate.
     *
     * Not a status list. `TaskAssignment` is unique on (taskId, membershipId),
     * so an existing row of any status makes a second assignment impossible —
     * `autoAllocate` would fail on the constraint. And an approved withdrawal
     * DELETES the row rather than storing "withdrawn", so "has a row" is
     * exactly the condition, not a proxy for it.
     *
     * It matters more than it looks because eligibility deliberately INCLUDES
     * people already assigned, so that their commitments can still be
     * validated. That widening is about checking, not proposing; without this
     * filter it leaks into the suggestion path.
     */
    const settled = new Set(task.assignments.map((a) => a.membershipId));
    const projectTeam = await this.projectRepo.findTeamRestriction(
      task.projectId,
      organizationId
    );
    const eligibleStaff = eligibility
      .filter((e) => e.eligible)
      .filter((e) => isAllowedByProjectTeam(projectTeam, e.membershipId))
      .filter((e) => !settled.has(e.membershipId));

    if (eligibleStaff.length === 0) return { task, candidates: [] };

    const settings = await this.settingsRepo.getOrCreate(organizationId);

    /*
     * Loaded ONCE for the pool, not per candidate. It is the same answer for
     * everybody being ranked, and asking per member would put a query on the
     * size of the organisation for a value that cannot differ between them.
     */
    const departmentCerts = await this.taskRepo.requiredCertificationsInDepartment(
      organizationId,
      task.departmentId
    );

    const shift =
      task.scheduledStart && task.scheduledEnd
        ? { start: task.scheduledStart, end: task.scheduledEnd }
        : null;

    /*
     * Loaded once for the pool, same as `departmentCerts` above — one query for
     * everybody rather than one per candidate.
     *
     * A pin is the only signal the engine has about experience gained at
     * another employer, and until this it reached composition rules and nothing
     * else, so the ranking treated an external hire marked Senior as a novice.
     */
    const pinnedSeniority = await this.membershipRepo.getSeniorityOverrides(
      eligibleStaff.map((e) => e.membershipId)
    );

    const candidates: StaffCandidate[] = [];
    for (const staff of eligibleStaff) {
      candidates.push(
        await this.buildCandidate(
          staff.membershipId,
          staff.memberName,
          settings.workingDayHours,
          task.departmentId,
          departmentCerts,
          shift,
          pinnedSeniority[staff.membershipId] ?? null
        )
      );
    }
    return { task, candidates };
  }

  /**
   * Auto-allocates staff to a task.
   * Gets AI rankings and assigns top N based on requiredHeadcount.
   */
  async autoAllocate(
    taskId: string,
    organizationId: string,
    assignedById: string,
    /**
     * `useAI: false` ranks with the deterministic ranker and never calls a
     * provider.
     *
     * For anything the organisation did not personally trigger. A manager
     * pressing Auto-assign chose to spend an AI call; the hourly cron
     * materialising next fortnight's recurring shifts did not, and at one call
     * per unfilled shift per tenant per hour it would be spending them on a
     * schedule nobody set. Same reasoning `findCover` gives for using the
     * algorithmic ranker when it runs off the back of somebody else's decision.
     */
    options?: { useAI?: boolean }
  ) {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== organizationId) throw new Error("Task not found");

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    if (settings.allocationMode !== "auto") {
      throw new Error("Auto allocation is not enabled");
    }

    const { rankings, provider } =
      options?.useAI === false
        ? await this.rankWithoutAI(taskId, organizationId)
        : await this.getRankedSuggestions(taskId, organizationId);

    // Take top N based on required headcount
    const topN = rankings.slice(0, task.requiredHeadcount);

    if (topN.length === 0) {
      throw new Error("No eligible staff found for auto allocation");
    }

    // Assign the top-ranked staff, recording what the engine thought of each
    // one. Without this the rank and score are computed and thrown away, and
    // "did the engine's first choice work out?" becomes unanswerable.
    return this.taskService.assignStaff(
      taskId,
      organizationId,
      topN.map((r) => r.membershipId),
      assignedById,
      {
        source: "ai_suggested",
        provider,
        byMembership: Object.fromEntries(
          topN.map((r) => [r.membershipId, { rank: r.rank, score: r.score }])
        ),
      }
    );
  }

  /**
   * Builds a StaffCandidate object with all attributes
   * needed for AI ranking.
   */
  private async buildCandidate(
    membershipId: string,
    name: string,
    maxHours: number,
    departmentId: string | null,
    /** Certifications any task in this department asks for. Empty = none. */
    departmentCerts: string[] = [],
    /** The shift being filled, or null when it has no scheduled time. */
    shift: { start: Date; end: Date } | null = null,
    /** A manager's manual seniority level, or null. Floors the experience score. */
    pinnedSeniority: string | null = null
  ): Promise<StaffCandidate> {
    // Get hours worked in last 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentAssignments = await this.assignmentRepo.findWorkedSince(
      membershipId,
      oneDayAgo
    );

    let hoursWorkedToday = 0;
    for (const a of recentAssignments) {
      if (a.clockInTime && a.clockOutTime) {
        hoursWorkedToday +=
          (a.clockOutTime.getTime() - a.clockInTime.getTime()) / (1000 * 60 * 60);
      }
    }

    // Get valid certifications
    const certs = await this.certRepo.getValidCertifications(membershipId);
    const certNames = certs.map((c) => c.name);

    // Get availability summary
    const availability = await this.availRepo.getWeeklySchedule(membershipId);
    const availableHours = availability
      .filter((a) => a.isAvailable)
      .map((a) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][a.dayOfWeek]} ${a.startTime}-${a.endTime}`)
      .join(", ") || "Not set";

    // Get department history (how many times assigned to tasks in this dept)
    let departmentHistory = 0;
    if (departmentId) {
      departmentHistory = await this.assignmentRepo.countDepartmentHistory(
        membershipId,
        departmentId
      );
    }

    return {
      membershipId,
      name,
      hoursWorkedToday: Math.round(hoursWorkedToday * 10) / 10,
      maxHours,
      certifications: certNames,
      availableHours,
      departmentHistory,
      pinnedSeniority,
      availabilityFit: availabilityFit(availability, shift),
      certificationRelevance: certificationRelevance(certNames, departmentCerts),
    };
  }
}
