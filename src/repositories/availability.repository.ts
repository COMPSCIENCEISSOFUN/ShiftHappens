import { prisma } from "@/lib/prisma";
import { dayOfWeekInTimeZone, localDateInTimeZone } from "@/lib/timezone";

export class AvailabilityRepository {
  async setDayAvailability(data: {
    membershipId: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    isAvailable: boolean;
  }) {
    return prisma.$transaction(async (tx) => {
      await tx.availability.deleteMany({
        where: { membershipId: data.membershipId, dayOfWeek: data.dayOfWeek },
      });
      return tx.availability.create({ data });
    });
  }

  async replaceWeeklySchedule(
    membershipId: string,
    schedule: Array<{
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      isAvailable: boolean;
    }>
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.availability.deleteMany({ where: { membershipId } });
      await tx.availability.createMany({
        data: schedule.map((entry) => ({ membershipId, ...entry })),
      });
      return tx.availability.findMany({
        where: { membershipId },
        orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
      });
    });
  }

  async getWeeklySchedule(membershipId: string) {
    return prisma.availability.findMany({
      where: { membershipId },
      orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    });
  }

  async createOverride(data: {
    membershipId: string;
    date: Date;
    isAvailable: boolean;
    reason?: string;
  }) {
    return prisma.availabilityOverride.upsert({
      where: {
        membershipId_date: { membershipId: data.membershipId, date: data.date },
      },
      update: { isAvailable: data.isAvailable, reason: data.reason },
      create: data,
    });
  }

  async getOverrides(membershipId: string, startDate?: Date, endDate?: Date) {
    return prisma.availabilityOverride.findMany({
      where: {
        membershipId,
        ...(startDate && endDate && { date: { gte: startDate, lte: endDate } }),
      },
      orderBy: { date: "asc" },
    });
  }

  async getOverrideForDate(membershipId: string, date: Date) {
    return prisma.availabilityOverride.findUnique({
      where: { membershipId_date: { membershipId, date } },
    });
  }

  async deleteOverride(id: string, membershipId: string) {
    const result = await prisma.availabilityOverride.deleteMany({
      where: { id, membershipId },
    });
    return result.count === 1;
  }

  async updateOverride(
    id: string,
    membershipId: string,
    data: { date: Date; isAvailable: boolean; reason?: string }
  ) {
    const existing = await prisma.availabilityOverride.findFirst({
      where: { id, membershipId },
      select: { id: true },
    });
    if (!existing) return null;
    return prisma.availabilityOverride.update({ where: { id }, data });
  }

  /** Supports ordinary windows and windows that cross midnight. */
  async isAvailableAt(
    membershipId: string,
    date: Date,
    startTime: string,
    endTime: string
  ): Promise<{ available: boolean; reason?: string }> {
    const dateOnly = new Date(`${localDateInTimeZone(date)}T00:00:00.000Z`);
    const override = await this.getOverrideForDate(membershipId, dateOnly);
    if (override) {
      return {
        available: override.isAvailable,
        reason: override.isAvailable
          ? undefined
          : override.reason || "Date override: unavailable",
      };
    }

    const dayOfWeek = dayOfWeekInTimeZone(date);
    const previousDay = (dayOfWeek + 6) % 7;
    const schedules = await prisma.availability.findMany({
      where: { membershipId, dayOfWeek: { in: [dayOfWeek, previousDay] } },
    });
    const daySchedules = schedules.filter((entry) => entry.dayOfWeek === dayOfWeek);
    const previousSchedules = schedules.filter((entry) => entry.dayOfWeek === previousDay);

    if (!daySchedules.length && !previousSchedules.length) {
      return { available: false, reason: "No availability set for this day" };
    }

    const sameDayContains = daySchedules.some((schedule) =>
      schedule.isAvailable &&
      (schedule.startTime < schedule.endTime
        ? startTime >= schedule.startTime && endTime <= schedule.endTime && endTime > startTime
        : startTime >= schedule.startTime && endTime <= schedule.endTime)
    );
    const previousOvernightContains = previousSchedules.some(
      (schedule) =>
        schedule.isAvailable &&
        schedule.startTime >= schedule.endTime &&
        startTime < endTime &&
        startTime <= schedule.endTime &&
        endTime <= schedule.endTime
    );

    if (!sameDayContains && !previousOvernightContains) {
      const windows = [...previousSchedules, ...daySchedules]
        .filter((entry) => entry?.isAvailable)
        .map((entry) => `${entry!.startTime}–${entry!.endTime}`)
        .join(" or ");
      return {
        available: false,
        reason: windows
          ? `Available ${windows} only`
          : "Marked unavailable for this day",
      };
    }

    return { available: true };
  }
}
