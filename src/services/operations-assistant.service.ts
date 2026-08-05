/** Shared, role-aware AI operations assistant. */
import { prisma } from "@/lib/prisma";
import { departmentScopeFor } from "@/lib/department-scope";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { ProjectService } from "@/services/project.service";
import { ReplacementAllocationService } from "@/services/replacement-allocation.service";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { ManagerTaskAutomationService } from "@/services/manager-task-automation.service";
import { AITaskParserService } from "@/services/ai-task-parser.service";
import { TaskService } from "@/services/task.service";

type MembershipContext = {
  id: string;
  role: string;
  departmentMemberships?: { department: { id: string; name: string } }[];
};

export type OperationsResult = {
  status: "completed" | "needs_review";
  title: string;
  message: string;
  details?: string[];
  actions?: { label: string; href: string }[];
  checks?: string[];
  clarificationOptions?: { label: string; retryText: string }[];
  undo?: { kind: "task" | "assignments"; taskIds?: string[]; assignmentIds?: string[] };
};

export class OperationsAssistantService {
  private auditService = new AuditLogService();
  private scheduler = new AutoScheduleService();
  private projectService = new ProjectService();
  private replacementService = new ReplacementAllocationService();
  private dashboardService = new AIDashboardService();
  private managerTaskAutomation = new ManagerTaskAutomationService();
  private taskParser = new AITaskParserService();
  private taskService = new TaskService();

  async execute(input: {
    text: string;
    organizationId: string;
    userId: string;
    membership: MembershipContext;
  }): Promise<OperationsResult> {
    const request = input.text.trim();
    const text = request.toLowerCase();
    if (!text) throw new Error("Tell the assistant what you need help with.");

    let result: OperationsResult;
    if (input.membership.role === "staff") {
      result = await this.handleStaff(text, input.organizationId, input.membership.id);
    } else if (input.membership.role === "manager") {
      result = await this.handleManager(request, text, input.organizationId, input.userId, input.membership);
    } else {
      result = await this.handleAdmin(text, input.organizationId);
    }

    await this.auditService.log({
      organizationId: input.organizationId,
      userId: input.userId,
      action: ACTIONS.AI_OPERATION_EXECUTED,
      entityType: "ai-operation",
      details: { request: input.text.slice(0, 500), role: input.membership.role, status: result.status, title: result.title },
    });
    return result;
  }

  async undo(input: {
    undo: NonNullable<OperationsResult["undo"]>;
    organizationId: string;
    userId: string;
    membership: MembershipContext;
  }) {
    const scope = departmentScopeFor(input.membership);
    if (input.membership.role === "staff") throw new Error("Staff cannot undo organization operations.");

    if (input.undo.kind === "task") {
      const taskIds = input.undo.taskIds ?? [];
      const tasks = await prisma.task.findMany({
        where: { id: { in: taskIds }, organizationId: input.organizationId, createdById: input.userId },
        select: { id: true, departmentId: true },
      });
      if (tasks.length !== taskIds.length || tasks.some((task) => scope !== null && (!task.departmentId || !scope.includes(task.departmentId)))) {
        throw new Error("That task can no longer be undone.");
      }
      await prisma.task.deleteMany({ where: { id: { in: taskIds }, organizationId: input.organizationId } });
      await this.auditService.log({ organizationId: input.organizationId, userId: input.userId, action: ACTIONS.TASK_DELETED, entityType: "ai-operation", details: { undoneTaskIds: taskIds } });
      return { message: `${tasks.length} task${tasks.length === 1 ? " was" : "s were"} undone.` };
    }

    const assignmentIds = input.undo.assignmentIds ?? [];
    const assignments = await prisma.taskAssignment.findMany({
      where: { id: { in: assignmentIds }, assignedById: input.userId, task: { organizationId: input.organizationId } },
      include: { task: { select: { departmentId: true } } },
    });
    if (assignments.length !== assignmentIds.length || assignments.some((assignment) => scope !== null && (!assignment.task.departmentId || !scope.includes(assignment.task.departmentId)))) {
      throw new Error("Those assignments can no longer be undone.");
    }
    await prisma.taskAssignment.deleteMany({ where: { id: { in: assignmentIds } } });
    await this.auditService.log({ organizationId: input.organizationId, userId: input.userId, action: ACTIONS.TASK_UNASSIGNED, entityType: "ai-operation", details: { undoneAssignmentIds: assignmentIds } });
    return { message: `${assignments.length} assignment${assignments.length === 1 ? " was" : "s were"} undone.` };
  }

