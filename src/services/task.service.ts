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
import { DepartmentRepository } from "@/repositories/department.repository";
import { EligibilityService } from "@/services/eligibility.service";
import type { CreateTaskInput, UpdateTaskInput } from "@/lib/validations";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import type { AllocationProvenance } from "@/lib/allocation-provenance";
import { taskWatcherUserIds } from "@/services/task-watchers";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { SubscriptionService } from "@/services/subscription.service";
import { EligibilityOverrideRepository } from "@/repositories/eligibility-override.repository";
import {
  RecurringTaskService,
  DEFAULT_HORIZON_DAYS,
} from "@/services/recurring-task.service";
import { parseRecurrencePattern } from "@/lib/recurrence";
import { CompositionService } from "@/services/composition.service";
import {
  infeasibilityMessage,
  parseCompositionRules,
  serialiseCompositionRules,
} from "@/lib/composition-rules";
import { occupiesSlot, wasWorked } from "@/lib/assignment-status";
import { canBeRostered } from "@/lib/role-config";

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
  private compositionService = new CompositionService();
  private deptRepo = new DepartmentRepository();


  /**
   * Refuses a department id that belongs to another tenant.
   *
   * `departmentId` arrives from the request body and was written straight
   * through. A scoped manager is stopped at the route by `isDepartmentInScope`,
   * but a company admin's scope is null, so any admin who knew a cuid from
   * another organisation could create a task in their own org whose department
   * FK pointed into someone else's.
   *
   * The consequences are not theoretical: every task read select includes
   * `department: { id, name, color }`, so the FOREIGN department's name and
   * colour came back inside this org's task payloads. The task also fell out of
   * every department-scoped view — it matches no local department — and was
   * evaluated against the wrong department's work rules.
   *
   * `EligibilityService.createOverride` already does exactly this for
   * `membershipId`; the task paths were the ones still missing it.
   */
  private async assertDepartmentOwned(
    departmentId: string,
    organizationId: string
  ) {
    const dept = await this.deptRepo.findById(departmentId);
    if (!dept || dept.organizationId !== organizationId) {
      throw new Error("Department not found");
    }
  }

  async create(input: CreateTaskInput, orgId: string, userId: string) {
    await this.subscriptionService.enforceResourceLimit(orgId, 'active_tasks');

    if (input.departmentId) {
      await this.assertDepartmentOwned(input.departmentId, orgId);
    }
    
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
      compositionRules: input.compositionRules
        ? serialiseCompositionRules(input.compositionRules)
        : null,
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

    // Same reason as create — a moved task must not land in another tenant's
    // department. `"departmentId" in input` with a falsy value clears it, which
    // needs no ownership check.
    if (input.departmentId) {
      await this.assertDepartmentOwned(input.departmentId, orgId);
    }

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

    /*
     * Which edits can invalidate an existing assignment.
     *
     * The re-check used to hang off `scheduleChanged` alone, which covered only
     * one of the three. Moving a task to another department applies that
     * department's work rules instead — and changing the required
     * certifications can strand someone who does not hold the new ones. Both
     * left the roster silently wrong.
     *
     * The staff-facing "rescheduled" notice stays tied to the schedule, which
     * is the only one of the three staff need to act on. This is the manager's
     * check, and it needs the wider trigger.
     */
    const departmentChanged =
      "departmentId" in input &&
      (input.departmentId || null) !== task.departmentId;
    const certificationsChanged =
      input.requiredCertifications !== undefined &&
      // Order is not meaningful — a reordered list is the same requirement.
      [...input.requiredCertifications].sort().join("|") !==
        [...task.requiredCertifications].sort().join("|");
    const eligibilityMayHaveChanged =
      scheduleChanged || departmentChanged || certificationsChanged;

    const updated = await this.taskRepo.update(taskId, {
      title: input.title,
      description: input.description,
      // Absent key → leave the department alone (Prisma ignores `undefined`).
      // Explicit null or "" → clear it. Without the `in` check there was no way
      // to move a task back to "No department": the UI sent `undefined`, Prisma
      // dropped it, and the save reported success while changing nothing.
      departmentId:
        "departmentId" in input ? input.departmentId || null : undefined,
      requiredHeadcount: input.requiredHeadcount,
      requiredCertifications: input.requiredCertifications,
      priority: input.priority,
      status: input.status,
      // Absent key → leave the rules alone; an explicit empty array clears
      // them. `serialiseCompositionRules([])` returns null, which is the
      // stored form of "no constraints", so the two cases stay distinct
      // without a second flag.
      compositionRules:
        input.compositionRules === undefined
          ? undefined
          : serialiseCompositionRules(input.compositionRules),
      // Write the RESOLVED values, not the raw input. `newStart`/`newEnd` above
      // already fall back to the task's stored schedule when the caller omitted
      // the keys, which is what a partial update means. Writing
      // `input.scheduledStart ? … : null` here instead discarded that work and
      // nulled both columns on any PATCH that did not resend them — so changing
      // only `status` silently erased the shift's time.
      scheduledStart: newStart ? new Date(newStart) : null,
      scheduledEnd: newEnd ? new Date(newEnd) : null,
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

    }

    // Any edit that can invalidate an assignment — a new time, a new
    // department, new certification requirements — gets the managers' check.
    // Deliberately outside the reschedule branch: a department change sends no
    // staff notification but is exactly as capable of stranding someone.
    // Fire-and-forget, and skipped for a cancellation, where the assignments
    // are moot anyway.
    if (!nowCancelled && eligibilityMayHaveChanged) {
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
            occupiesSlot(a.status)
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

      // Company admins, plus managers of THIS task's department. This used to
      // be every admin and manager in the organisation, which meant a manager
      // who cannot read another department's roster was still told, by name,
      // who on it had just become ineligible.
      const watchers = await taskWatcherUserIds(orgId, task.departmentId);
      if (watchers.length === 0) return;

      const names = nowIneligible.map((e) => e.memberName).join(", ");
      await this.notificationService.notifyManyIfEnabled(
        orgId,
        watchers,
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

  /**
   * Deletes a task — unless anybody actually worked it.
   *
   * ## Why a guard rather than an archive
   *
   * There was no check at all, and the cascade is wide: `TaskAssignment`,
   * `EligibilityOverride`, and — because `parentTaskId` is `onDelete: Cascade`
   * — every generated instance of a recurring series.
   *
   * Completed assignments are the evidence SENIORITY is derived from, so
   * deleting old tasks silently dropped people's levels, which changes who a
   * composition rule will admit onto future shifts. Reporting lost its source
   * at the same time. The inconsistency was already visible in this service:
   * `cancelAssignment` refuses to cancel a COMPLETED assignment, and then this
   * method deleted the whole task underneath it without asking.
   *
   * An archive column was the other candidate and was rejected. A task created
   * by mistake and never worked should stay deletable — a permanent record of
   * typos helps nobody — and `status: "cancelled"` already means "this was real
   * and is not happening". An `archivedAt` column would add a filter obligation
   * to EVERY query touching tasks, which is the "every select" rule of the
   * new-field checklist and precisely where this codebase has produced bugs
   * before.
   *
   * A shift in progress is `accepted` with a `clockInTime`, not a status of its
   * own, so that column is checked separately rather than through
   * `wasWorked`.
   */
  async delete(taskId: string, orgId: string) {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== orgId) throw new Error("Task not found");

    const worked = (task.assignments ?? []).filter(
      (a: { status: string; clockInTime?: Date | null }) =>
        wasWorked(a.status) || Boolean(a.clockInTime)
    );
    if (worked.length > 0) {
      throw new Error(
        `This shift has been worked by ${worked.length} ${
          worked.length === 1 ? "person" : "people"
        } — cancel it instead of deleting, so the record stays.`
      );
    }

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
   * if it's cancelled or rescheduled). Excludes rejected/withdrawn/finished.
   */
  private stillAssignedUserIds(task: {
    assignments: {
      status: string;
      membership: { userId: string } | null;
    }[];
  }): string[] {
    return task.assignments
      .filter((a) => occupiesSlot(a.status) && a.membership?.userId)
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
    assignedById: string,
    /**
     * How the choice was made. Optional, and its absence is meaningful: a
     * caller that does not pass it leaves the columns NULL rather than
     * claiming a human decided, which would inflate the manual count with
     * every assignment made by a path nobody has instrumented yet.
     */
    provenance?: AllocationProvenance,
    /**
     * Forces the assignment to be written `pending` — an OFFER the member
     * accepts or declines — whatever the organisation's `taskAcceptanceMode`
     * says.
     *
     * Exists for the leave backfill. A member picked to cover somebody's
     * approved leave may be a full-timer whose all-week availability was opened
     * by default rather than chosen, so "eligible" is a weaker claim about them
     * than it is about a casual who typed their hours in. Under `auto_accept`
     * they would otherwise wake up committed to a shift nobody asked them
     * about.
     *
     * Only ever tightens: an org already on `require_acceptance` is unaffected.
     */
    options?: { asOffer?: boolean }
  ) {
    const task = await this.taskRepo.findById(taskId);
    if (!task || task.organizationId !== organizationId) throw new Error("Task not found");

    /*
     * De-duplicated before anything is counted.
     *
     * `membershipIds` arrives from the request body as a bare array of strings,
     * so `["m1","m1"]` is a well-formed request. It used to charge two against
     * the headcount and then create one row and fail on the second, leaving the
     * caller a 500 and the task half-assigned.
     */
    const uniqueIds = [...new Set(membershipIds)];

    /*
     * A released row still occupies the unique key.
     *
     * `TaskAssignment` is unique on `(taskId, membershipId)` and rejecting a
     * shift does not delete the row — it sets `status: "rejected"`. So the slot
     * is free, the eligibility engine still lists the person, the UI offers
     * them, and `create` throws P2002. The route had no branch for it, so
     * re-offering a shift to whoever turned it down answered "Internal server
     * error". Named here instead, where the reason is known.
     */
    const existingRows = await this.assignmentRepo.findByTaskId(taskId);
    const alreadyOnTask = new Set(existingRows.map((a) => a.membershipId));
    const duplicate = uniqueIds.find((id) => alreadyOnTask.has(id));
    if (duplicate) {
      const name =
        existingRows.find((a) => a.membershipId === duplicate)?.membership.user
          ?.name ?? "That staff member";
      throw new Error(
        `${name} already has a record on this task — remove it before assigning them again`
      );
    }

    const currentCount = await this.assignmentRepo.countActiveByTaskId(taskId);
    if (currentCount + uniqueIds.length > task.requiredHeadcount) {
      throw new Error(
        `Assignment exceeds required headcount of ${task.requiredHeadcount}`
      );
    }

    for (const membId of uniqueIds) {
      const membership = await this.membershipRepo.findById(membId);
      // A membership from another tenant must never be assignable to this
      // org's task — validate ownership before any role check.
      if (!membership || membership.organizationId !== organizationId) {
        throw new Error("Staff member does not belong to this organization");
      }
      // `findById` has no status filter, so a deactivated membership arrives
      // here looking exactly like an active one. The candidate lists the UI
      // offers are already filtered, but this path takes ids straight from the
      // request body — without this check a deactivated employee can still be
      // rostered, which is the same privilege leak the active-only default on
      // findByUserAndOrg was introduced to close.
      if (membership.status !== "active") {
        throw new Error("Staff member is deactivated");
      }
      if (!canBeRostered(membership.role)) {
        throw new Error("Company Admins cannot be assigned to tasks");
      }
    }

    if (task.scheduledStart && task.scheduledEnd) {
      for (const membId of uniqueIds) {
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

    // Composition rules, checked last among the gates because it is the only
    // one that depends on the whole batch rather than on each member — the
    // per-member checks above must have culled anyone invalid before the
    // resulting roster is judged.
    //
    // The test is FEASIBILITY, not satisfaction. A manager filling a
    // two-person shift one at a time must not be refused on the first person
    // for a rule the second could still meet; the refusal comes when the rule
    // is put beyond reach — an "at least" rule with no slots left to meet it,
    // or an "at most" rule already exceeded.
    if (parseCompositionRules(task.compositionRules).length > 0) {
      const evaluation = await this.compositionService.evaluateForTask(
        taskId,
        uniqueIds
      );

      if (!evaluation.feasible) {
        // Same escape hatch as a scheduling conflict: a manager who has
        // documented a reason may proceed. Rules about the shape of a roster
        // meet real exceptions — a trainee shadowing, a quiet night — and a
        // constraint with no override is one that gets removed entirely the
        // first time it is inconvenient.
        const overridden = (
          await Promise.all(
            uniqueIds.flatMap((membId) => [
              this.overrideRepo.hasOverride(taskId, membId, "composition"),
              this.overrideRepo.hasOverride(taskId, membId, "all"),
            ])
          )
        ).some(Boolean);

        if (!overridden) {
          throw new Error(
            infeasibilityMessage(evaluation) ?? "Assignment breaks a composition rule"
          );
        }
      }
    }

    const settings = await this.settingsRepo.getOrCreate(organizationId);
    const autoAccept =
      settings.taskAcceptanceMode === "auto_accept" && !options?.asOffer;

    /*
     * Who is being asked to work a time they said they could not.
     *
     * A manager may waive an availability block, with a reason — that is a
     * legitimate and necessary thing to do, because a venue short on Saturday
     * WILL ring the person who said no. What it must not become is a booking.
     *
     * So the waiver is an ask: the assignment is written `pending` for that
     * member however the organisation has `taskAcceptanceMode` set. Availability
     * that somebody explicitly closed is a stronger statement than availability
     * merely left open by default — and `asOffer` already refuses to auto-book
     * on the weaker one, for the leave backfill. Auto-booking someone over their
     * own stated unavailability would be the system overruling a person, which
     * no setting should be able to express.
     *
     * Per member, not per call: one assignment may mix a waived candidate with
     * three ordinary ones, and the ordinary three should still auto-accept where
     * the organisation asked for that.
     */
    const asked = new Set<string>();
    if (autoAccept) {
      const flags = await Promise.all(
        uniqueIds.map(async (membId) => {
          const hits = await Promise.all(
            EligibilityOverrideRepository.CONSENT_RULES.map((rule) =>
              this.overrideRepo.hasOverride(taskId, membId, rule)
            )
          );
          return [membId, hits.some(Boolean)] as const;
        })
      );
      for (const [membId, waived] of flags) if (waived) asked.add(membId);
    }

    const assignments = [];
    for (const membId of uniqueIds) {
      const engine = provenance?.byMembership?.[membId];
      const assignmentStatus =
        autoAccept && !asked.has(membId) ? "accepted" : "pending";
      const assignment = await this.assignmentRepo.create({
        taskId,
        membershipId: membId,
        assignedById,
        status: assignmentStatus,
        allocationSource: provenance?.source,
        allocationProvider: provenance?.provider,
        allocationScore: engine?.score,
        allocationRank: engine?.rank,
      });
      assignments.push(assignment);
    }

    await this.auditService.log({
      organizationId,
      userId: assignedById,
      action: ACTIONS.TASK_ASSIGNED,
      entityType: "task",
      entityId: taskId,
      details: {
        membershipIds: uniqueIds,
        // The status the organisation's setting called for. Members whose
        // availability was waived were written `pending` regardless; the
        // override rows are the record of which and why.
        status: autoAccept ? "accepted" : "pending",
        askedDespiteUnavailable: [...asked],
        allocationSource: provenance?.source ?? null,
        allocationProvider: provenance?.provider ?? null,
      },
    });

    for (const membId of uniqueIds) {
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
  async cancelAssignment(
    assignmentId: string,
    orgId: string,
    userId?: string,
    /**
     * Suppresses the generic smart-swap notification below.
     *
     * The leave path sends its own, because it knows something this one does
     * not: WHY the shift is short, and what the organisation's allocation mode
     * says should happen next. Two notifications about the same hole — one
     * saying "removed, here are three names", one saying "approved leave, offer
     * sent to Jamie" — is how a manager learns to ignore both.
     */
    options?: { suppressSuggestion?: boolean }
  ) {
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
    if (options?.suppressSuggestion) return result;

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