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
import type {
  SetAvailabilityInput,
  CreateAvailabilityOverrideInput,
} from "@/lib/validations";

export class AvailabilityService {
  private availRepo = new AvailabilityRepository();

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

  /** Sets the full weekly schedule (bulk upsert) */
  async setWeeklySchedule(
    membershipId: string,
    schedule: SetAvailabilityInput[]
  ) {
    const results = [];
    for (const day of schedule) {
      const result = await this.setDayAvailability(membershipId, day);
      results.push(result);
    }
    return results;
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
    return this.availRepo.createOverride({
      membershipId,
      date: new Date(input.date),
      isAvailable: input.isAvailable,
      reason: input.reason,
    });
  }

  /** Gets overrides for a member, optionally within a date range */
  async getOverrides(membershipId: string, startDate?: Date, endDate?: Date) {
    return this.availRepo.getOverrides(membershipId, startDate, endDate);
  }

  /** Deletes a date override */
  async deleteOverride(overrideId: string, membershipId: string) {
    return this.availRepo.deleteOverride(overrideId, membershipId);
  }

  async updateOverride(overrideId: string, membershipId: string, input: CreateAvailabilityOverrideInput) {
    return this.availRepo.updateOverride(overrideId, membershipId, {
      date: new Date(input.date),
      isAvailable: input.isAvailable,
      reason: input.reason,
    });
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
}
