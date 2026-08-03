/**
 * Availability Service (Control Layer)
 * 
 * Business logic for managing staff availability schedules.
 * Supports weekly recurring patterns and date-specific overrides.
 * 
 * Used by the eligibility engine to check if staff can work
 * at a specific date/time before assignment.
 */
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { EligibilityService } from "@/services/eligibility.service";
import { NotificationService, NOTIFICATION_TYPES } from "@/services/notification.service";
import { taskWatcherUserIds } from "@/services/task-watchers";
import type {
  SetAvailabilityInput,
  CreateAvailabilityOverrideInput,
} from "@/lib/validations";

/** A shift the member is still expected to work. */
interface Commitment {
  taskId: string;
  taskTitle: string;
  organizationId: string;
  departmentId: string | null;
  scheduledStart: Date | null;
}

export class AvailabilityService {
  private availRepo = new AvailabilityRepository();
  private assignmentRepo = new TaskAssignmentRepository();
  private eligibilityService = new EligibilityService();
  private notificationService = new NotificationService();

  /** Sets availability for a single day of the week */
  async setDayAvailability(membershipId: string, input: SetAvailabilityInput) {
    if (input.isAvailable && input.startTime >= input.endTime) {
      throw new Error("End time must be after start time");
    }

    return this.availRepo.setDayAvailability({
      membershipId,
      dayOfWeek: input.dayOfWeek,
      startTime: input.startTime,
      endTime: input.endTime,
      isAvailable: input.isAvailable,
    });
  }

  /**
   * Sets the full weekly schedule (bulk upsert).
   *
   * Wrapped in the ineligibility guard as ONE unit, not per day. Hooking
   * `setDayAvailability` instead would run the check seven times for a single
   * save and could fire an alert off a half-applied week — Monday saved,
   * Tuesday not yet — describing a state that never existed.
   */
  async setWeeklySchedule(
    membershipId: string,
    schedule: SetAvailabilityInput[]
  ) {
    return this.withIneligibilityCheck(membershipId, async () => {
      const results = [];
      for (const day of schedule) {
        const result = await this.setDayAvailability(membershipId, day);
        results.push(result);
      }
      return results;
    });
  }

  /** Gets the weekly schedule for a member */
  async getWeeklySchedule(membershipId: string) {
    return this.availRepo.getWeeklySchedule(membershipId);
  }

  /** Creates a date-specific availability override */
  async createOverride(
    membershipId: string,
    input: CreateAvailabilityOverrideInput
  ) {
    return this.withIneligibilityCheck(membershipId, () =>
      this.availRepo.createOverride({
        membershipId,
        date: new Date(input.date),
        isAvailable: input.isAvailable,
        reason: input.reason,
      })
    );
  }

  /** Gets overrides for a member, optionally within a date range */
  async getOverrides(membershipId: string, startDate?: Date, endDate?: Date) {
    return this.availRepo.getOverrides(membershipId, startDate, endDate);
  }

  /**
   * Deletes a date override.
   *
   * Also guarded. Deleting an override is not obviously a restriction — it
   * usually widens availability — but removing an "I CAN work the 14th"
   * override narrows it, and that reaches the roster exactly like any other
   * change.
   */
  async deleteOverride(overrideId: string) {
    const override = await this.availRepo.getOverrideById(overrideId);
    if (!override) return this.availRepo.deleteOverride(overrideId);

    return this.withIneligibilityCheck(override.membershipId, () =>
      this.availRepo.deleteOverride(overrideId)
    );
  }

  /** Checks if a member is available at a specific date and time */
  async checkAvailability(
    membershipId: string,
    date: Date,
    startTime: string,
    endTime: string
  ) {
    return this.availRepo.isAvailableAt(membershipId, date, startTime, endTime);
  }

