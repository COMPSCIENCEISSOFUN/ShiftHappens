/**
 * AI Dashboard Service (Control Layer)
 *
 * Generates AI-powered dashboard insights including:
 * - Natural language workforce summary (US-67)
 * - Proactive staffing alerts (US-68)
 * - Rejection pattern analysis (US-70)
 * - Ranked actionable recommendations (Phase 8)
 *
 * Uses the same AI provider infrastructure (Groq/Gemini/fallback)
 * as the allocation service. All insights are advisory — the
 * admin always has final decision authority.
 */
import { TaskRepository } from "@/repositories/task.repository";
import { startOfDayInTimeZone } from "@/lib/timezone";
import { MembershipRepository } from "@/repositories/membership.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { CertificationRepository } from "@/repositories/certification.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import type { AIProviderName } from "@/services/ai-provider";

interface DashboardInsight {
  summary: string;
  alerts: { type: "warning" | "info" | "success"; message: string }[];
  rejectionPatterns: { staffName: string; pattern: string }[];
}

interface DashboardData {
  activeStaff: number;
  totalTasks: number;
  openTasks: number;
  inProgressTasks: number;
  unassignedTasks: number;
  understaffedTasks: { title: string; department: string; required: number; assigned: number; needed: number; taskId: string }[];
  staffNearLimit: { name: string; hours: number }[];
  recentRejections: { staffName: string; membershipId: string; count: number; reasons: string[] }[];
  completedToday: number;
  pendingCertifications: number;
  departmentCount: number;
  departments: { name: string; taskCount: number; memberCount: number }[];
  maxHours: number;
}

/** A single ranked recommendation with action context */
export interface AIRecommendation {
  priority: number;
  title: string;
  reasoning: string;
  actionType: "quick_assign" | "edit_availability" | "review_certs" | "view_tasks";
  actionUrl: string;
  /**
   * The task this refers to, when it refers to one.
   *
   * Added so the dashboard can attach a recommendation's reasoning to the
   * alert about the same shift instead of printing a second card that says
   * the same thing. The duplication was structural: the alert list and the
   * recommendation list both read understaffed tasks from the same source.
   */
  entityId?: string;
}

/** Response from generateRecommendations */
export interface AIRecommendationsResponse {
  recommendations: AIRecommendation[];
  footer: string;
  /**
   * Which strategy produced these.
   *
   * The list was badged "AI" whichever path ran, so with no API key configured
   * the algorithmic fallback was presented as model output. Reported now so the
   * badge can tell the truth — the same reason the allocation engine records
   * its provider.
   */
  provider: AIProviderName;
}

export class AIDashboardService {
  private taskRepo = new TaskRepository();
  private membershipRepo = new MembershipRepository();
  private settingsRepo = new SettingsRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private certRepo = new CertificationRepository();
  private departmentRepo = new DepartmentRepository();

  /** Shared system prompt for the legacy insights endpoint */
  private systemPrompt = `You are a workforce management AI assistant. Analyze the organizational data and provide insights.
You MUST respond with ONLY valid JSON matching this structure:
{
  "summary": "A 2-3 sentence natural language overview of today's workforce status",
  "alerts": [{"type": "warning|info|success", "message": "specific actionable alert"}],
  "rejectionPatterns": [{"staffName": "name", "pattern": "observed pattern description"}]
}
CRITICAL RULES:
- Be specific with names, numbers, and departments from the provided data ONLY.
- NEVER invent or hallucinate data. Only reference staff, tasks, and departments mentioned in the input.
- If there are no rejections in the data, rejectionPatterns MUST be an empty array [].
- If there are no issues, say so positively. Do not manufacture problems.
- Maximum 5 alerts. Keep alerts actionable and based on real data.`;

