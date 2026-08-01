/**
 * Recalculates task coverage and fills gaps with ranked eligible staff.
 * Used after approved withdrawals and manager removals.
 */
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { AllocationService } from "@/services/allocation.service";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { TaskService } from "@/services/task.service";

export interface ReplacementAllocationResult {
  status: "not_needed" | "filled" | "partially_filled" | "unfilled";
  required: number;
  assigned: number;
  remaining: number;
  replacementMembershipIds: string[];
}

export class ReplacementAllocationService {
  private taskRepo = new TaskRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private allocationService = new AllocationService();
  private taskService = new TaskService();
  private notificationService = new NotificationService();
  private auditService = new AuditLogService();

  async fillCoverageGap(input: {
    taskId: string;
    organizationId: string;
    actorUserId: string;
    excludedMembershipIds: string[];
    removedStaffName: string;
  }): Promise<ReplacementAllocationResult> {
    const task = await this.taskRepo.findById(input.taskId);
    if (!task || task.organizationId !== input.organizationId) {
      throw new Error("Task not found");
    }

    const activeMembershipIds =
      await this.assignmentRepo.findActiveMembershipIdsByTaskId(task.id);
    const required = Math.max(0, task.requiredHeadcount - activeMembershipIds.length);
    if (required === 0) {
      return {
        status: "not_needed",
        required: 0,
        assigned: 0,
        remaining: 0,
        replacementMembershipIds: [],
      };
    }

    const excluded = Array.from(
      new Set([...input.excludedMembershipIds, ...activeMembershipIds])
    );
    const rankings = await this.allocationService.getSuggestions(
      task.id,
      input.organizationId,
      { excludeMembershipIds: excluded }
    );
    const selectedMembershipIds = rankings
      .slice(0, required)
      .map((ranking) => ranking.membershipId);

    const assignments = selectedMembershipIds.length
      ? await this.taskService.assignStaff(
          task.id,
          input.organizationId,
          selectedMembershipIds,
          input.actorUserId
        )
      : [];
    const remaining = required - assignments.length;

    if (assignments.length > 0) {
      await this.auditService.log({
        organizationId: input.organizationId,
        userId: input.actorUserId,
        action: ACTIONS.TASK_REPLACEMENT_ALLOCATED,
        entityType: "task",
        entityId: task.id,
        details: {
          removedStaffName: input.removedStaffName,
          replacementMembershipIds: assignments.map(
            (assignment) => assignment.membershipId
          ),
          remaining,
        },
      });
    }

    if (remaining > 0) {
      await this.notificationService.notify(
        input.organizationId,
        input.actorUserId,
        NOTIFICATION_TYPES.STAFF_INELIGIBLE,
        "Replacement needed - no eligible staff",
        `"${task.title}" still needs ${remaining} staff after ${input.removedStaffName} was removed. No other eligible candidate is currently available.`,
        "task",
        task.id
      );
      await this.auditService.log({
        organizationId: input.organizationId,
        userId: input.actorUserId,
        action: ACTIONS.TASK_REPLACEMENT_UNFILLED,
        entityType: "task",
        entityId: task.id,
        details: { removedStaffName: input.removedStaffName, remaining },
      });
    }

    return {
      status:
        remaining === 0
          ? "filled"
          : assignments.length > 0
            ? "partially_filled"
            : "unfilled",
      required,
      assigned: assignments.length,
      remaining,
      replacementMembershipIds: assignments.map(
        (assignment) => assignment.membershipId
      ),
    };
  }
}
