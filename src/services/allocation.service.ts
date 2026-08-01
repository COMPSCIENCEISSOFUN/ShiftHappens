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
import type { AIProvider, StaffCandidate, RankedStaff } from "./ai-provider";
import { GroqProvider } from "./providers/groq.provider";
import { GeminiProvider } from "./providers/gemini.provider";
import { EligibilityService } from "./eligibility.service";
import { CertificationRepository } from "@/repositories/certification.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { TaskService } from "./task.service";
import { prisma } from "@/lib/prisma";

export class AllocationService {
  private providers: AIProvider[];
  private eligibilityService = new EligibilityService();
  private certRepo = new CertificationRepository();
  private settingsRepo = new SettingsRepository();
  private taskRepo = new TaskRepository();
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
   */
  private async rankWithFailover(
    task: Parameters<AIProvider["rankStaff"]>[0],
    candidates: Parameters<AIProvider["rankStaff"]>[1]
  ): Promise<RankedStaff[]> {
    for (const provider of this.providers) {
      try {
        const result = await provider.rankStaff(task, candidates);
        return result;
      } catch (error) {
        console.error("[AI Failover] Provider failed, trying next:", error);
      }
    }

    console.error("[AI Failover] All providers failed, using algorithmic ranking");
    return FallbackRanker.rank(candidates);
  }

  /**
   * Gets AI-ranked suggestions for a task.
   * Gathers staff attributes and sends to AI for ranking.
   */
  async getSuggestions(
    taskId: string,
    organizationId: string,
    options?: { excludeMembershipIds?: string[] }
  ): Promise<RankedStaff[]> {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== organizationId) throw new Error("Task not found");

    const eligibility = await this.eligibilityService.checkEligibilityForTask(
      taskId,
      organizationId
    );

    const excludedMembershipIds = new Set(options?.excludeMembershipIds ?? []);
    const eligibleStaff = eligibility.filter(
      (e) => e.eligible && !excludedMembershipIds.has(e.membershipId)
    );

    if (eligibleStaff.length === 0) {
      return [];
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

    const rankings = await this.rankWithFailover(
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

    // AI output is advisory. Only server-verified candidates may survive, and
    // a provider cannot duplicate or invent membership IDs.
    const eligibleIds = new Set(candidates.map((candidate) => candidate.membershipId));
    const seen = new Set<string>();
    return rankings.filter((ranking) => {
      if (!eligibleIds.has(ranking.membershipId) || seen.has(ranking.membershipId)) {
        return false;
      }
      seen.add(ranking.membershipId);
      return true;
    });
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

    const rankings = await this.getSuggestions(taskId, organizationId);

    // Take top N based on required headcount
    const topN = rankings.slice(0, task.requiredHeadcount);

    if (topN.length === 0) {
      throw new Error("No eligible staff found for auto allocation");
    }

    // Assign the top-ranked staff
    const membershipIds = topN.map((r) => r.membershipId);
    return this.taskService.assignStaff(
      taskId,
      organizationId,
      membershipIds,
      assignedById
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
    const recentAssignments = await prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: ["clocked_out", "completed"] },
        clockInTime: { gte: oneDayAgo },
        clockOutTime: { not: null },
      },
    });

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
    const availability = await prisma.availability.findMany({
      where: { membershipId },
      orderBy: { dayOfWeek: "asc" },
    });
    const availableHours = availability
      .filter((a) => a.isAvailable)
      .map((a) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][a.dayOfWeek]} ${a.startTime}-${a.endTime}`)
      .join(", ") || "Not set";

    // Get department history (how many times assigned to tasks in this dept)
    let departmentHistory = 0;
    if (departmentId) {
      departmentHistory = await prisma.taskAssignment.count({
        where: {
          membershipId,
          task: { departmentId },
          status: { in: ["assigned", "in_progress", "clocked_out", "completed"] },
        },
      });
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