  /** System prompt for ranked recommendations */
  private recommendationPrompt = `You are a workforce management AI. Analyze the data and produce 3-5 ranked, actionable recommendations.
You MUST respond with ONLY valid JSON matching this structure:
{
  "recommendations": [
    {
      "title": "Short action (e.g., 'Assign Casey Brown to Lunch service')",
      "reasoning": "Data-backed reason (e.g., 'Available tomorrow, Food Safety certified, lowest utilization')",
      "actionType": "quick_assign|edit_availability|review_certs|view_tasks"
    }
  ]
}
CRITICAL RULES:
- Be specific — use actual staff names, task names, and numbers from the data.
- NEVER invent names, tasks, or numbers not in the input.
- Order by impact (most important first).
- actionType must be one of: quick_assign, edit_availability, review_certs, view_tasks.
- Maximum 5 recommendations.
- If everything looks good, return 1-2 positive observations.`;

  // ================================================================
  // Ranked Recommendations (Phase 8 — new dashboard)
  // ================================================================

  /**
   * Generates ranked, actionable recommendations for the admin dashboard.
   * Each recommendation includes a title, reasoning, and action type.
   * Falls back to algorithmic analysis if AI providers fail.
   */
  async generateRecommendations(
    organizationId: string,
    /** Manager scope. null/undefined = unrestricted (company admin). */
    departmentIds?: string[] | null
  ): Promise<AIRecommendationsResponse> {
    const data = await this.gatherDashboardData(organizationId, departmentIds);

    if (data.totalTasks === 0 && data.activeStaff === 0) {
      return {
        recommendations: [{
          priority: 1,
          title: "Get started",
          reasoning: "Create departments, invite staff, and add tasks to see AI-powered recommendations.",
          actionType: "view_tasks",
          actionUrl: `/org/${organizationId}/departments`,
        }],
        footer: "No data to analyze yet",
        // Nothing was analysed, so nothing produced this. Reporting a model
        // here would badge a hardcoded welcome message as AI output.
        provider: "algorithmic",
      };
    }

    const prompt = this.buildRecommendationPrompt(data);
    const result = await this.callAIForRecommendations(prompt, data, organizationId);
    return result;
  }

  /** Builds the data prompt for recommendation generation */
  private buildRecommendationPrompt(data: DashboardData): string {
    let prompt = `Analyze this workforce data and provide ranked recommendations:\n\n`;
    prompt += `OVERVIEW: ${data.activeStaff} staff, ${data.totalTasks} active tasks, ${data.departmentCount} departments\n`;
    prompt += `${data.unassignedTasks} unassigned, ${data.completedToday} completed today, max ${data.maxHours}h/staff\n\n`;

    if (data.understaffedTasks.length > 0) {
      prompt += `UNDERSTAFFED TASKS:\n`;
      for (const t of data.understaffedTasks) {
        prompt += `- "${t.title}" (${t.department}): ${t.assigned}/${t.required} staff\n`;
      }
      prompt += `\n`;
    }

    if (data.staffNearLimit.length > 0) {
      prompt += `STAFF NEAR HOUR LIMITS:\n`;
      for (const s of data.staffNearLimit) {
        prompt += `- ${s.name}: ${s.hours.toFixed(1)}h worked (limit: ${data.maxHours}h)\n`;
      }
      prompt += `\n`;
    }

    if (data.recentRejections.length > 0) {
      prompt += `REJECTION PATTERNS (7 days):\n`;
      for (const r of data.recentRejections) {
        prompt += `- ${r.staffName}: ${r.count} rejections. Reasons: ${r.reasons.join(", ") || "unspecified"}\n`;
      }
      prompt += `\n`;
    }

    if (data.pendingCertifications > 0) {
      prompt += `PENDING: ${data.pendingCertifications} certifications awaiting verification\n\n`;
    }

    prompt += `DEPARTMENTS:\n`;
    for (const d of data.departments) {
      prompt += `- ${d.name}: ${d.taskCount} tasks, ${d.memberCount} staff\n`;
    }

    return prompt;
  }

