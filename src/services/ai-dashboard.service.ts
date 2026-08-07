/**
 * AI Dashboard Service (Control Layer)
 *
 * Generates AI-powered dashboard insights including:
 * - Natural language workforce summary (US-67)
 * - Proactive staffing alerts (US-68)
 * - Review-focused operational alerts (US-70)
 * - Ranked actionable recommendations (Phase 8)
 *
 * Uses the same AI provider infrastructure (Groq/Gemini/fallback)
 * as the allocation service. All insights are advisory — the
 * admin always has final decision authority.
 */
import { TaskRepository } from "@/repositories/task.repository";
import { MembershipRepository } from "@/repositories/membership.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { prisma } from "@/lib/prisma";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

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
}

/** Response from generateRecommendations */
export interface AIRecommendationsResponse {
  recommendations: AIRecommendation[];
  footer: string;
}

export class AIDashboardService {
  private taskRepo = new TaskRepository();
  private membershipRepo = new MembershipRepository();
  private settingsRepo = new SettingsRepository();

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
- rejectionPatterns MUST be an empty array []; staff no longer reject assigned work.
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
  async generateRecommendations(organizationId: string): Promise<AIRecommendationsResponse> {
    const data = await this.gatherDashboardData(organizationId);

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
        const response = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
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
          return this.parseRecommendationResponse(content, data, organizationId);
        }
      } catch (error) {
        console.error("[AI Recommendations] Groq failed:", error);
      }
    }

    // Try Gemini
    if (geminiKey) {
      try {
        const response = await fetchWithTimeout(
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
          return this.parseRecommendationResponse(content, data, organizationId);
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
    organizationId: string
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
      };
    } catch {
      console.error("[AI Recommendations] Parse failed, using algorithmic fallback");
      return this.generateAlgorithmicRecommendations(data, organizationId);
    }
  }

  /**
   * Generates recommendations using rule-based analysis.
   * Prioritizes: understaffed tasks, department imbalances, and certifications.
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
      });
    }

    // 2. Departments with tasks but no staff
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
  async generateInsights(organizationId: string): Promise<DashboardInsight> {
    const data = await this.gatherDashboardData(organizationId);

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
        const response = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
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
        const response = await fetchWithTimeout(
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
        rejectionPatterns: [],
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
      rejectionPatterns: [],
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
  private async gatherDashboardData(organizationId: string): Promise<DashboardData> {
    const settings = await this.settingsRepo.getOrCreate(organizationId);
    const members = await this.membershipRepo.findByOrgId(organizationId);
    const activeStaff = members.filter(
      (m) => m.status === "active" && m.role !== "company_admin"
    );

    const tasks = await this.taskRepo.findByOrganizationId(organizationId);
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
      const assignments = await prisma.taskAssignment.findMany({
        where: {
          membershipId: staff.id,
          status: { in: ["clocked_out", "completed"] },
          clockInTime: { gte: oneDayAgo },
          clockOutTime: { not: null },
        },
      });

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


    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const completedToday = await prisma.taskAssignment.count({
      where: {
        task: { organizationId },
        status: { in: ["clocked_out", "completed"] },
        clockOutTime: { gte: todayStart },
      },
    });

    const pendingCertifications = await prisma.certification.count({
      where: {
        membership: { organizationId },
        status: "pending",
      },
    });

    const departments = await prisma.department.findMany({
      where: { organizationId, archivedAt: null },
      include: {
        _count: { select: { departmentMemberships: true, tasks: true } },
      },
    });

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
      completedToday,
      pendingCertifications,
      departmentCount: departments.length,
      departments: deptStats,
      maxHours: settings.breakRuleHoursWorked,
    };
  }
}
