/**
 * Tests for Availability Service (Control Layer)
 * Verifies weekly schedule management and override logic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AvailabilityService } from "@/services/availability.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const availService = new AvailabilityService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let membershipId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Staff User",
    email: "staff@example.com",
    hashedPassword: "hash",
  });
  const org = await orgRepo.create(
    { name: "Acme Corp", slug: "acme-corp" },
    user.id
  );
  const membership = await prisma.membership.findFirst({
    where: { organizationId: org.id },
  });
  membershipId = membership!.id;
});

describe("AvailabilityService", () => {
  describe("setDayAvailability", () => {
    it("sets availability for a day", async () => {
      const result = await availService.setDayAvailability(membershipId, {
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "17:00",
        isAvailable: true,
      });

      expect(result.dayOfWeek).toBe(1);
      expect(result.startTime).toBe("09:00");
    });

    it("supports availability windows that cross midnight", async () => {
      const result = await availService.setDayAvailability(membershipId, {
        dayOfWeek: 1,
        startTime: "17:00",
        endTime: "09:00",
        isAvailable: true,
      });
      expect(result.startTime).toBe("17:00");
      expect(result.endTime).toBe("09:00");
    });

    it("allows unavailable with any times", async () => {
      const result = await availService.setDayAvailability(membershipId, {
        dayOfWeek: 0,
        startTime: "00:00",
        endTime: "00:00",
        isAvailable: false,
      });

      expect(result.isAvailable).toBe(false);
    });
  });

  describe("setWeeklySchedule", () => {
    it("sets full week schedule", async () => {
      const schedule = Array.from({ length: 5 }, (_, i) => ({
        dayOfWeek: i + 1,
        startTime: "09:00",
        endTime: "17:00",
        isAvailable: true,
      }));

      const results = await availService.setWeeklySchedule(membershipId, schedule);
      expect(results).toHaveLength(5);
    });
  });

  describe("getWeeklySchedule", () => {
    it("returns saved schedule", async () => {
      await availService.setDayAvailability(membershipId, {
        dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isAvailable: true,
      });
      await availService.setDayAvailability(membershipId, {
        dayOfWeek: 2, startTime: "10:00", endTime: "18:00", isAvailable: true,
      });

      const schedule = await availService.getWeeklySchedule(membershipId);
      expect(schedule).toHaveLength(2);
    });
  });

  describe("overrides", () => {
    it("creates and retrieves an override", async () => {
      const override = await availService.createOverride(membershipId, {
        date: "2026-06-15T00:00:00.000Z",
        isAvailable: false,
        reason: "Sick day",
      });

      expect(override.isAvailable).toBe(false);

      const overrides = await availService.getOverrides(membershipId);
      expect(overrides).toHaveLength(1);
    });

    it("deletes an override", async () => {
      const override = await availService.createOverride(membershipId, {
        date: "2026-06-15T00:00:00.000Z",
        isAvailable: false,
      });

      await availService.deleteOverride(override.id, membershipId);

      const overrides = await availService.getOverrides(membershipId);
      expect(overrides).toHaveLength(0);
    });

    it("updates only the member's own override", async () => {
      const override = await availService.createOverride(membershipId, { date: "2026-06-15T00:00:00.000Z", isAvailable: false, reason: "Leave" });
      const updated = await availService.updateOverride(override.id, membershipId, { date: "2026-06-16T00:00:00.000Z", isAvailable: true, reason: "Available after all" });
      expect(updated).toMatchObject({ isAvailable: true, reason: "Available after all" });
      await expect(availService.getOverrides(membershipId)).resolves.toHaveLength(1);
    });
  });

  describe("checkAvailability", () => {
    it("returns available when within schedule", async () => {
      await availService.setDayAvailability(membershipId, {
        dayOfWeek: 1, startTime: "08:00", endTime: "18:00", isAvailable: true,
      });

      const result = await availService.checkAvailability(
        membershipId,
        new Date("2026-06-15T00:00:00.000Z"), // Monday
        "09:00",
        "12:00"
      );
      expect(result.available).toBe(true);
    });

    it("returns unavailable when no schedule", async () => {
      const result = await availService.checkAvailability(
        membershipId,
        new Date("2026-06-15T00:00:00.000Z"),
        "09:00",
        "12:00"
      );
      expect(result.available).toBe(false);
    });
  });
});
