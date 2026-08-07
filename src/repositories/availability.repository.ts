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
 * The end of a calendar day, for the first half of an overnight shift.
 *
 * "23:59" rather than "24:00" because a window's end comes from an
 * `<input type="time">` and can never exceed 23:59 — comparing against "24:00"
 * would make somebody available "18:00–23:59" fail a shift running to midnight,
 * which is exactly the person the check should pass.
 */
const END_OF_DAY = "23:59";

/**
 * Does this window run past midnight?
 *
 * The same test `isAvailableAt` applies to a SHIFT, stated once so a window and
 * a shift cannot come to disagree about what wrapping means.
 */
export function wraps(startTime: string, endTime: string): boolean {
  return endTime < startTime;
}

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

  /**
   * Pending leave held by any of these members on any of these dates.
   *
   * Dates are the normalised keys `overrideDateKey` produces, so the caller
   * derives them from a task the same way `isAvailableAt` derives them from a
   * shift — including the SECOND day of an overnight shift, which is a real
   * date somebody can have booked off.
   */
  async findPendingOnDates(membershipIds: string[], dates: Date[]) {
    if (membershipIds.length === 0 || dates.length === 0) return [];
    return prisma.availabilityOverride.findMany({
      where: {
        membershipId: { in: membershipIds },
        date: { in: dates },
        status: "pending",
      },
      select: { id: true, membershipId: true, date: true, isAvailable: true, reason: true },
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
   *
   * ## Shifts that cross midnight
   *
   * Times are "HH:mm" strings compared lexically, so an overnight shift used to
   * slip through every check. A 22:00–02:00 shift against a 09:00–17:00 window
   * asks `"22:00" < "09:00"` (false) and `"02:00" > "17:00"` (false), neither
   * fires, and the member comes back AVAILABLE — for any window, on any day.
   * For a venue that closes after midnight that is the closing shift, not an
   * edge case.
   *
   * A shift ending before it starts occupies two calendar days, so it is split
   * and each half checked against that day's own override and window. Both must
   * pass: somebody free until 23:00 on Saturday has said nothing about Sunday
   * morning, and somebody who booked Sunday off must not be rostered into it
   * through Saturday's door.
   *
   * Availability windows themselves cannot cross midnight —
   * `setDayAvailability` refuses `startTime >= endTime` — so only the SHIFT can
   * wrap, never the window. That is a real limitation for genuine night workers
   * and is recorded in the backlog rather than solved here.
   */
  async isAvailableAt(
    membershipId: string,
    date: Date,
    startTime: string,
    endTime: string,
    /**
     * What an ABSENT weekday row means for this member.
     *
     * Silence means different things for the two employment types, and the
     * difference is the contract. A CASUAL opts in — they name the hours they
     * are willing to work, so a day they never mentioned is a day they did not
     * offer. A FULL-TIMER opts out: they are employed to work and their days
     * are open unless somebody narrows them, so a day nobody has written down
     * is open rather than refused.
     *
     * `openUnsetDays` writes that default down explicitly wherever it can, so
     * an admin can see and narrow it. This flag is what keeps the rule true for
     * the members it never ran for — anyone created before it existed, seeded
     * directly, or imported — instead of making every one of them ineligible
     * for everything with no visible cause.
     *
     * Overrides are unaffected: they are read BEFORE the weekly fallback, so
     * approved leave still removes a full-timer no matter what this says.
     */
    treatMissingDayAsOpen = false
  ): Promise<{ available: boolean; reason?: string }> {
    if (endTime < startTime) {
      const firstHalf = await this.availableWithinDay(
        membershipId,
        date,
        startTime,
        END_OF_DAY,
        treatMissingDayAsOpen
      );
      if (!firstHalf.available) return firstHalf;

      // setDate rather than adding 24h in milliseconds: a day is not always 24
      // hours in a zone that observes daylight saving, and this date is used to
      // pick a weekday and an override key.
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);

      const secondHalf = await this.availableWithinDay(
        membershipId,
        nextDay,
        "00:00",
        endTime,
        treatMissingDayAsOpen
      );
      if (!secondHalf.available) {
        return {
          available: false,
          // Named, because "available 09:00–17:00 only" against a shift that
          // starts at 22:00 reads as nonsense until you know which half of it
          // failed.
          reason: `After midnight: ${secondHalf.reason ?? "unavailable"}`,
        };
      }
      return { available: true };
    }

    return this.availableWithinDay(
      membershipId,
      date,
      startTime,
      endTime,
      treatMissingDayAsOpen
    );
  }

  /** One calendar day's worth of the question above. */
  private async availableWithinDay(
    membershipId: string,
    date: Date,
    startTime: string,
    endTime: string,
    treatMissingDayAsOpen = false
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
      // A day the member never answered. Open for a contracted member, refused
      // for one whose availability is an offer — see the parameter's docblock.
      return treatMissingDayAsOpen
        ? { available: true }
        : { available: false, reason: "No availability set for this day" };
    }

    if (!schedule.isAvailable) {
      return { available: false, reason: "Marked unavailable for this day" };
    }

    /*
     * Does the requested slice fall inside the declared window?
     *
     * A window that ENDS BEFORE IT STARTS wraps past midnight — 22:00–06:00 is
     * a night worker's shift, and refusing to store one meant they had to split
     * it across two days themselves and hope both halves were interpreted
     * together. Only the SHIFT could wrap; the window could not.
     *
     * The wrapped window covers two disjoint ranges on this calendar day: from
     * the start to the end of the day, and from the start of the day to the
     * end. The caller has already split a wrapping SHIFT into per-day slices
     * (see `isAvailableAt`), so each slice sits wholly within one of those two
     * ranges or in neither.
     */
    const covers = wraps(schedule.startTime, schedule.endTime)
      ? (from: string, to: string) =>
          // Late slice: inside the evening half. Early slice: inside the
          // morning half. `to <= END_OF_DAY` is not tested because every slice
          // this method receives already ends within the day.
          (from >= schedule.startTime && to > from) ||
          (to <= schedule.endTime && from < to) ||
          (from >= schedule.startTime && to <= schedule.endTime)
      : (from: string, to: string) =>
          from >= schedule.startTime && to <= schedule.endTime;

    if (!covers(startTime, endTime)) {
      return {
        available: false,
        reason: `Available ${schedule.startTime}–${schedule.endTime} only`,
      };
    }

    return { available: true };
  }
}