  /** Calls AI providers for recommendations with failover to algorithmic */
  private async callAIForRecommendations(
    prompt: string,
    data: DashboardData,
    organizationId: string
  ): Promise<AIRecommendationsResponse> {
    const groqKey = process.env.GROQ_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    // Try Groq
    if (groqKey) {
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [
              { role: "system", content: this.recommendationPrompt },
              { role: "user", content: prompt },
            ],
            temperature: 0,
            max_tokens: 800,
          }),
        });

        if (response.ok) {
          const result = await response.json();
          const content = result.choices[0]?.message?.content || "";
          return this.parseRecommendationResponse(content, data, organizationId, "groq");
        }
      } catch (error) {
        console.error("[AI Recommendations] Groq failed:", error);
      }
    }

    // Try Gemini
    if (geminiKey) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [{ text: `${this.recommendationPrompt}\n\n${prompt}` }],
              }],
              generationConfig: { temperature: 0, maxOutputTokens: 800 },
            }),
          }
        );

        if (response.ok) {
          const result = await response.json();
          const content = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
          return this.parseRecommendationResponse(content, data, organizationId, "gemini");
        }
      } catch (error) {
        console.error("[AI Recommendations] Gemini failed:", error);
      }
    }

    // Algorithmic fallback
    return this.generateAlgorithmicRecommendations(data, organizationId);
  }

  /** Parses AI recommendation response with fallback */
  private parseRecommendationResponse(
    content: string,
    data: DashboardData,
    organizationId: string,
    /** Which model answered, so the response can say so honestly. */
    usedProvider: AIProviderName
  ): AIRecommendationsResponse {
    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed.recommendations)) {
        throw new Error("Missing recommendations array");
      }

      const validActionTypes = ["quick_assign", "edit_availability", "review_certs", "view_tasks"];
      const recommendations: AIRecommendation[] = parsed.recommendations
        .slice(0, 5)
        .map((r: { title?: string; reasoning?: string; actionType?: string }, i: number) => ({
          priority: i + 1,
          title: r.title || "Review dashboard",
          reasoning: r.reasoning || "",
          actionType: validActionTypes.includes(r.actionType || "")
            ? r.actionType
            : "view_tasks",
          actionUrl: this.getActionUrl(
            (r.actionType as AIRecommendation["actionType"]) || "view_tasks",
            organizationId
          ),
        }));

      return {
        recommendations,
        footer: `Based on analysis of ${data.totalTasks} tasks, ${data.activeStaff} staff schedules, and 7 days of assignment history`,
        provider: usedProvider,
      };
    } catch {
      console.error("[AI Recommendations] Parse failed, using algorithmic fallback");
      return this.generateAlgorithmicRecommendations(data, organizationId);
    }
  }

  /**
   * Generates recommendations using rule-based analysis.
   * Prioritizes: understaffed tasks → rejection patterns → dept imbalances → certs.
   */
  private generateAlgorithmicRecommendations(
    data: DashboardData,
    organizationId: string
  ): AIRecommendationsResponse {
    const recommendations: AIRecommendation[] = [];
    let priority = 1;

    // 1. Understaffed tasks — most urgent
    for (const task of data.understaffedTasks.slice(0, 2)) {
      recommendations.push({
        priority: priority++,
        title: `Assign staff to ${task.title}`,
        reasoning: `${task.department} — needs ${task.needed} more staff (${task.assigned}/${task.required} assigned)`,
        actionType: "view_tasks",
        actionUrl: `/org/${organizationId}/tasks`,
        // Carries the task id so the dashboard folds this into the alert about
        // the same shift rather than repeating it beside it.
        entityId: task.taskId,
      });
    }

    // 2. Rejection patterns — schedule conflicts suggest availability mismatch
    for (const r of data.recentRejections.slice(0, 2)) {
      const scheduleConflicts = r.reasons.filter(
        (reason) => reason === "schedule_conflict"
      ).length;
      const hasScheduleIssue =
        scheduleConflicts > 0 || r.reasons.includes("schedule_conflict");

      if (hasScheduleIssue) {
        recommendations.push({
          priority: priority++,
          title: `Update ${r.staffName}'s availability`,
          reasoning: `${r.count} rejections recently — schedule conflicts suggest their availability doesn't match assigned shifts`,
          actionType: "edit_availability",
          actionUrl: `/org/${organizationId}/availability`,
        });
      } else {
        recommendations.push({
          priority: priority++,
          title: `Review ${r.staffName}'s rejection pattern`,
          reasoning: `${r.count} rejections recently. Top reason: ${r.reasons[0] || "unspecified"}`,
          actionType: "view_tasks",
          actionUrl: `/org/${organizationId}/tasks`,
        });
      }
    }

    // 3. Departments with tasks but no staff
    for (const dept of data.departments) {
      if (dept.taskCount > 0 && dept.memberCount === 0) {
        recommendations.push({
          priority: priority++,
          title: `Assign staff to ${dept.name}`,
          reasoning: `${dept.taskCount} tasks but 0 staff members — department cannot operate`,
          actionType: "view_tasks",
          actionUrl: `/org/${organizationId}/members`,
        });
      }
    }

    // 4. Pending certifications
    if (data.pendingCertifications > 0) {
      recommendations.push({
        priority: priority++,
        title: `Review pending certifications`,
        reasoning: `${data.pendingCertifications} certification${data.pendingCertifications !== 1 ? "s" : ""} awaiting verification`,
        actionType: "review_certs",
        actionUrl: `/org/${organizationId}/certifications`,
      });
    }

    // 5. Positive observation if nothing needs attention
    if (recommendations.length === 0) {
      recommendations.push({
        priority: 1,
        title: "All looking good",
        reasoning: `${data.totalTasks} tasks running across ${data.departmentCount} departments with ${data.activeStaff} staff. No issues detected.`,
        actionType: "view_tasks",
        actionUrl: `/org/${organizationId}/tasks`,
      });
    }

    return {
      recommendations: recommendations.slice(0, 5),
      footer: `Based on analysis of ${data.totalTasks} tasks, ${data.activeStaff} staff schedules, and 7 days of assignment history`,
      provider: "algorithmic",
    };
  }

  /** Maps action types to URL paths */
  private getActionUrl(
    actionType: AIRecommendation["actionType"],
    organizationId: string
  ): string {
    switch (actionType) {
      case "quick_assign":
      case "view_tasks":
        return `/org/${organizationId}/tasks`;
      case "edit_availability":
        return `/org/${organizationId}/availability`;
      case "review_certs":
        return `/org/${organizationId}/certifications`;
      default:
        return `/org/${organizationId}/tasks`;
    }
  }

  // ================================================================
  // Legacy Insights (backward compatibility — /dashboard-insights)
  // ================================================================

  /**
   * Generates a comprehensive dashboard insight by gathering
   * org data and sending it to the AI for analysis.
   */
  async generateInsights(
    organizationId: string,
    /** Manager scope. null/undefined = unrestricted (company admin). */
    departmentIds?: string[] | null
  ): Promise<DashboardInsight> {
    const data = await this.gatherDashboardData(organizationId, departmentIds);

    if (data.totalTasks === 0 && data.activeStaff === 0) {
      return {
        summary: "Your organization is set up and ready. Create departments, invite staff, and start creating tasks to see AI-powered insights here.",
        alerts: [],
        rejectionPatterns: [],
      };
    }

    const prompt = this.buildPrompt(data);
    return this.callAIForInsights(prompt, data);
  }

  /**
   * Calls AI providers in order for dashboard insights.
   * Falls back to algorithmic analysis if all providers fail.
   */
  private async callAIForInsights(
    prompt: string,
    data: DashboardData
  ): Promise<DashboardInsight> {
    const groqKey = process.env.GROQ_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    // Try Groq first
    if (groqKey) {
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [
              { role: "system", content: this.systemPrompt },
              { role: "user", content: prompt },
            ],
            temperature: 0,
            max_tokens: 800,
          }),
        });

        if (response.ok) {
          const result = await response.json();
          const content = result.choices[0]?.message?.content || "";
          return this.parseInsightResponse(content, data);
        }
      } catch (error) {
        console.error("[Dashboard AI] Groq failed:", error);
      }
    }

    // Try Gemini
    if (geminiKey) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: `${this.systemPrompt}\n\n${prompt}`,
                }],
              }],
              generationConfig: { temperature: 0, maxOutputTokens: 800 },
            }),
          }
        );

        if (response.ok) {
          const result = await response.json();
          const content = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
          return this.parseInsightResponse(content, data);
        }
      } catch (error) {
        console.error("[Dashboard AI] Gemini failed:", error);
      }
    }

    // Algorithmic fallback
    return this.generateAlgorithmicInsights(data);
  }

  /** Parses AI JSON response with fallback to algorithmic analysis */
  private parseInsightResponse(content: string, data: DashboardData): DashboardInsight {
    try {
      const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned);
      return {
        summary: parsed.summary || "Dashboard data loaded.",
        alerts: Array.isArray(parsed.alerts) ? parsed.alerts.slice(0, 5) : [],
        rejectionPatterns: Array.isArray(parsed.rejectionPatterns) ? parsed.rejectionPatterns : [],
      };
    } catch {
      console.error("[Dashboard AI] Failed to parse response");
      return this.generateAlgorithmicInsights(data);
    }
  }

  /**
   * Generates insights without AI using pure data analysis.
   */
  private generateAlgorithmicInsights(data: DashboardData): DashboardInsight {
    const alerts: { type: "warning" | "info" | "success"; message: string }[] = [];

    if (data.unassignedTasks > 0) {
      alerts.push({
        type: "warning",
        message: `${data.unassignedTasks} task${data.unassignedTasks > 1 ? "s" : ""} still need staff assigned.`,
      });
    }

    for (const task of data.understaffedTasks) {
      alerts.push({
        type: "warning",
        message: `"${task.title}" needs ${task.needed} more staff (${task.assigned}/${task.required} assigned).`,
      });
    }

    for (const staff of data.staffNearLimit) {
      alerts.push({
        type: "warning",
        message: `${staff.name} has worked ${staff.hours.toFixed(1)}h today (limit: ${data.maxHours}h).`,
      });
    }

    if (data.pendingCertifications > 0) {
      alerts.push({
        type: "info",
        message: `${data.pendingCertifications} certification${data.pendingCertifications > 1 ? "s" : ""} pending verification.`,
      });
    }

    if (data.completedToday > 0) {
      alerts.push({
        type: "success",
        message: `${data.completedToday} task${data.completedToday > 1 ? "s" : ""} completed today.`,
      });
    }

    const rejectionPatterns = data.recentRejections.map((r) => ({
      staffName: r.staffName,
      pattern: `Rejected ${r.count} task${r.count > 1 ? "s" : ""} recently. ${r.reasons.length > 0 ? `Common reason: "${r.reasons[0]}"` : ""}`,
    }));

    const parts: string[] = [];
    parts.push(`You have ${data.totalTasks} active task${data.totalTasks !== 1 ? "s" : ""} across ${data.departmentCount} department${data.departmentCount !== 1 ? "s" : ""} with ${data.activeStaff} staff available.`);

    if (data.unassignedTasks > 0) {
      parts.push(`${data.unassignedTasks} task${data.unassignedTasks > 1 ? "s need" : " needs"} staff assignment.`);
    }

    if (data.completedToday > 0) {
      parts.push(`${data.completedToday} task${data.completedToday > 1 ? "s" : ""} completed today.`);
    }

    return {
      summary: parts.join(" "),
      alerts: alerts.slice(0, 5),
      rejectionPatterns,
    };
  }

  /** Builds the data prompt sent to AI providers (legacy) */
  private buildPrompt(data: DashboardData): string {
    let prompt = `Analyze this workforce data and provide insights:\n\n`;
    prompt += `ORGANIZATION OVERVIEW:\n`;
    prompt += `- ${data.activeStaff} active staff across ${data.departmentCount} departments\n`;
    prompt += `- ${data.totalTasks} active tasks (${data.openTasks} open, ${data.inProgressTasks} in progress)\n`;
    prompt += `- ${data.unassignedTasks} tasks need staff assignment\n`;
    prompt += `- ${data.completedToday} tasks completed today\n`;
    prompt += `- Max hours per staff: ${data.maxHours}h\n\n`;

    if (data.understaffedTasks.length > 0) {
      prompt += `UNDERSTAFFED TASKS:\n`;
      for (const t of data.understaffedTasks) {
        prompt += `- "${t.title}" (${t.department}): ${t.assigned}/${t.required} staff assigned\n`;
      }
      prompt += `\n`;
    }

    if (data.staffNearLimit.length > 0) {
      prompt += `STAFF APPROACHING HOUR LIMITS:\n`;
      for (const s of data.staffNearLimit) {
        prompt += `- ${s.name}: ${s.hours.toFixed(1)}h worked (limit: ${data.maxHours}h)\n`;
      }
      prompt += `\n`;
    }

    if (data.recentRejections.length > 0) {
      prompt += `RECENT REJECTIONS (last 7 days):\n`;
      for (const r of data.recentRejections) {
        prompt += `- ${r.staffName}: rejected ${r.count} tasks. Reasons: ${r.reasons.join(", ") || "not provided"}\n`;
      }
    } else {
      prompt += `RECENT REJECTIONS: None in the last 7 days.\n`;
    }
    prompt += `\n`;

    if (data.pendingCertifications > 0) {
      prompt += `PENDING CERTIFICATIONS: ${data.pendingCertifications} awaiting verification\n\n`;
    }

    prompt += `DEPARTMENTS:\n`;
    for (const d of data.departments) {
      prompt += `- ${d.name}: ${d.taskCount} tasks, ${d.memberCount} members\n`;
    }

    return prompt;
  }

  // ================================================================
  // Data Gathering (shared by both endpoints)
  // ================================================================

  /**
   * Gathers all data needed for dashboard analysis.
   */
  /**
   * Collects the raw picture the model reasons over.
   *
   * `departmentIds` was missing until 2026-08-02, and the consequence was not
   * abstract: the alerts and recommendations built from this data embed staff
   * NAMES and task TITLES. A manager scoped to one department was shown, in
   * plain language, who elsewhere in the company was near their hour limit and
   * which of another team's shifts were understaffed — and the same org-wide
   * detail was sent to Groq or Gemini in the prompt.
   *
   * Filtering is in memory rather than at the query, because both repository
   * calls already load everything this needs — `findByOrgId` includes each
   * membership's departments — and pushing the scope into the queries would
   * mean touching two repositories for no behavioural gain.
   */
  private async gatherDashboardData(
    organizationId: string,
    departmentIds?: string[] | null
  ): Promise<DashboardData> {
    /** null/undefined = unrestricted. An empty array means "no departments". */
    const scope = departmentIds == null ? null : new Set(departmentIds);

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    const members = await this.membershipRepo.findByOrgId(organizationId);
    const activeStaff = members
      .filter((m) => m.status === "active" && m.role !== "company_admin")
      .filter(
        (m) =>
          scope === null ||
          m.departmentMemberships.some((dm) => scope.has(dm.department.id))
      );

    const allTasks = await this.taskRepo.findByOrganizationId(organizationId);
    // A task with no department belongs to nobody as far as scope goes — the
    // same rule AccessService.isTaskInScope applies.
    const tasks =
      scope === null
        ? allTasks
        : allTasks.filter((t) => t.departmentId !== null && scope.has(t.departmentId));
    const openTasks = tasks.filter((t) => t.status === "open");
    const inProgressTasks = tasks.filter((t) => t.status === "in_progress");

    const unassignedTasks = openTasks.filter((t) => t.assignments.length === 0);
    const understaffedTasks = openTasks
      .filter((t) => t.assignments.length < t.requiredHeadcount && t.assignments.length > 0)
      .map((t) => ({
        title: t.title,
        department: t.department?.name || "No department",
        required: t.requiredHeadcount,
        assigned: t.assignments.length,
        needed: t.requiredHeadcount - t.assignments.length,
        taskId: t.id,
      }));

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const staffNearLimit: { name: string; hours: number }[] = [];

    for (const staff of activeStaff) {
      const assignments = await this.assignmentRepo.findWorkedSince(
        staff.id,
        oneDayAgo
      );

      let hours = 0;
      for (const a of assignments) {
        if (a.clockInTime && a.clockOutTime) {
          hours += (a.clockOutTime.getTime() - a.clockInTime.getTime()) / (1000 * 60 * 60);
        }
      }

      if (hours >= settings.breakRuleHoursWorked * 0.75) {
        staffNearLimit.push({
          name: staff.user.name || staff.user.email,
          hours,
        });
      }
    }

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rejections = await this.assignmentRepo.findRecentRejections(
      organizationId,
      oneWeekAgo
    );

    // Rejections come back org-wide. `activeStaff` is already scoped, so it is
    // the authoritative list of who this caller may be told about — a rejection
    // by someone in another department must not surface as a "pattern".
    const visibleMembershipIds = new Set(activeStaff.map((m) => m.id));

    const rejectionMap: Record<string, { staffName: string; membershipId: string; count: number; reasons: string[] }> = {};
    for (const r of rejections) {
      if (scope !== null && !visibleMembershipIds.has(r.membershipId)) continue;
      const key = r.membershipId;
      if (!rejectionMap[key]) {
        rejectionMap[key] = {
          staffName: r.membership.user.name || r.membership.user.email,
          membershipId: r.membershipId,
          count: 0,
          reasons: [],
        };
      }
      rejectionMap[key].count++;
      if (r.rejectionReason && !rejectionMap[key].reasons.includes(r.rejectionReason)) {
        rejectionMap[key].reasons.push(r.rejectionReason);
      }
    }

    const recentRejections = Object.values(rejectionMap).filter((r) => r.count >= 2);

    // setHours() uses the runtime's zone: on Vercel that is UTC, i.e. 08:00
    // Singapore, so everything completed before 8am local was omitted — and the
    // wrong figure was then handed to the model as ground truth.
    const todayStart = startOfDayInTimeZone();
    const completedToday = await this.assignmentRepo.countCompletedSince(
      organizationId,
      todayStart
    );

    const pendingCertifications =
      await this.certRepo.countPendingVerification(organizationId);

    const allDepartments = await this.departmentRepo.findActiveWithCounts(
      organizationId
    );
    const departments =
      scope === null
        ? allDepartments
        : allDepartments.filter((d) => scope.has(d.id));

    const deptStats = departments.map((d) => ({
      name: d.name,
      taskCount: d._count.tasks,
      memberCount: d._count.departmentMemberships,
    }));

    return {
      activeStaff: activeStaff.length,
      totalTasks: openTasks.length + inProgressTasks.length,
      openTasks: openTasks.length,
      inProgressTasks: inProgressTasks.length,
      unassignedTasks: unassignedTasks.length,
      understaffedTasks,
      staffNearLimit,
      recentRejections,
      completedToday,
      pendingCertifications,
      departmentCount: departments.length,
      departments: deptStats,
      maxHours: settings.breakRuleHoursWorked,
    };
  }
}