  /* ---------------------------------------------------------------- */
  /*  Ineligibility guard                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Runs an availability change, then tells the right people if it has left
   * someone booked onto a shift they no longer fit.
   *
   * ## Why the check happens twice
   *
   * Once BEFORE the write and once after, comparing the two. Only assignments
   * that were fine and are now not produce an alert.
   *
   * The alternative — alerting on everything currently ineligible — sounds
   * equivalent and is not. Someone who is already flagged for a shift, then
   * corrects a typo in an unrelated day's hours, would generate a fresh alert
   * about a problem the manager already knows about. Do that a few times and
   * managers learn to ignore the notification, which costs more than the
   * feature is worth.
   *
   * ## Why it never throws
   *
   * The staff member's own action must succeed regardless. If the check fails,
   * their availability is still saved and the error goes to the console — the
   * same rule the audit log follows. A person should not be told "could not
   * save" because a notification to somebody else broke.
   *
   * ## What it does not do
   *
   * It does not unassign anyone. The manager may have already recorded an
   * eligibility override, may need a replacement lined up first, or may simply
   * want a conversation. A roster that silently drops people is worse than one
   * that says something needs looking at.
   */
  private async withIneligibilityCheck<T>(
    membershipId: string,
    write: () => Promise<T>
  ): Promise<T> {
    let before: Set<string>;
    try {
      before = await this.ineligibleUpcomingTaskIds(membershipId);
    } catch (error) {
      // Could not establish a baseline, so a comparison afterwards would be
      // meaningless — and alerting on everything would be the noisy behaviour
      // this exists to avoid. Save, stay quiet.
      console.error("[Availability Check Error] baseline failed", error);
      return write();
    }

    const result = await write();

    try {
      await this.notifyNewlyIneligible(membershipId, before);
    } catch (error) {
      console.error("[Availability Check Error]", error);
    }

    return result;
  }

  /** Upcoming shifts this member is booked on but no longer eligible for. */
  private async ineligibleUpcomingTaskIds(
    membershipId: string
  ): Promise<Set<string>> {
    const commitments = await this.upcomingCommitments(membershipId);
    const ineligible = new Set<string>();

    for (const commitment of commitments) {
      const eligibility = await this.eligibilityService.checkEligibilityForTask(
        commitment.taskId,
        commitment.organizationId
      );
      const own = eligibility.find((e) => e.membershipId === membershipId);
      // A member absent from the list is not eligible-by-omission: they may
      // have been filtered out by the task's department. Treated as "no
      // finding" rather than as a problem, because inventing one would alert
      // on every save.
      if (own && !own.eligible) ineligible.add(commitment.taskId);
    }

    return ineligible;
  }

  private async upcomingCommitments(
    membershipId: string
  ): Promise<Commitment[]> {
    const rows = await this.assignmentRepo.findUpcomingCommitments(
      membershipId,
      new Date()
    );

    return rows.map((row) => ({
      taskId: row.task.id,
      taskTitle: row.task.title,
      organizationId: row.task.organizationId,
      departmentId: row.task.departmentId,
      scheduledStart: row.task.scheduledStart,
    }));
  }

  private async notifyNewlyIneligible(membershipId: string, before: Set<string>) {
    const commitments = await this.upcomingCommitments(membershipId);
    if (commitments.length === 0) return;

    const after = await this.ineligibleUpcomingTaskIds(membershipId);
    const newlyIneligible = commitments.filter(
      (c) => after.has(c.taskId) && !before.has(c.taskId)
    );
    if (newlyIneligible.length === 0) return;

    const memberName = await this.memberName(membershipId);

    // One notification per shift, not one listing all of them. Each carries a
    // different task id, and the notification's entity link is what makes it
    // actionable — a combined message could only link to one of them.
    for (const commitment of newlyIneligible) {
      const watchers = await taskWatcherUserIds(
        commitment.organizationId,
        commitment.departmentId
      );
      if (watchers.length === 0) continue;

      await this.notificationService.notifyManyIfEnabled(
        commitment.organizationId,
        watchers,
        NOTIFICATION_TYPES.STAFF_INELIGIBLE,
        "Assigned staff no longer eligible",
        `${memberName} updated their availability and is no longer eligible for "${commitment.taskTitle}".`,
        "task",
        commitment.taskId
      );
    }
  }

  private async memberName(membershipId: string): Promise<string> {
    const commitment = await this.availRepo.getMemberName(membershipId);
    return commitment ?? "A staff member";
  }
}
