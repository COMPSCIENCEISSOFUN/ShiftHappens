/**
 * TaskAssignment Service (Control Layer)
 *
 * Business logic for task assignment lifecycle:
 * - Accept/reject assignments (staff actions)
 * - Clock in/out (time tracking)
 * - Notification triggers on accept/reject
 *
 * Enforces status transition rules:
 * - pending → accepted (accept)
 * - pending → rejected (reject, requires reason)
 * - accepted → clocked in (clockIn)
 * - clocked in → completed (clockOut)
 *
 * Authorization: Only the assigned member can perform
 * accept, reject, clockIn, and clockOut actions.
 */
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { HourAlertService } from "@/services/hour-alert.service";

export class TaskAssignmentService {
  private assignmentRepo = new TaskAssignmentRepository();
  private auditService = new AuditLogService();
  private notificationService = new NotificationService();
  private hourAlertService = new HourAlertService();

  /**
   * Accepts a pending task assignment.
   * Notifies the admin/manager who assigned the task.
   */
  async accept(assignmentId: string, membershipId: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (assignment.status !== "pending") {
      throw new Error("Can only accept pending assignments");
    }

    const result = await this.assignmentRepo.updateStatus(assignmentId, "accepted");

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_ACCEPTED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle: assignment.task.title },
    });

    // Notify the admin/manager who assigned the task
    const staffName = assignment.membership.user?.name || "A staff member";
    void this.notificationService.notify(
      assignment.task.organizationId,
      assignment.assignedById,
      NOTIFICATION_TYPES.ASSIGNMENT_ACCEPTED,
      "Assignment accepted",
      `${staffName} accepted "${assignment.task.title}"`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * Rejects a pending task assignment with a required reason.
   * Notifies the admin/manager who assigned the task.
   */
  async reject(assignmentId: string, membershipId: string, reason: string, notes?: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (assignment.status !== "pending") {
      throw new Error("Can only reject pending assignments");
    }

    const result = await this.assignmentRepo.reject(assignmentId, reason, notes);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_REJECTED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { reason, notes, taskTitle: assignment.task.title },
    });

    // Notify the admin/manager who assigned the task
    const staffName = assignment.membership.user?.name || "A staff member";
    void this.notificationService.notify(
      assignment.task.organizationId,
      assignment.assignedById,
      NOTIFICATION_TYPES.ASSIGNMENT_REJECTED,
      "Assignment rejected",
      `${staffName} rejected "${assignment.task.title}" — ${reason.replace(/_/g, " ")}`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * Records clock-in for an accepted assignment.
   * Must be accepted and not already clocked in.
   */
  async clockIn(assignmentId: string, membershipId: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (assignment.status !== "accepted") {
      throw new Error("Can only clock in to accepted assignments");
    }

    if (assignment.clockInTime) {
      throw new Error("Already clocked in");
    }

    const result = await this.assignmentRepo.clockIn(assignmentId);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_CLOCKED_IN,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle: assignment.task.title },
    });

    return result;
  }

  /**
   * Records clock-out — moves the assignment to "clocked_out".
   * The staff member confirms the work is done separately via `complete`.
   * Must be clocked in and not already clocked out.
   */
  async clockOut(assignmentId: string, membershipId: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (!assignment.clockInTime) {
      throw new Error("Must clock in before clocking out");
    }

    if (assignment.clockOutTime) {
      throw new Error("Already clocked out");
    }

    const result = await this.assignmentRepo.clockOut(assignmentId);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_CLOCKED_OUT,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle: assignment.task.title },
    });

    // Worked hours just changed — alert staff/managers if a limit is near (US-72, US-85).
    // Fire-and-forget: never blocks or fails the clock-out.
    void this.hourAlertService.checkAndAlertMember(
      membershipId,
      assignment.task.organizationId
    );

    return result;
  }

  /**
   * Staff marks a clocked-out assignment as completed (US-78).
   * Confirms the work is finished. Notifies the assigning manager.
   */
  async complete(assignmentId: string, membershipId: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (assignment.status !== "clocked_out") {
      throw new Error("Can only complete a task after clocking out");
    }

    const result = await this.assignmentRepo.complete(assignmentId);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_COMPLETED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle: assignment.task.title },
    });

    const staffName = assignment.membership.user?.name || "A staff member";
    void this.notificationService.notify(
      assignment.task.organizationId,
      assignment.assignedById,
      NOTIFICATION_TYPES.TASK_COMPLETED,
      "Task completed",
      `${staffName} completed "${assignment.task.title}"`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * Staff requests to withdraw/abort an accepted assignment with a reason (US-76).
   * The slot stays reserved (status "withdrawal_requested") until a manager
   * approves or denies. Notifies the assigning manager.
   */
  async requestWithdrawal(assignmentId: string, membershipId: string, reason: string) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    if (!assignment) throw new Error("Assignment not found");

    if (assignment.membershipId !== membershipId) {
      throw new Error("Not authorized to manage this assignment");
    }

    if (assignment.status !== "accepted") {
      throw new Error("Can only withdraw from an accepted task");
    }

    const result = await this.assignmentRepo.requestWithdrawal(assignmentId, reason);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: assignment.membership.userId,
      action: ACTIONS.ASSIGNMENT_WITHDRAWAL_REQUESTED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { reason, taskTitle: assignment.task.title },
    });

    const staffName = assignment.membership.user?.name || "A staff member";
    void this.notificationService.notify(
      assignment.task.organizationId,
      assignment.assignedById,
      NOTIFICATION_TYPES.WITHDRAWAL_REQUESTED,
      "Withdrawal requested",
      `${staffName} requested to withdraw from "${assignment.task.title}" — ${reason}`,
      "task",
      assignment.task.id
    );

    return result;
  }

  /**
   * Manager approves or denies a pending withdrawal request.
   * Approve removes the staff member from the task (frees the slot);
   * deny reverts the assignment to accepted. Notifies the staff member.
   * Authorization (manager/admin) is enforced at the route layer.
   */
  async resolveWithdrawal(
    assignmentId: string,
    decision: "approve" | "deny",
    actorUserId: string,
    organizationId: string
  ) {
    const assignment = await this.assignmentRepo.findById(assignmentId);
    // A manager may only resolve withdrawals for their own org's assignments.
    if (!assignment || assignment.task.organizationId !== organizationId) {
      throw new Error("Assignment not found");
    }

    if (assignment.status !== "withdrawal_requested") {
      throw new Error("No pending withdrawal request for this assignment");
    }

    const staffUserId = assignment.membership.userId;
    const taskTitle = assignment.task.title;

    if (decision === "approve") {
      // Remove the staff member from the task, freeing the slot.
      await this.assignmentRepo.cancel(assignmentId);

      await this.auditService.log({
        organizationId: assignment.task.organizationId,
        userId: actorUserId,
        action: ACTIONS.ASSIGNMENT_WITHDRAWAL_APPROVED,
        entityType: "assignment",
        entityId: assignmentId,
        details: { taskTitle, reason: assignment.withdrawalReason },
      });

      void this.notificationService.notify(
        assignment.task.organizationId,
        staffUserId,
        NOTIFICATION_TYPES.WITHDRAWAL_APPROVED,
        "Withdrawal approved",
        `Your request to withdraw from "${taskTitle}" was approved. You've been unassigned.`,
        "task",
        assignment.task.id
      );

      return { id: assignmentId, status: "withdrawn" };
    }

    // Deny — revert to accepted.
    const result = await this.assignmentRepo.denyWithdrawal(assignmentId);

    await this.auditService.log({
      organizationId: assignment.task.organizationId,
      userId: actorUserId,
      action: ACTIONS.ASSIGNMENT_WITHDRAWAL_DENIED,
      entityType: "assignment",
      entityId: assignmentId,
      details: { taskTitle },
    });

    void this.notificationService.notify(
      assignment.task.organizationId,
      staffUserId,
      NOTIFICATION_TYPES.WITHDRAWAL_DENIED,
      "Withdrawal declined",
      `Your request to withdraw from "${taskTitle}" was declined. You remain assigned.`,
      "task",
      assignment.task.id
    );

    return result;
  }
}