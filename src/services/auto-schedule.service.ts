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
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { CertificationRepository } from "@/repositories/certification.repository";
import { WorkRuleRepository } from "@/repositories/work-rule.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { EligibilityService } from "@/services/eligibility.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { prisma } from "@/lib/prisma";
import { ASSIGNMENT_STATUSES } from "@/lib/assignment-status";
import { ASSIGNABLE_SYSTEM_ROLES } from "@/lib/role-config";
import type { AutoScheduleAssignmentReference } from "@/lib/validations";
import { isDepartmentInScope } from "@/lib/department-scope";
import {
  DEFAULT_TIMEZONE,
  dayOfWeekInTimeZone,
  timeOfDayInTimeZone,
} from "@/lib/timezone";

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
}

export interface DraftAssignment {
  taskId: string;
  taskTitle: string;
  membershipId: string;
  staffName: string;
  reasoning: string;
}

export interface DraftSchedule {
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
  private auditService = new AuditLogService();
  private eligibilityService = new EligibilityService();
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
      });
    }

    const members = await prisma.membership.findMany({
      where: {
        organizationId,
        status: "active",
        role: { in: [...ASSIGNABLE_SYSTEM_ROLES] },
        user: { isPlatformAdmin: false },
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        departmentMemberships: { include: { department: { select: { id: true, name: true } } } },
      },
    });

    const staff: StaffInfo[] = [];
    for (const member of members) {
      const availability = await this.availRepo.getWeeklySchedule(member.id);
      const certs = await this.certRepo.getValidCertifications(member.id);

      const assignments = await prisma.taskAssignment.findMany({
        where: {
          membershipId: member.id,
          status: { in: ["assigned", "in_progress", "clocked_out", "completed"] },
          clockInTime: { not: null },
          task: { scheduledStart: { gte: weekStart }, scheduledEnd: { lte: weekEnd } },
        },
        select: { clockInTime: true, clockOutTime: true },
      });

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
      return { assignments: [], unfilledTasks: [], summary: { totalTasks: 0, totalAssignments: 0, totalUnfilled: 0, hoursDistribution: [] } };
    }

    try {
      const draft = await this.generateWithAI(context);
      if (draft.assignments.length > 0) return draft;
      console.log("[Auto-Schedule] AI produced no valid assignments, using algorithmic fallback");
    } catch (error) {
      console.log("[Auto-Schedule] AI failed, using algorithmic fallback:", error);
    }

    return this.generateAlgorithmic(context);
  }

  private generateAlgorithmic(context: ScheduleContext): DraftSchedule {
    const assignments: DraftAssignment[] = [];
    const unfilledTasks: { taskId: string; taskTitle: string; reason: string }[] = [];
    const cumulativeHours = new Map<string, number>();
    for (const s of context.staff) cumulativeHours.set(s.membershipId, s.hoursThisWeek);
    const staffSlots = new Map<string, { start: number; end: number }[]>();

    for (const task of context.tasks) {
      const slotsNeeded = task.requiredHeadcount - task.currentAssignments;
      const taskStart = task.scheduledStart.getTime();
      const taskEnd = task.scheduledEnd.getTime();
      const taskDuration = (taskEnd - taskStart) / 3600000;
      // Weekday and wall-clock must both be resolved in the organisation's
      // timezone, because that is what the availability rows mean: dayOfWeek is
      // the staff member's local day and startTime/endTime are local "HH:MM"
      // strings. Reading them off the server clock made a 09:00 Singapore shift
      // look like 01:00 on Vercel, so no candidate ever matched.
      const taskDayOfWeek = dayOfWeekInTimeZone(task.scheduledStart);
      const taskStartHour = timeOfDayInTimeZone(task.scheduledStart);
      const taskEndHour = timeOfDayInTimeZone(task.scheduledEnd);

      const assignedToThisTask: DraftAssignment[] = [];

      const candidates = context.staff
        .filter((s) => {
          const daySchedule = s.availability.find((a) => a.dayOfWeek === taskDayOfWeek);
          if (!daySchedule || !daySchedule.isAvailable) return false;
          if (daySchedule.startTime > taskStartHour) return false;
          if (daySchedule.endTime < taskEndHour) return false;
          const existingSlots = staffSlots.get(s.membershipId) || [];
          if (existingSlots.some((slot) => taskStart < slot.end && taskEnd > slot.start)) return false;
          const hours = cumulativeHours.get(s.membershipId) || 0;
          for (const rule of context.workRules) {
            if (rule.type === "max_hours_weekly" && rule.maxHours && hours + taskDuration > rule.maxHours) return false;
            if (rule.type === "max_hours_daily" && rule.maxHours && taskDuration > rule.maxHours) return false;
          }
          return true;
        })
        .map((s) => {
          const hours = cumulativeHours.get(s.membershipId) || 0;
          const inDepartment = task.departmentName ? s.departments.includes(task.departmentName) : false;
          return { ...s, score: (100 - Math.min(hours, 100)) + (inDepartment ? 25 : 0) + 25, hours, inDepartment };
        })
        .sort((a, b) => b.score - a.score);

      for (let i = 0; i < candidates.length && assignedToThisTask.length < slotsNeeded; i++) {
        const c = candidates[i];
        const reasons: string[] = [];
        if (c.inDepartment) reasons.push("department match");
        reasons.push(`${Math.round(c.hours)}h this week`);
        if (c.certifications.length > 0) reasons.push("certified");

        assignedToThisTask.push({
          taskId: task.id, taskTitle: task.title,
          membershipId: c.membershipId, staffName: c.name,
          reasoning: reasons.join(", "),
        });

        cumulativeHours.set(c.membershipId, (cumulativeHours.get(c.membershipId) || 0) + taskDuration);
        const slots = staffSlots.get(c.membershipId) || [];
        slots.push({ start: taskStart, end: taskEnd });
        staffSlots.set(c.membershipId, slots);
      }

      assignments.push(...assignedToThisTask);
      if (assignedToThisTask.length < slotsNeeded) {
        unfilledTasks.push({ taskId: task.id, taskTitle: task.title, reason: `${assignedToThisTask.length} of ${slotsNeeded} filled — no eligible staff remaining` });
      }
    }

    return this.buildSummary(assignments, unfilledTasks, context);
  }

  private async generateWithAI(context: ScheduleContext): Promise<DraftSchedule> {
    const { prompt, taskMap, staffMap } = this.buildAIPrompt(context);

    let aiResponse: string | null = null;
    try {
      aiResponse = await this.callGroq(prompt);
    } catch {
      try {
        aiResponse = await this.callGemini(prompt);
      } catch {
        throw new Error("Both AI providers failed");
      }
    }

    if (!aiResponse) throw new Error("Empty AI response");
    return this.parseAIResponse(aiResponse, context, taskMap, staffMap);
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
      return `  Task ${num}: "${t.title}" (${t.departmentName || "no dept"}, ${t.priority}, needs ${t.requiredHeadcount - t.currentAssignments} staff, ${day} ${start}-${end})`;
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
      return `  - ${r.name}: break after ${r.hoursThreshold}h`;
    }).join("\n");

    const prompt = `You are a workforce scheduler. Assign staff to tasks optimally.

TASKS:
${taskLines}

STAFF:
${staffLines}

WORK RULES:
${ruleLines || "  None"}

RULES:
1. Match staff availability to task times — staff must be available for the full duration
2. No double-booking — one task at a time per staff member
3. Distribute hours fairly — prioritize staff with fewer hours
4. Prefer staff in the matching department
5. Respect work rules (daily/weekly hour limits)

Respond with ONLY a JSON array using task numbers and staff letters:
[{"task": 1, "staff": "A", "reason": "brief reason"}, ...]

Use the exact task numbers (1, 2, 3...) and staff letters (A, B, C...) from above. Do not invent new ones.`;

    return { prompt, taskMap, staffMap };
  }

  private parseAIResponse(
    response: string,
    context: ScheduleContext,
    taskMap: Map<number, string>,
    staffMap: Map<string, string>
  ): DraftSchedule {
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

    const unfilledTasks = this.findUnfilledTasks(assignments, context);
    return this.buildSummary(assignments, unfilledTasks, context);
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

  async confirmSchedule(
    organizationId: string,
    assignments: AutoScheduleAssignmentReference[],
    confirmedById: string,
    authorizedDepartmentIds: string[] | null = null
  ) {
    if (assignments.length === 0) throw new Error("At least one assignment is required");

    const taskIds = [...new Set(assignments.map((assignment) => assignment.taskId))];
    const membershipIds = [
      ...new Set(assignments.map((assignment) => assignment.membershipId)),
    ];
    const pairs = new Set<string>();
    for (const assignment of assignments) {
      const pair = `${assignment.taskId}:${assignment.membershipId}`;
      if (pairs.has(pair)) throw new Error("Duplicate task and staff assignment");
      pairs.add(pair);
    }

    const [tasks, memberships] = await Promise.all([
      prisma.task.findMany({
        where: { id: { in: taskIds }, organizationId, status: "open" },
        select: {
          id: true,
          title: true,
          departmentId: true,
          scheduledStart: true,
          scheduledEnd: true,
        },
      }),
      prisma.membership.findMany({
        where: { id: { in: membershipIds }, organizationId },
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
          user: { select: { isPlatformAdmin: true } },
          departmentMemberships: { select: { departmentId: true } },
        },
      }),
    ]);
    if (tasks.length !== taskIds.length) throw new Error("Task not found");
    if (memberships.length !== membershipIds.length) {
      throw new Error("Schedule contains an invalid staff member");
    }

    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const membershipsById = new Map(
      memberships.map((membership) => [membership.id, membership])
    );
    const slotsByMember = new Map<
      string,
      { taskId: string; start: number; end: number }[]
    >();
    const assignmentsByTask = new Map<string, string[]>();

    for (const assignment of assignments) {
      const task = tasksById.get(assignment.taskId)!;
      const membership = membershipsById.get(assignment.membershipId)!;
      if (!isDepartmentInScope(task.departmentId, authorizedDepartmentIds)) {
        throw new Error("Task not found");
      }
      if (
        membership.status !== "active" ||
        membership.role !== "staff" ||
        membership.user.isPlatformAdmin
      ) {
        throw new Error("Schedule contains an invalid staff member");
      }
      if (
        task.departmentId &&
        !membership.departmentMemberships.some(
          (department) => department.departmentId === task.departmentId
        )
      ) {
        throw new Error("Schedule contains a staff member outside the task department");
      }
      if (!task.scheduledStart || !task.scheduledEnd) {
        throw new Error("Schedule contains an unscheduled task");
      }

      const slots = slotsByMember.get(membership.id) ?? [];
      const start = task.scheduledStart.getTime();
      const end = task.scheduledEnd.getTime();
      if (slots.some((slot) => start < slot.end && end > slot.start)) {
        throw new Error("Staff member cannot be assigned to overlapping tasks");
      }
      slots.push({ taskId: task.id, start, end });
      slotsByMember.set(membership.id, slots);

      const taskMembers = assignmentsByTask.get(task.id) ?? [];
      taskMembers.push(membership.id);
      assignmentsByTask.set(task.id, taskMembers);
    }

    for (const [taskId, selectedMembershipIds] of assignmentsByTask) {
      await this.eligibilityService.assertEligibleForAssignment(
        taskId,
        organizationId,
        selectedMembershipIds
      );
    }

    const created = await this.assignmentRepo.createScheduleAtomic({
      organizationId,
      assignments,
      assignedById: confirmedById,
    });

    await this.auditService.log({
      organizationId, userId: confirmedById,
      action: ACTIONS.TASK_ASSIGNED, entityType: "auto-schedule",
      details: {
        assignmentsCreated: created.length,
        taskIds,
        membershipIds,
        status: ASSIGNMENT_STATUSES.ASSIGNED,
      },
    });

    for (const assignment of assignments) {
      const task = tasksById.get(assignment.taskId)!;
      const membership = membershipsById.get(assignment.membershipId)!;
      await this.notificationService.notifyIfEnabled(
        organizationId,
        membership.userId,
        NOTIFICATION_TYPES.TASK_ASSIGNED,
        "New task assignment",
        `You've been assigned to "${task.title}"`,
        "assignment",
        task.id
      );
    }

    return { created: created.length, failed: 0 };
  }
}
