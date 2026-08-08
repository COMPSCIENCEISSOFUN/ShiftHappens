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
import {
  hasPermission,
  PERMISSIONS,
  type PermissionMembership,
  type PermissionName,
} from "@/lib/permission-guard";

type MembershipContext = PermissionMembership & {
  id: string;
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
  undo?: { operationId: string };
};

type UndoTargets = {
  kind: "task" | "assignments";
  taskIds?: string[];
  assignmentIds?: string[];
};

type ExecutionResult = Omit<OperationsResult, "undo"> & {
  undoTargets?: UndoTargets;
};

export class OperationsAssistantService {
  private static readonly CONFIRM_PREFIX = "confirm operation: ";
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
    const submittedRequest = input.text.trim();
    const confirmed = submittedRequest
      .toLowerCase()
      .startsWith(OperationsAssistantService.CONFIRM_PREFIX);
    const request = confirmed
      ? submittedRequest.slice(OperationsAssistantService.CONFIRM_PREFIX.length).trim()
      : submittedRequest;
    const text = request.toLowerCase();
    if (!text) throw new Error("Tell the assistant what you need help with.");

    let result: ExecutionResult;
    if (input.membership.role === "staff") {
      result = await this.handleStaff(text, input.organizationId, input.membership.id);
    } else if (
      input.membership.role === "manager" &&
      this.isManagerMutationIntent(text) &&
      !confirmed
    ) {
      result = {
        status: "needs_review",
        title: "Confirm this operation",
        message:
          "This request will change live tasks or assignments. Review the request, then confirm before ShiftHappens writes anything.",
        details: [request],
        checks: ["Your current permissions", "Your authorized department scope"],
        clarificationOptions: [
          {
            label: "Confirm and run",
            retryText: `${OperationsAssistantService.CONFIRM_PREFIX}${request}`,
          },
        ],
      };
    } else if (input.membership.role === "manager") {
      result = await this.handleManager(request, text, input.organizationId, input.userId, input.membership);
    } else {
      result = await this.handleAdmin(text, input.organizationId);
    }

    let undo: OperationsResult["undo"];
    if (result.undoTargets) {
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const operation = await prisma.assistantOperation.create({
        data: {
          organizationId: input.organizationId,
          userId: input.userId,
          kind: result.undoTargets.kind,
          undoPayload: result.undoTargets,
          expiresAt,
        },
        select: { id: true },
      });
      undo = { operationId: operation.id };
    }