  private async handleStaff(text: string, organizationId: string, membershipId: string): Promise<OperationsResult> {
    if (/(cert|qualification|expire)/.test(text)) {
      const until = new Date();
      until.setDate(until.getDate() + 30);
      const certifications = await prisma.certification.findMany({
        where: { membershipId, expiryDate: { not: null, lte: until } },
        select: { name: true, expiryDate: true, status: true },
        orderBy: { expiryDate: "asc" },
      });
      return {
        status: "completed",
        title: "Certification check complete",
        message: certifications.length ? `${certifications.length} certification${certifications.length === 1 ? " needs" : "s need"} attention in the next 30 days.` : "Your certifications have no upcoming expiry in the next 30 days.",
        details: certifications.map((cert) => `${cert.name} - ${cert.status}${cert.expiryDate ? `, expires ${cert.expiryDate.toLocaleDateString()}` : ""}`),
        checks: ["Your certification records", "Expiry dates in the next 30 days"],
        actions: [{ label: "Open my certifications", href: `/org/${organizationId}/my-certifications` }],
      };
    }

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + (text.includes("tomorrow") ? 2 : 1));
    const assignments = await prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { in: ["assigned", "in_progress"] },
        task: { organizationId, scheduledStart: { gte: start, lt: end } },
      },
      include: { task: { select: { title: true, scheduledStart: true, scheduledEnd: true } } },
      orderBy: { task: { scheduledStart: "asc" } },
    });
    const conflicts = assignments.some((assignment, index) => {
      if (index === 0) return false;
      const previous = assignments[index - 1].task;
      return Boolean(previous.scheduledEnd && assignment.task.scheduledStart && assignment.task.scheduledStart < previous.scheduledEnd);
    });
    return {
      status: "completed",
      title: text.includes("conflict") ? "Schedule conflict check complete" : "Your work brief is ready",
      message: conflicts ? "I found overlapping assignments that need a manager's attention." : assignments.length ? `You have ${assignments.length} scheduled task${assignments.length === 1 ? "" : "s"}.` : "You have no scheduled tasks in this period.",
      details: assignments.map((assignment) => `${assignment.task.title}${assignment.task.scheduledStart ? ` - ${assignment.task.scheduledStart.toLocaleString()}` : ""}`),
      checks: ["Your assigned work", "Upcoming times", "Overlapping assignments"],
      actions: [{ label: "Open my tasks", href: `/org/${organizationId}/my-tasks` }],
    };
  }

  private async handleManager(
    request: string,
    text: string,
    organizationId: string,
    userId: string,
    membership: MembershipContext
  ): Promise<OperationsResult> {
    const scope = departmentScopeFor(membership);
    if (/(break down|project plan|plan .*project|create tasks for)/.test(text)) {
      const parsed = await this.taskParser.parseTaskDescription(request, organizationId);
      if (!parsed.departmentId && scope !== null && scope.length === 1) {
        parsed.departmentId = scope[0];
      }
      if (!parsed.departmentId || (scope !== null && !scope.includes(parsed.departmentId))) {
        return {
          status: "needs_review",
          title: "Project plan needs a department",
          message: "Tell me which authorised department owns this project so I can create its work plan.",
          actions: [{ label: "Open tasks", href: `/org/${organizationId}/tasks` }],
        };
      }
      const project = await this.projectService.create({
        title: parsed.title,
        description: parsed.description || undefined,
        departmentId: parsed.departmentId,
        priority: parsed.priority as "low" | "medium" | "high" | "urgent",
        plannedStart: parsed.scheduledStart || undefined,
        plannedEnd: parsed.scheduledEnd || undefined,
      }, organizationId, userId);
      return {
        status: "completed",
        title: "Project created",
        message: project.plannedStart ? "I created the project with its planned timeframe. Add work items when the delivery breakdown is ready." : "I created the project. Add its timeframe and work items when they are ready.",
        details: [
          `Department: ${project.department?.name || "Unassigned"}`,
          ...(project.plannedStart && project.plannedEnd ? [`Timeline: ${project.plannedStart.toLocaleDateString()} to ${project.plannedEnd.toLocaleDateString()}`] : []),
        ],
        checks: ["Manager department access", "Project timeframe", "Project ownership"],
        actions: [{ label: "Open projects", href: `/org/${organizationId}/projects` }],
      };
    }
    if (/(schedule|roster|week plan)/.test(text)) {
      const weekStart = new Date();
      weekStart.setHours(0, 0, 0, 0);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
      const draft = await this.scheduler.generateSchedule(organizationId, weekStart, scope);
      if (draft.assignments.length === 0) {
        return { status: "completed", title: "Schedule checked", message: draft.unfilledTasks.length ? "No eligible automatic assignments were available for the open tasks." : "There are no unfilled scheduled tasks for this week.", details: draft.unfilledTasks.map((task) => `${task.taskTitle}: ${task.reason}`) };
      }
      return {
        status: "needs_review",
        title: "Schedule draft ready",
        message: `I prepared ${draft.assignments.length} proposed assignment${draft.assignments.length === 1 ? "" : "s"}. Review exceptions, adjust anything needed, then publish the schedule.` ,
        details: [
          ...draft.assignments.slice(0, 5).map((assignment) => `${assignment.taskTitle}: ${assignment.staffName}`),
          ...draft.unfilledTasks.map((task) => `${task.taskTitle}: ${task.reason}`),
        ],
        checks: ["Authorized departments", "Availability", "Existing assignments", "Work rules", "Eligibility"],
        actions: [{ label: "Review schedule", href: `/org/${organizationId}/auto-schedule` }],
      };
    }

    if (/(coverage|understaffed|replace|rebalance)/.test(text)) {
      const tasks = await prisma.task.findMany({
        where: { organizationId, status: "open", ...(scope === null ? {} : { departmentId: { in: scope } }) },
        include: { assignments: { where: { status: { in: ["assigned", "in_progress", "clocked_out"] } } } },
      });
      const gaps = tasks.filter((task) => task.assignments.length < task.requiredHeadcount);
      const results = await Promise.all(gaps.map((task) => this.replacementService.fillCoverageGap({
        taskId: task.id,
        organizationId,
        actorUserId: userId,
        excludedMembershipIds: [],
        removedStaffName: "AI operations assistant",
      })));
      const assigned = results.reduce((sum, result) => sum + result.assigned, 0);
      const stillOpen = results.reduce((sum, result) => sum + result.remaining, 0);
      return {
        status: stillOpen ? "needs_review" : "completed",
        title: "Coverage automation complete",
        message: gaps.length ? `I checked ${gaps.length} understaffed task${gaps.length === 1 ? "" : "s"} and assigned ${assigned} replacement${assigned === 1 ? "" : "s"}.` : "All open tasks in your departments already have enough staff.",
        details: gaps.flatMap((task, index) => results[index].remaining > 0 ? [`${task.title}: ${results[index].remaining} staff still needed`] : []),
        checks: ["Open-task coverage", "Eligibility", "Workload", "Department scope"],
        actions: [{ label: "Open tasks", href: `/org/${organizationId}/tasks` }],
      };
    }

    const taskResult = await this.managerTaskAutomation.execute(request, organizationId, userId, membership);
    const clarificationOptions = "departmentOptions" in taskResult && Array.isArray(taskResult.departmentOptions)
      ? taskResult.departmentOptions.map((department) => ({ label: department.name, retryText: `${request} for ${department.name}` }))
      : undefined;
    const taskId = "task" in taskResult && taskResult.task ? taskResult.task.id : "taskId" in taskResult ? taskResult.taskId : undefined;
    return {
      status: taskResult.status,
      title: taskResult.status === "completed" ? "Task automation complete" : "Task needs a quick review",
      message: taskResult.message,
      details: taskResult.assignedStaff ? [`Assigned: ${taskResult.assignedStaff.join(", ")}`] : undefined,
      checks: ["Authorized department", "Availability", "Certifications", "Work rules", "Workload"],
      clarificationOptions,
      actions: [{ label: "Open tasks", href: `/org/${organizationId}/tasks` }],
      undo: taskResult.status === "completed" && taskId ? { kind: "task", taskIds: [taskId] } : undefined,
    };
  }

  private async handleAdmin(text: string, organizationId: string): Promise<OperationsResult> {
    const recommendations = await this.dashboardService.generateRecommendations(organizationId);
    const isOnboarding = /(onboard|setup|invite|new staff)/.test(text);
    return {
      status: "completed",
      title: isOnboarding ? "Onboarding readiness checked" : "Organization operations analysis complete",
      message: isOnboarding
        ? "I checked the organization setup. Use the recommended actions below to complete outstanding onboarding work."
        : "I analyzed current coverage, staffing, and compliance signals across the organization.",
      details: recommendations.recommendations.map((recommendation) => `${recommendation.title}: ${recommendation.reasoning}`),
      checks: ["Coverage", "Active staffing", "Open tasks", "Certification signals"],
      actions: recommendations.recommendations.slice(0, 3).map((recommendation) => ({ label: recommendation.title, href: recommendation.actionUrl })),
    };
  }
}
