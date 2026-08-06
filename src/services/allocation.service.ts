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
import { FallbackRanker } from "./fallback-ranker";
import type {
  AIProvider,
  StaffCandidate,
  RankedStaff,
  RankingResult,
} from "./ai-provider";
import { GroqProvider } from "./providers/groq.provider";
import { GeminiProvider } from "./providers/gemini.provider";
import { EligibilityService } from "./eligibility.service";
import { CertificationRepository } from "@/repositories/certification.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { TaskService } from "./task.service";

export class AllocationService {
  private providers: AIProvider[];
  private eligibilityService = new EligibilityService();
  private certRepo = new CertificationRepository();
  private settingsRepo = new SettingsRepository();
  private taskRepo = new TaskRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private availRepo = new AvailabilityRepository();
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
    candidates: Parameters<AIProvider["rankStaff"]>[1]
  ): Promise<RankingResult> {
    for (const provider of this.providers) {
      try {
        const rankings = await provider.rankStaff(task, candidates);
        return { rankings, provider: provider.name };
      } catch (error) {
        console.error("[AI Failover] Provider failed, trying next:", error);
      }
    }

    console.error("[AI Failover] All providers failed, using algorithmic ranking");
    return { rankings: FallbackRanker.rank(candidates), provider: "algorithmic" };
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
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== organizationId) throw new Error("Task not found");

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
     * This was a hand-written list of four statuses, which is how
     * `decline_requested` came to be missing from it: a full-time member with a
     * pending decline was still on the shift and would have been suggested for
     * it again.
     *
     * It matters more than it looks because eligibility deliberately INCLUDES
     * people already assigned, so that their commitments can still be
     * validated. That widening is about checking, not proposing; without this
     * filter it leaks into the suggestion path.
     */
    const settledMembershipIds = new Set(
      task.assignments.map((a) => a.membershipId)
    );

    const eligibleStaff = eligibility
      .filter((e) => e.eligible)
      .filter((e) => !settledMembershipIds.has(e.membershipId));

    if (eligibleStaff.length === 0) {
      // No candidates means no strategy ran. Reporting a provider here would
      // put a phantom row in the AI-vs-fallback split for work never done.
      return { rankings: [], provider: "algorithmic" };
    }

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    const candidates: StaffCandidate[] = [];

    for (const staff of eligibleStaff) {
      const candidate = await this.buildCandidate(
        staff.membershipId,
        staff.memberName,
        settings.breakRuleHoursWorked,
        task.departmentId
      );
      candidates.push(candidate);
    }

    return this.rankWithFailover(
      {
        title: task.title,
        department: task.department?.name || null,
        priority: task.priority,
        scheduledStart: task.scheduledStart?.toISOString() || null,
        scheduledEnd: task.scheduledEnd?.toISOString() || null,
        requiredHeadcount: task.requiredHeadcount,
      },
      candidates
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
    const candidates = await this.buildCandidatePool(taskId, organizationId);
    if (candidates.length === 0) {
      return { rankings: [], provider: "algorithmic" };
    }
    return {
      rankings: FallbackRanker.rank(candidates),
      provider: "algorithmic",
    };
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
  ): Promise<StaffCandidate[]> {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== organizationId) {
      throw new Error("Task not found");
    }

    const eligibility = await this.eligibilityService.checkEligibilityForTask(
      taskId,
      organizationId
    );
    const settled = new Set(task.assignments.map((a) => a.membershipId));
    const eligibleStaff = eligibility
      .filter((e) => e.eligible)
      .filter((e) => !settled.has(e.membershipId));

    if (eligibleStaff.length === 0) return [];

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    const candidates: StaffCandidate[] = [];
    for (const staff of eligibleStaff) {
      candidates.push(
        await this.buildCandidate(
          staff.membershipId,
          staff.memberName,
          settings.breakRuleHoursWorked,
          task.departmentId
        )
      );
    }
    return candidates;
  }

  /**
   * Auto-allocates staff to a task.
   * Gets AI rankings and assigns top N based on requiredHeadcount.
   */
  async autoAllocate(
    taskId: string,
    organizationId: string,
    assignedById: string
  ) {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== organizationId) throw new Error("Task not found");

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    if (settings.allocationMode !== "auto") {
      throw new Error("Auto allocation is not enabled");
    }

    const { rankings, provider } = await this.getRankedSuggestions(
      taskId,
      organizationId
    );

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
    departmentId: string | null
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
    };
  }
}