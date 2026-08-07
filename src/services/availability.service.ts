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
    const byDay = new Map<number, Set<string>>();
    const intervalsByDay = new Map<number, Array<[number, number]>>();
    for (const window of schedule) {
      const seen = byDay.get(window.dayOfWeek) ?? new Set<string>();
      const key = `${window.startTime}-${window.endTime}`;
      if (seen.has(key)) throw new Error("Duplicate availability window");
      seen.add(key);
      byDay.set(window.dayOfWeek, seen);

      const intervals = intervalsByDay.get(window.dayOfWeek) ?? [];
      if (intervals.length >= 5) {
        throw new Error("A day can have at most 5 availability windows");
      }
      const toMinutes = (value: string) => {
        const [hours, minutes] = value.split(":").map(Number);
        return hours * 60 + minutes;
      };
      const start = toMinutes(window.startTime);
      let end = toMinutes(window.endTime);
      if (end <= start) end += 24 * 60;
      if (intervals.some(([otherStart, otherEnd]) => start < otherEnd && end > otherStart)) {
        throw new Error("Availability windows on the same day cannot overlap");
      }
      intervals.push([start, end]);
      intervalsByDay.set(window.dayOfWeek, intervals);
    }
    return this.availRepo.replaceWeeklySchedule(membershipId, schedule);
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
