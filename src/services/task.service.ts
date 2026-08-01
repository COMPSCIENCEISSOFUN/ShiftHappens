/**
 * Task Service (Control Layer)
 *
 * Business logic for task management including:
 * - Task CRUD with schedule validation
 * - Staff assignment with headcount and conflict checks
 * - Smart-swap: automatic replacement suggestions on cancellation
 * - Department and staff task views
 * - Notification triggers on assignment
 */
import { TaskRepository } from "@/repositories/task.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { SettingsRepository } from "@/repositories/settings.repository";
import { MembershipRepository } from "@/repositories/membership.repository";
import { EligibilityService } from "@/services/eligibility.service";
import type { CreateTaskInput, UpdateTaskInput } from "@/lib/validations";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { SubscriptionService } from "@/services/subscription.service";
import { EligibilityOverrideRepository } from "@/repositories/eligibility-override.repository";
import {
  RecurringTaskService,
  DEFAULT_HORIZON_DAYS,
} from "@/services/recurring-task.service";
import { parseRecurrencePattern } from "@/lib/recurrence";
import {
  ASSIGNMENT_STATUSES,
  SLOT_OCCUPYING_ASSIGNMENT_STATUSES,
} from "@/lib/assignment-status";

export class TaskService {
  private taskRepo = new TaskRepository();
  private recurringTaskService = new RecurringTaskService();
  private assignmentRepo = new TaskAssignmentRepository();
  private membershipRepo = new MembershipRepository();
  private settingsRepo = new SettingsRepository();
  private auditService = new AuditLogService();
  private notificationService = new NotificationService();
  private eligibilityService = new EligibilityService();
  private overrideRepo = new EligibilityOverrideRepository();
  private subscriptionService = new SubscriptionService();

  async create(input: CreateTaskInput, orgId: string, userId: string) {
    await this.subscriptionService.enforceResourceLimit(orgId, 'active_tasks');
    
    if ((input.scheduledStart && !input.scheduledEnd) || (!input.scheduledStart && input.scheduledEnd)) {
      throw new Error("Must provide both start and end time, or neither");
    }

    if (input.scheduledStart && input.scheduledEnd) {
      const start = new Date(input.scheduledStart);
      const end = new Date(input.scheduledEnd);
      if (end <= start) {
        throw new Error("End time must be after start time");
      }
    }

    // A recurring series needs a schedule (it defines the time-of-day and
    // duration every occurrence inherits) and a pattern we can actually read.
    if (input.isRecurring) {
      if (!input.scheduledStart || !input.scheduledEnd) {
        throw new Error("A recurring task must have a start and end time");
      }
      if (!parseRecurrencePattern(input.recurringPattern ?? null)) {
        throw new Error("Invalid recurrence pattern");
      }
    }

    const task = await this.taskRepo.create({
      title: input.title,
      description: input.description,
      organizationId: orgId,
      departmentId: input.departmentId,
      requiredHeadcount: input.requiredHeadcount,
      requiredCertifications: input.requiredCertifications,
      priority: input.priority,
      scheduledStart: input.scheduledStart ? new Date(input.scheduledStart) : undefined,
      scheduledEnd: input.scheduledEnd ? new Date(input.scheduledEnd) : undefined,
      isRecurring: input.isRecurring,
      recurringPattern: input.recurringPattern,
      createdById: userId,
    });

    await this.auditService.log({
      organizationId: orgId,
      userId,
      action: ACTIONS.TASK_CREATED,
      entityType: "task",
      entityId: task.id,
      details: { title: task.title, department: task.departmentId },
    });

    // Materialise the series' upcoming occurrences straight away, so a new
    // recurring task immediately shows its future shifts. Awaited (not
    // fire-and-forget) so the caller's task list reflects them on refetch.
    if (task.isRecurring) {
      try {
        await this.recurringTaskService.generateForOrganization(
          orgId,
          DEFAULT_HORIZON_DAYS,
          userId
        );
      } catch (error) {
        // The series exists — a failed expansion can be retried by the
        // scheduled run, so never fail the create.
        console.error("[Recurring Generation Error]", error);
      }
    }

    // In "auto" allocation mode the system fills the task itself (US-65).
    await this.autoAllocateIfEnabled(task.id, orgId, userId);

    return task;
  }

  /**
   * Fills a task with best-fit staff when the org runs in "auto" allocation
   * mode. Never fails the create — an unfilled task is still a valid task, and
   * a manager can assign (or re-run auto-assign) manually.
   */
  private async autoAllocateIfEnabled(
    taskId: string,
    orgId: string,
    userId: string
  ) {
    try {
      const settings = await this.settingsRepo.getOrCreate(orgId);
      if (settings.allocationMode !== "auto") return;

      // Imported lazily: AllocationService holds a TaskService, so making it a
      // field here would make the two constructors recurse forever.
      const { AllocationService } = await import("@/services/allocation.service");
      await new AllocationService().autoAllocate(taskId, orgId, userId);
    } catch (error) {
      // "No eligible staff found" is a normal outcome, not a failure.
      console.error("[Auto-Allocate Error]", error);
    }
  }