    const resultWithoutUndo = { ...result };
    delete resultWithoutUndo.undoTargets;
    const publicResult: OperationsResult = { ...resultWithoutUndo, undo };
    await this.auditService.log({
      organizationId: input.organizationId,
      userId: input.userId,
      action: ACTIONS.AI_OPERATION_EXECUTED,
      entityType: "ai-operation",
      // Audit records double as the actor-scoped conversation memory. Do not
      // persist undo data: an old action must never remain destructive later.
      details: {
        request: request.slice(0, 500),
        role: input.membership.role,
        status: publicResult.status,
        title: publicResult.title,
        result: {
          status: publicResult.status,
          title: publicResult.title,
          message: publicResult.message,
          details: publicResult.details,
          checks: publicResult.checks,
          actions: publicResult.actions,
          clarificationOptions: publicResult.clarificationOptions,
        },
      },
    });
    return publicResult;
  }

  private isManagerMutationIntent(text: string) {
    if (/(schedule|roster|week plan)/.test(text)) return false;
    return /(break down|project plan|plan .*project|create tasks for|coverage|understaffed|replace|rebalance|\b(create|add|assign|schedule)\b.*\b(task|shift|staff|team|worker|employee|people|person)\b|\b(task|shift)\b.*\b(create|add|assign|schedule)\b)/.test(
      text
    );
  }

  async undo(input: {
    operationId: string;
    organizationId: string;
    userId: string;
    membership: MembershipContext;
  }) {
    const scope = departmentScopeFor(input.membership);
    const outcome = await prisma.$transaction(async (tx) => {
      const operation = await tx.assistantOperation.findFirst({
        where: {
          id: input.operationId,
          organizationId: input.organizationId,
          userId: input.userId,
        },
      });
      if (
        !operation ||
        operation.undoneAt ||
        (operation.expiresAt && operation.expiresAt < new Date())
      ) {
        throw new Error("That operation can no longer be undone.");
      }
      const targets = operation.undoPayload as UndoTargets | null;
      if (!targets || targets.kind !== operation.kind) {
        throw new Error("That operation has no valid undo record.");
      }

      if (targets.kind === "task") {
        this.assertPermission(input.membership, PERMISSIONS.TASKS_DELETE);
        const taskIds = [...new Set(targets.taskIds ?? [])];
        const tasks = await tx.task.findMany({
          where: {
            id: { in: taskIds },
            organizationId: input.organizationId,
            createdById: input.userId,
          },
          select: { id: true, departmentId: true, status: true },
        });
        if (
          !taskIds.length ||
          tasks.length !== taskIds.length ||
          tasks.some((task) =>
            task.status === "completed" ||
            (scope !== null && (!task.departmentId || !scope.includes(task.departmentId)))
          )
        ) {
          throw new Error("That task can no longer be undone.");
        }
        const now = new Date();
        await tx.taskAssignment.updateMany({
          where: {
            taskId: { in: taskIds },
            status: { notIn: ["completed", "withdrawn", "cancelled"] },
            clockInTime: { not: null },
            clockOutTime: null,
          },
          data: {
            status: "cancelled",
            clockOutTime: now,
            cancelledAt: now,
            cancelledById: input.userId,
            cancellationReason: "Assistant operation undone",
          },
        });
        await tx.taskAssignment.updateMany({
          where: {
            taskId: { in: taskIds },
            status: { notIn: ["completed", "withdrawn", "cancelled"] },
          },
          data: {
            status: "cancelled",
            cancelledAt: now,
            cancelledById: input.userId,
            cancellationReason: "Assistant operation undone",
          },
        });
        await tx.task.updateMany({
          where: { id: { in: taskIds }, organizationId: input.organizationId },
          data: { status: "cancelled" },
        });
        await tx.assistantOperation.update({
          where: { id: operation.id },
          data: { undoneAt: now, status: "undone" },
        });
        return { kind: "task" as const, count: tasks.length, ids: taskIds };
      }

      this.assertPermission(input.membership, PERMISSIONS.TASKS_ASSIGN);
      const assignmentIds = [...new Set(targets.assignmentIds ?? [])];
      const assignments = await tx.taskAssignment.findMany({
        where: {
          id: { in: assignmentIds },
          assignedById: input.userId,
          task: { organizationId: input.organizationId },
        },
        include: { task: { select: { departmentId: true } } },
      });
      if (
        !assignmentIds.length ||
        assignments.length !== assignmentIds.length ||
        assignments.some((assignment) =>
          ["completed", "withdrawn", "cancelled"].includes(assignment.status) ||
          (scope !== null &&
            (!assignment.task.departmentId || !scope.includes(assignment.task.departmentId)))
        )
      ) {
        throw new Error("Those assignments can no longer be undone.");
      }
      const now = new Date();
      for (const assignment of assignments) {
        await tx.taskAssignment.update({
          where: { id: assignment.id },
          data: {
            status: "cancelled",
            cancelledAt: now,
            cancelledById: input.userId,
            cancellationReason: "Assistant operation undone",
            ...(assignment.clockInTime && !assignment.clockOutTime
              ? { clockOutTime: now }
              : {}),
          },
        });
      }
      await tx.assistantOperation.update({
        where: { id: operation.id },
        data: { undoneAt: now, status: "undone" },
      });
      return { kind: "assignments" as const, count: assignments.length, ids: assignmentIds };
    }, { isolationLevel: "Serializable" });

    await this.auditService.log({
      organizationId: input.organizationId,
      userId: input.userId,
      action: outcome.kind === "task" ? ACTIONS.TASK_CANCELLED : ACTIONS.TASK_UNASSIGNED,
      entityType: "ai-operation",
      entityId: input.operationId,
      details: { undoneIds: outcome.ids },
    });
    return {
      message: `${outcome.count} ${outcome.kind === "task" ? "task" : "assignment"}${outcome.count === 1 ? " was" : "s were"} undone.`,
    };
  }

  private assertPermission(membership: MembershipContext, permission: PermissionName) {
    if (!hasPermission(membership, permission)) {
      throw new Error("You do not have permission to perform that operation.");
    }
  }

  private async handleStaff(text: string, organizationId: string, membershipId: string): Promise<ExecutionResult> {
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
  ): Promise<ExecutionResult> {
    const scope = departmentScopeFor(membership);
    if (/(break down|project plan|plan .*project|create tasks for)/.test(text)) {
      this.assertPermission(membership, PERMISSIONS.TASKS_CREATE);
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
        // The assistant plans work items, not a persistent team. A manager
        // switches the project to Project Team staffing when they want one.
        staffingMode: "task_based",
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
      this.assertPermission(membership, PERMISSIONS.SCHEDULE_GENERATE);
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
      this.assertPermission(membership, PERMISSIONS.ALLOCATION_AUTO_ALLOCATE);
      this.assertPermission(membership, PERMISSIONS.TASKS_ASSIGN);
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

    if (!this.isManagerMutationIntent(text)) {
      return {
        status: "needs_review",
        title: "I need a more specific request",
        message:
          "Ask me to check a schedule or coverage, or explicitly ask me to create a task. I will not infer a write operation from an ambiguous request.",
        actions: [{ label: "Open tasks", href: `/org/${organizationId}/tasks` }],
      };
    }
    this.assertPermission(membership, PERMISSIONS.TASKS_CREATE);
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
      undoTargets: taskResult.status === "completed" && taskId
        ? { kind: "task", taskIds: [taskId] }
        : undefined,
    };
  }

  private async handleAdmin(text: string, organizationId: string): Promise<ExecutionResult> {
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
