/**
 * Allocation Service (Control Layer)
 * 
 * Orchestrates the two allocation modes:
 * 1. Manual: a manager picks from the ranked eligible list.
 * 2. Auto: ranking selects and assigns the top eligible staff automatically.
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
import { SettingsRepository } from "@/repositories/settings.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { TaskService } from "./task.service";
import { prisma } from "@/lib/prisma";
import { parseAllocationWeights, type AllocationWeights } from "@/lib/allocation-weights";
import {
  getProjectTeamRestriction,
  isAllowedByProjectTeam,
} from "@/lib/project-staffing";

export class AllocationService {
  private providers: AIProvider[];
  private eligibilityService = new EligibilityService();
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
    candidates: Parameters<AIProvider["rankStaff"]>[1],
    weights: AllocationWeights
  ): Promise<RankedStaff[]> {
    for (const provider of this.providers) {
      try {
        const result = await provider.rankStaff(task, candidates, weights);
        return result;
      } catch (error) {
        console.error("[AI Failover] Provider failed, trying next:", error);
      }
    }

    console.error("[AI Failover] All providers failed, using algorithmic ranking");
    return FallbackRanker.rank(candidates, weights);
  }

  /**
   * Gets AI-ranked suggestions for a task.
   * Gathers staff attributes and sends to AI for ranking.
   */
  async getSuggestions(
    taskId: string,
    organizationId: string,
    options?: {
      excludeMembershipIds?: string[];
    }
  ): Promise<RankedStaff[]> {
    const task =
      await this.taskRepo.findById(
        taskId
      );

    if (
      !task ||
      task.organizationId !==
        organizationId
    ) {
      throw new Error(
        "Task not found"
      );
    }

    const eligibility =
      await this.eligibilityService.checkEligibilityForTask(
        taskId,
        organizationId
      );

    const excludedMembershipIds =
      new Set(
        options?.excludeMembershipIds ??
          []
      );

    /*
    * Project Team Mode:
    *
    * The Project Team is a persistent
    * candidate pool.
    *
    * Normal eligibility STILL runs first.
    * Being on the team never bypasses:
    *
    * - availability
    * - schedule conflicts
    * - hour limits
    * - certifications
    * - department rules
    *
    * It only narrows WHO may be ranked.
    */
    const projectTeam =
      await getProjectTeamRestriction(
        task.projectId,
        organizationId
      );

    const eligibleStaff =
      eligibility.filter((entry) => {
        if (!entry.eligible) {
          return false;
        }

        if (
          excludedMembershipIds.has(
            entry.membershipId
          )
        ) {
          return false;
        }

        /*
        * task_based project:
        * no restriction.
        *
        * project_team project:
        * only team members survive.
        */
        if (
          !isAllowedByProjectTeam(
            projectTeam,
            entry.membershipId
          )
        ) {
          return false;
        }

        return true;
      });

    if (
      eligibleStaff.length === 0
    ) {
      return [];
    }

    const settings =
      await this.settingsRepo.getOrCreate(
        organizationId
      );

    const weights =
      parseAllocationWeights(
        settings.smartAllocationWeights
      );

    const candidates =
      await this.buildCandidates(
        eligibleStaff.map(
          (staff) => ({
            membershipId:
              staff.membershipId,

            name:
              staff.memberName,
          })
        ),

        settings.breakRuleHoursWorked,

        task.departmentId
      );

    const rankings =
      await this.rankWithFailover(
        {
          title: task.title,

          department:
            task.department?.name ||
            null,

          priority:
            task.priority,

          scheduledStart:
            task.scheduledStart?.toISOString() ||
            null,

          scheduledEnd:
            task.scheduledEnd?.toISOString() ||
            null,

          requiredHeadcount:
            task.requiredHeadcount,
        },

        candidates,
        weights
      );

    /*
    * AI output remains advisory.
    *
    * It cannot invent workers or return
    * workers excluded by eligibility/team
    * restrictions.
    */
    const eligibleIds =
      new Set(
        candidates.map(
          (candidate) =>
            candidate.membershipId
        )
      );

    const seen =
      new Set<string>();

    const factorExplanations =
      new Map(
        FallbackRanker.rank(
          candidates,
          weights
        ).map((ranking) => [
          ranking.membershipId,
          ranking.explanation,
        ])
      );

    return rankings
      .filter((ranking) => {
        if (
          !eligibleIds.has(
            ranking.membershipId
          ) ||
          seen.has(
            ranking.membershipId
          )
        ) {
          return false;
        }

        seen.add(
          ranking.membershipId
        );

        return true;
      })
      .map((ranking) => ({
        ...ranking,

        explanation:
          factorExplanations.get(
            ranking.membershipId
          ) ??
          ranking.explanation,
      }));
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

    const existingAssignments = await prisma.taskAssignment.findMany({
      where: { taskId, status: { in: ["assigned", "in_progress", "clocked_out", "completed"] } },
      select: { membershipId: true },
    });
    const alreadyAssigned = new Set(existingAssignments.map((assignment) => assignment.membershipId));
    const remainingHeadcount = Math.max(0, task.requiredHeadcount - existingAssignments.length);
    if (remainingHeadcount === 0) return [];

    const rankings = (await this.getSuggestions(taskId, organizationId))
      .filter((ranking) => !alreadyAssigned.has(ranking.membershipId));

    // Take top N based on required headcount
    const topN = rankings.slice(0, remainingHeadcount);

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
  private async buildCandidates(
    staff: { membershipId: string; name: string }[],
    maxHours: number,
    departmentId: string | null
  ): Promise<StaffCandidate[]> {
    if (staff.length === 0) return [];

    const membershipIds = staff.map((member) => member.membershipId);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recentAssignments, certifications, availability, departmentAssignments] =
      await Promise.all([
        prisma.taskAssignment.findMany({
          where: {
            membershipId: { in: membershipIds },
            status: { in: ["clocked_out", "completed"] },
            clockInTime: { gte: oneDayAgo },
            clockOutTime: { not: null },
          },
          select: { membershipId: true, clockInTime: true, clockOutTime: true },
        }),
        prisma.certification.findMany({
          where: {
            membershipId: { in: membershipIds },
            status: "verified",
            OR: [{ expiryDate: null }, { expiryDate: { gte: new Date() } }],
          },
          select: { membershipId: true, name: true },
        }),
        prisma.availability.findMany({
          where: { membershipId: { in: membershipIds } },
          orderBy: { dayOfWeek: "asc" },
          select: { membershipId: true, dayOfWeek: true, startTime: true, endTime: true, isAvailable: true },
        }),
        departmentId
          ? prisma.taskAssignment.findMany({
              where: {
                membershipId: { in: membershipIds },
                status: { in: ["assigned", "in_progress", "clocked_out", "completed"] },
                task: { departmentId },
              },
              select: { membershipId: true },
            })
          : Promise.resolve([]),
      ]);

    const hoursByMember = new Map<string, number>();
    for (const assignment of recentAssignments) {
      if (!assignment.clockInTime || !assignment.clockOutTime) continue;
      const hours = (assignment.clockOutTime.getTime() - assignment.clockInTime.getTime()) / 3600000;
      hoursByMember.set(assignment.membershipId, (hoursByMember.get(assignment.membershipId) ?? 0) + hours);
    }
    const certificationsByMember = new Map<string, string[]>();
    for (const certification of certifications) {
      const names = certificationsByMember.get(certification.membershipId) ?? [];
      names.push(certification.name);
      certificationsByMember.set(certification.membershipId, names);
    }
    const availabilityByMember = new Map<string, typeof availability>();
    for (const entry of availability) {
      const entries = availabilityByMember.get(entry.membershipId) ?? [];
      entries.push(entry);
      availabilityByMember.set(entry.membershipId, entries);
    }
    const historyByMember = new Map<string, number>();
    for (const assignment of departmentAssignments) {
      historyByMember.set(assignment.membershipId, (historyByMember.get(assignment.membershipId) ?? 0) + 1);
    }

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return staff.map(({ membershipId, name }) => {
      const availableHours = (availabilityByMember.get(membershipId) ?? [])
        .filter((entry) => entry.isAvailable)
        .map((entry) => `${dayNames[entry.dayOfWeek]} ${entry.startTime}-${entry.endTime}`)
        .join(", ") || "Not set";
      return {
        membershipId,
        name,
        hoursWorkedToday: Math.round((hoursByMember.get(membershipId) ?? 0) * 10) / 10,
        maxHours,
        certifications: certificationsByMember.get(membershipId) ?? [],
        availableHours,
        departmentHistory: historyByMember.get(membershipId) ?? 0,
      };
    });
  }
}