  /**
   * Lists an org's tasks, optionally limited to a department scope.
   * `departmentScope` null/undefined = unrestricted (company admin); an array
   * limits results to those departments (a scoped manager). Tasks with no
   * department are excluded for scoped callers.
   */
  async getByOrganization(
    organizationId: string,
    filters?: { status?: string; departmentId?: string; priority?: string },
    departmentScope?: string[] | null
  ) {
    const tasks = await this.taskRepo.findByOrganizationId(organizationId, filters);
    if (departmentScope === undefined || departmentScope === null) {
      return tasks;
    }
    const scope = new Set(departmentScope);
    return tasks.filter((t) => t.departmentId !== null && scope.has(t.departmentId));
  }

  /**
   * Fetches a task, but only if it belongs to the given organization.
   * Returns null for a missing task OR one owned by another tenant —
   * callers must never be able to read across org boundaries by ID.
   */
  async getById(taskId: string, orgId: string) {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== orgId) return null;
    return task;
  }

  async update(taskId: string, orgId: string, input: UpdateTaskInput) {
    const task = await this.taskRepo.findById(taskId);
    // Treat a cross-tenant task as non-existent — no read or write across orgs.
    if (!task || task.organizationId !== orgId) throw new Error("Task not found");

    const startProvided = "scheduledStart" in input;
    const endProvided = "scheduledEnd" in input;
    const newStart = startProvided ? (input.scheduledStart || null) : (task.scheduledStart?.toISOString() ?? null);
    const newEnd = endProvided ? (input.scheduledEnd || null) : (task.scheduledEnd?.toISOString() ?? null);

    if ((newStart && !newEnd) || (!newStart && newEnd)) {
      throw new Error("Must provide both start and end time, or clear both");
    }

    if (newStart && newEnd) {
      const start = new Date(newStart);
      const end = new Date(newEnd);
      if (end <= start) {
        throw new Error("End time must be after start time");
      }
    }

    // Did the schedule actually move? Compare instants, not raw strings —
    // the client sends datetime-local values that differ textually from ISO.
    const toTime = (v: string | null) => (v ? new Date(v).getTime() : null);
    const scheduleChanged =
      toTime(newStart) !== (task.scheduledStart?.getTime() ?? null) ||
      toTime(newEnd) !== (task.scheduledEnd?.getTime() ?? null);
    const nowCancelled =
      input.status === "cancelled" && task.status !== "cancelled";
    const affectedUserIds = this.stillAssignedUserIds(task);

    const updated = await this.taskRepo.update(taskId, {
      title: input.title,
      description: input.description,
      departmentId: input.departmentId,
      requiredHeadcount: input.requiredHeadcount,
      requiredCertifications: input.requiredCertifications,
      priority: input.priority,
      status: input.status,
      scheduledStart: input.scheduledStart ? new Date(input.scheduledStart) : null,
      scheduledEnd: input.scheduledEnd ? new Date(input.scheduledEnd) : null,
    });

    await this.auditService.log({
      organizationId: orgId,
      action: ACTIONS.TASK_UPDATED,
      entityType: "task",
      entityId: taskId,
      details: input,
    });

    if (nowCancelled) {
      void this.notificationService.notifyManyIfEnabled(
        orgId,
        affectedUserIds,
        NOTIFICATION_TYPES.TASK_CANCELLED,
        "Task cancelled",
        `"${updated.title}" was cancelled — you're no longer scheduled for it.`,
        "task",
        taskId
      );
    } else if (scheduleChanged) {
      void this.notificationService.notifyManyIfEnabled(
        orgId,
        affectedUserIds,
        NOTIFICATION_TYPES.TASK_RESCHEDULED,
        "Task rescheduled",
        `"${updated.title}" was rescheduled. Check your tasks for the new time.`,
        "task",
        taskId
      );

      // The new time may have made assigned staff ineligible (conflict, hour
      // limit, unavailable) — let managers know. Fire-and-forget.
      void this.notifyManagersOfIneligibleAssignees(taskId, orgId, updated.title);
    }

    return updated;
  }

  /**
   * Re-runs eligibility for a task and alerts managers about any staff who are
   * STILL ASSIGNED but no longer eligible (e.g. after a reschedule).
   * Fire-and-forget — never blocks or fails the update.
   */
  private async notifyManagersOfIneligibleAssignees(
    taskId: string,
    orgId: string,
    taskTitle: string
  ) {
    try {
      const task = await this.taskRepo.findById(taskId);
      if (!task) return;

      const assignedIds = new Set(
        task.assignments
          .filter((a) =>
            (SLOT_OCCUPYING_ASSIGNMENT_STATUSES as string[]).includes(a.status)
          )
          .map((a) => a.membershipId)
      );
      if (assignedIds.size === 0) return;

      const eligibility = await this.eligibilityService.checkEligibilityForTask(
        taskId,
        orgId
      );

      const nowIneligible = eligibility.filter(
        (e) => assignedIds.has(e.membershipId) && !e.eligible
      );
      if (nowIneligible.length === 0) return;

      const managers = (await this.membershipRepo.findByOrgId(orgId)).filter(
        (m) =>
          m.status === "active" &&
          ["company_admin", "manager"].includes(m.role)
      );
      if (managers.length === 0) return;

      const names = nowIneligible.map((e) => e.memberName).join(", ");
      await this.notificationService.notifyManyIfEnabled(
        orgId,
        managers.map((m) => m.userId),
        NOTIFICATION_TYPES.STAFF_INELIGIBLE,
        "Assigned staff no longer eligible",
        `After the change to "${taskTitle}", these assigned staff are no longer eligible: ${names}.`,
        "task",
        taskId
      );
    } catch (error) {
      console.error("[Ineligible Assignee Check Error]", error);
    }
  }

  async delete(taskId: string, orgId: string) {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== orgId) throw new Error("Task not found");

    // Capture who to tell before the task (and its assignments) are gone.
    const affectedUserIds = this.stillAssignedUserIds(task);

    await this.taskRepo.delete(taskId);

    await this.auditService.log({
      organizationId: orgId,
      action: ACTIONS.TASK_DELETED,
      entityType: "task",
      entityId: taskId,
      details: { title: task.title },
    });

    void this.notificationService.notifyManyIfEnabled(
      orgId,
      affectedUserIds,
      NOTIFICATION_TYPES.TASK_CANCELLED,
      "Task cancelled",
      `"${task.title}" was cancelled — you're no longer scheduled for it.`,
      "task",
      taskId
    );
  }

  /**
   * User IDs of staff still holding a slot on a task (i.e. would be affected
   * if it's cancelled or rescheduled). Excludes withdrawn/cancelled/finished.
   */
  private stillAssignedUserIds(task: {
    assignments: {
      status: string;
      membership: { userId: string } | null;
    }[];
  }): string[] {
    return task.assignments
      .filter(
        (a) =>
          (SLOT_OCCUPYING_ASSIGNMENT_STATUSES as string[]).includes(a.status) &&
          a.membership?.userId
      )
      .map((a) => a.membership!.userId);
  }

  /**
   * Assigns staff members to a task.
   * Checks headcount, admin guard, scheduling conflicts.
   * Notifies each assigned staff member (fire-and-forget).
   */
  async assignStaff(
    taskId: string,
    organizationId: string,
    membershipIds: string[],
    assignedById: string
  ) {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== organizationId) throw new Error("Task not found");

    const currentCount = await this.assignmentRepo.countActiveByTaskId(taskId);
    if (currentCount + membershipIds.length > task.requiredHeadcount) {
      throw new Error(
        `Assignment exceeds required headcount of ${task.requiredHeadcount}`
      );
    }

    for (const membId of membershipIds) {
      const membership = await this.membershipRepo.findById(membId);
      // A membership from another tenant must never be assignable to this
      // org's task — validate ownership before any role check.
      if (!membership || membership.organizationId !== organizationId) {
        throw new Error("Staff member does not belong to this organization");
      }
      if (membership.role === "company_admin") {
        throw new Error("Company Admins cannot be assigned to tasks");
      }
    }

    if (task.scheduledStart && task.scheduledEnd) {
      for (const membId of membershipIds) {
        const conflicts = await this.taskRepo.findConflictingTasks(
          membId,
          task.scheduledStart,
          task.scheduledEnd,
          taskId
        );
        if (conflicts.length > 0) {
          // A manager can override a scheduling conflict with a documented
          // reason (recorded as an eligibility override before assigning).
          const overridden =
            (await this.overrideRepo.hasOverride(taskId, membId, "scheduling")) ||
            (await this.overrideRepo.hasOverride(taskId, membId, "all"));
          if (!overridden) {
            throw new Error(
              `Staff has a scheduling conflict with "${conflicts[0].title}"`
            );
          }
        }
      }
    }

    const assignments = [];
    for (const membId of membershipIds) {
      const assignment = await this.assignmentRepo.create({
        taskId,
        membershipId: membId,
        assignedById,
        status: ASSIGNMENT_STATUSES.ASSIGNED,
      });
      assignments.push(assignment);
    }

    await this.auditService.log({
      organizationId,
      userId: assignedById,
      action: ACTIONS.TASK_ASSIGNED,
      entityType: "task",
      entityId: taskId,
      details: { membershipIds, status: ASSIGNMENT_STATUSES.ASSIGNED },
    });

    for (const membId of membershipIds) {
      const membership = await this.membershipRepo.findById(membId);
      if (membership) {
        void this.notificationService.notifyIfEnabled(
          organizationId,
          membership.userId,
          NOTIFICATION_TYPES.TASK_ASSIGNED,
          "New task assignment",
          `You've been assigned to "${task.title}"`,
          "assignment",
          taskId
        );
      }
    }

    return assignments;
  }

  /**
   * Cancels a task assignment — admin/manager action.
   * After cancellation, checks if the task is now understaffed.
   * If understaffed, runs smart-swap: finds eligible replacements
   * and notifies the admin with the top recommendation.
   */
  async cancelAssignment(assignmentId: string, orgId: string, userId?: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    // Scope by the assignment's task org — a manager in one tenant cannot
    // cancel assignments belonging to another tenant.
    if (!assignment || assignment.task.organizationId !== orgId) {
      throw new Error("Assignment not found");
    }

    if (assignment.status === "completed") {
      throw new Error("Cannot cancel a completed assignment");
    }

    const result = await this.assignmentRepo.cancel(assignmentId);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId,
      action: ACTIONS.TASK_UNASSIGNED,
      entityType: "assignment",
      entityId: assignmentId,
    });

    // Tell the staff member they were removed from the task.
    if (assignment.membership?.userId) {
      void this.notificationService.notifyIfEnabled(
        assignment.task.organizationId,
        assignment.membership.userId,
        NOTIFICATION_TYPES.TASK_UNASSIGNED,
        "Removed from a task",
        `You're no longer assigned to "${assignment.task.title}"`,
        "task",
        assignment.task.id
      );
    }

    // Smart-swap: check if task is now understaffed and suggest replacement
    void this.suggestReplacement(
      assignment.task.id,
      assignment.task.organizationId,
      assignment.task.title,
      assignment.task.requiredHeadcount,
      assignment.membership?.user?.name || "A staff member",
      userId
    );

    return result;
  }

  /**
   * Smart-swap: Finds eligible replacement staff for an understaffed task
   * and notifies the admin with the top recommendation.
   * Fire-and-forget — never blocks or fails the cancellation.
   */
  private async suggestReplacement(
    taskId: string,
    organizationId: string,
    taskTitle: string,
    requiredHeadcount: number,
    cancelledStaffName: string,
    adminUserId?: string
  ) {
    try {
      // Check if the task is now understaffed
      const activeCount = await this.assignmentRepo.countActiveByTaskId(taskId);
      if (activeCount >= requiredHeadcount) return;

      const needed = requiredHeadcount - activeCount;

      // Run eligibility to find available replacements
      const eligibility = await this.eligibilityService.checkEligibilityForTask(
        taskId,
        organizationId
      );

      const eligibleStaff = eligibility
        .filter((e) => e.eligible)
        .map((e) => e.memberName);

      if (eligibleStaff.length === 0) {
        // Notify admin that no replacements are available
        if (adminUserId) {
          void this.notificationService.notify(
            organizationId,
            adminUserId,
            NOTIFICATION_TYPES.TASK_ASSIGNED,
            "Staff unassigned — no replacements",
            `${cancelledStaffName} was removed from "${taskTitle}". No eligible staff available to fill the gap.`,
            "task",
            taskId
          );
        }
        return;
      }

      // Notify admin with top replacement suggestions
      const topSuggestions = eligibleStaff.slice(0, 3).join(", ");
      const message = `${cancelledStaffName} was removed from "${taskTitle}" (needs ${needed} more). Recommended: ${topSuggestions}`;

      if (adminUserId) {
        void this.notificationService.notify(
          organizationId,
          adminUserId,
          NOTIFICATION_TYPES.TASK_ASSIGNED,
          "Smart swap — replacement suggested",
          message,
          "task",
          taskId
        );
      }
    } catch (error) {
      console.error("[Smart-Swap Error]", error);
    }
  }

  async getTasksByDepartment(departmentId: string) {
    return this.taskRepo.findByDepartmentId(departmentId);
  }

  async getStaffTasks(membershipId: string, status?: string) {
    return this.assignmentRepo.findByMembershipId(membershipId, status);
  }

  async getTaskCounts(organizationId: string) {
    const tasks = await this.taskRepo.findByOrganizationId(organizationId);

    const counts = {
      total: tasks.length,
      open: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    };

    for (const task of tasks) {
      if (task.status === "open") counts.open++;
      else if (task.status === "in_progress") counts.in_progress++;
      else if (task.status === "completed") counts.completed++;
      else if (task.status === "cancelled") counts.cancelled++;
    }

    return counts;
  }
}
