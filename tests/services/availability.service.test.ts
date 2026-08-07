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

    /*
     * This used to assert a refusal, and the refusal was the limitation: a
     * genuine night worker could not declare 22:00–06:00 and had to split it
     * across two days themselves. Only the SHIFT could wrap. A window ending
     * before it starts now means the same thing a shift ending before it starts
     * means.
     */
    it("accepts a window that runs past midnight", async () => {
      const result = await availService.setDayAvailability(membershipId, {
        dayOfWeek: 1,
        startTime: "22:00",
        endTime: "06:00",
        isAvailable: true,
      });

      expect(result.startTime).toBe("22:00");
      expect(result.endTime).toBe("06:00");
    });

    /*
     * Equal times are still refused, and that is why the check was narrowed
     * rather than deleted. 09:00–09:00 is a window of no length — what an empty
     * form or a mis-clicked picker produces — and storing it would read as
     * "available" for a period nobody can be rostered in.
     */
    it("still refuses a window of no length", async () => {
      await expect(
        availService.setDayAvailability(membershipId, {
          dayOfWeek: 1,
          startTime: "09:00",
          endTime: "09:00",
          isAvailable: true,
        })
      ).rejects.toThrow("Start and end time cannot be the same");
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
    /*
     * Relative, not a literal. Overrides for past dates are refused now, so a
     * hard-coded date is a test that passes until the date arrives — which is
     * exactly what "2026-06-15" did.
     */
    const soon = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

    it("creates and retrieves an override", async () => {
      const override = await availService.createOverride(membershipId, {
        date: soon(),
        isAvailable: false,
        reason: "Sick day",
      });

      expect(override.isAvailable).toBe(false);

      const overrides = await availService.getOverrides(membershipId);
      expect(overrides).toHaveLength(1);
    });

    it("deletes an override", async () => {
      const override = await availService.createOverride(membershipId, {
        date: soon(),
        isAvailable: false,
      });

      await availService.deleteOverride(override.id);

      const overrides = await availService.getOverrides(membershipId);
      expect(overrides).toHaveLength(0);
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