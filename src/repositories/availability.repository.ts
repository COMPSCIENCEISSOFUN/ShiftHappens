/**
 * Availability Repository (Entity Layer)
 * 
 * Data access layer for staff weekly availability schedules
 * and date-specific overrides. Each staff member has a weekly
 * pattern (Mon-Sun) and can override specific dates.
 * 
 * dayOfWeek: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
 * Times stored as "HH:MM" strings for simplicity.
 */
import { prisma } from "@/lib/prisma";
import { dayOfWeekInTimeZone, localDateInTimeZone } from "@/lib/timezone";

/**
 * The storage key for a date override.
 *
 * An override is about a CALENDAR DAY, not an instant, so it is stored at UTC
 * midnight of the day it refers to in the organisation's timezone.
 *
 * This has to be shared, because the write and the read were deriving it
 * differently. `createOverride` stored whatever `Date` it was handed;
 * `isAvailableAt` looked up `localDateInTimeZone(date)` at UTC midnight. They
 * agreed only when the caller happened to pass UTC midnight already — which
 * the availability form does, by accident of `<input type="date">` parsing as
 * UTC. Any other caller (an API client, a mobile app, a test) would write an
 * override that was silently never found, and the unique constraint on
 * [membershipId, date] would let them accumulate one row per attempt for the
 * same day.
 */
export function overrideDateKey(date: Date): Date {
  return new Date(`${localDateInTimeZone(date)}T00:00:00.000Z`);
}

export class AvailabilityRepository {
  /** Sets availability for a specific day of the week (upserts) */
  async setDayAvailability(data: {
    membershipId: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    isAvailable: boolean;
  }) {
    return prisma.availability.upsert({
      where: {
        membershipId_dayOfWeek: {
          membershipId: data.membershipId,
          dayOfWeek: data.dayOfWeek,
        },
      },
      update: {
        startTime: data.startTime,
        endTime: data.endTime,
        isAvailable: data.isAvailable,
      },
      create: data,
    });
  }

  /** Gets the full weekly schedule for a member */
  async getWeeklySchedule(membershipId: string) {
    return prisma.availability.findMany({
      where: { membershipId },
      orderBy: { dayOfWeek: "asc" },
    });
  }

  /**
   * Creates a date-specific override (e.g. day off, extra shift).
   *
   * `status` is the caller's decision, not this layer's: a casual member's
   * override is written "approved" and binds at once, a full-time member's is
   * written "pending" and binds only when a manager approves it. The upsert
   * RESETS the review on every write — editing a rejected request makes it
   * pending again rather than leaving it carrying an old verdict about
   * different dates or a different reason.
   */
  async createOverride(data: {
    membershipId: string;
    date: Date;
    isAvailable: boolean;
    reason?: string;
    status: string;
  }) {
    // Normalised, so the key written here is the key `isAvailableAt` reads.
    const date = overrideDateKey(data.date);

    return prisma.availabilityOverride.upsert({
      where: {
        membershipId_date: { membershipId: data.membershipId, date },
      },
      update: {
        isAvailable: data.isAvailable,
        reason: data.reason,
        status: data.status,
        reviewedById: null,
      },
      create: { ...data, date },
    });
  }

  /** Records a manager's verdict on a leave request. */
  async reviewOverride(id: string, status: string, reviewedById: string) {
    return prisma.availabilityOverride.update({
      where: { id },
      data: { status, reviewedById },
    });
  }

  /**
   * Leave awaiting a decision, for the members given.
   *
   * Scoped by the caller rather than filtered here: a department manager sees
   * their own members' requests and an admin sees everyone's, and which of
   * those applies is an authorisation question the service answers.
   */
  async findPendingForMembers(membershipIds: string[]) {
    if (membershipIds.length === 0) return [];
    return prisma.availabilityOverride.findMany({
      where: { membershipId: { in: membershipIds }, status: "pending" },
      include: {
        membership: {
          select: {
            id: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    });
  }

  /** Gets all overrides for a member within a date range */
  async getOverrides(membershipId: string, startDate?: Date, endDate?: Date) {
    return prisma.availabilityOverride.findMany({
      where: {
        membershipId,
        ...(startDate && endDate && {
          date: { gte: startDate, lte: endDate },
        }),
      },
      orderBy: { date: "asc" },
    });
  }

  /** Gets the override for a specific date, if any */
  async getOverrideForDate(membershipId: string, date: Date) {
    return prisma.availabilityOverride.findUnique({
      where: {
        membershipId_date: {
          membershipId,
          date,
        },
      },
    });
  }

  /** Deletes a specific override */
  /** The member's display name, for a notification body. */
  async getMemberName(membershipId: string): Promise<string | null> {
    const membership = await prisma.membership.findUnique({
      where: { id: membershipId },
      select: { user: { select: { name: true, email: true } } },
    });
    return membership ? membership.user.name ?? membership.user.email : null;
  }

  /** One override by id, to find whose it is before deleting it. */
  async getOverrideById(id: string) {
    return prisma.availabilityOverride.findUnique({ where: { id } });
  }

  async deleteOverride(id: string) {
    return prisma.availabilityOverride.delete({ where: { id } });
  }

  /**
   * Checks if a member is available at a specific date and time.
   * Priority: date override > weekly schedule > default (unavailable)
   */
  async isAvailableAt(
    membershipId: string,
    date: Date,
    startTime: string,
    endTime: string
  ): Promise<{ available: boolean; reason?: string }> {
    // Check for date-specific override first.
    // Overrides are keyed by the LOCAL calendar date, stored as UTC midnight.
    // Deriving the date from toISOString() would use the UTC calendar day, so
    // any shift between midnight and 08:00 Singapore time would look up the
    // previous day's override — or miss one entirely.
    const override = await this.getOverrideForDate(
      membershipId,
      overrideDateKey(date)
    );

    /*
     * Only an APPROVED override binds.
     *
     * A casual member's override is written approved, so this is the behaviour
     * it has always had. A full-time member's is a leave request, and a request
     * nobody has answered must not remove them from the roster — that is the
     * whole point of the approval step, and reading a pending row here would
     * silently give every full-timer the unilateral opt-out the model exists to
     * prevent. A rejected row is likewise inert.
     */
    if (override && override.status === "approved") {
      return {
        available: override.isAvailable,
        reason: override.isAvailable
          ? undefined
          : override.reason || "Date override: unavailable",
      };
    }

    // Fall back to weekly schedule.
    // getDay() is the SERVER's weekday. A 01:00 Sunday shift in Singapore is
    // still Saturday in UTC, so on Vercel this read the wrong day's row.
    const dayOfWeek = dayOfWeekInTimeZone(date);
    const schedule = await prisma.availability.findUnique({
      where: {
        membershipId_dayOfWeek: { membershipId, dayOfWeek },
      },
    });

    if (!schedule) {
      return { available: false, reason: "No availability set for this day" };
    }

    if (!schedule.isAvailable) {
      return { available: false, reason: "Marked unavailable for this day" };
    }

    // Check if task time falls within available hours
    if (startTime < schedule.startTime || endTime > schedule.endTime) {
      return {
        available: false,
        reason: `Available ${schedule.startTime}–${schedule.endTime} only`,
      };
    }

    return { available: true };
  }
}