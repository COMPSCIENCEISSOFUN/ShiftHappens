/**
 * Tests for Availability Repository (Entity Layer)
 * Verifies weekly schedule CRUD, date overrides,
 * and availability checking logic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const availRepo = new AvailabilityRepository();
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

describe("AvailabilityRepository", () => {
  describe("setDayAvailability", () => {
    it("creates availability for a day", async () => {
      const avail = await availRepo.setDayAvailability({
        membershipId,
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "17:00",
        isAvailable: true,
      });

      expect(avail.dayOfWeek).toBe(1);
      expect(avail.startTime).toBe("09:00");
      expect(avail.isAvailable).toBe(true);
    });

    it("upserts if day already exists", async () => {
      await availRepo.setDayAvailability({
        membershipId,
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "17:00",
        isAvailable: true,
      });

      const updated = await availRepo.setDayAvailability({
        membershipId,
        dayOfWeek: 1,
        startTime: "08:00",
        endTime: "16:00",
        isAvailable: true,
      });

      expect(updated.startTime).toBe("08:00");

      const schedule = await availRepo.getWeeklySchedule(membershipId);
      expect(schedule).toHaveLength(1);
    });
  });

  describe("getWeeklySchedule", () => {
    it("returns all days sorted", async () => {
      await availRepo.setDayAvailability({
        membershipId, dayOfWeek: 3, startTime: "09:00", endTime: "17:00", isAvailable: true,
      });
      await availRepo.setDayAvailability({
        membershipId, dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isAvailable: true,
      });
      await availRepo.setDayAvailability({
        membershipId, dayOfWeek: 5, startTime: "09:00", endTime: "17:00", isAvailable: false,
      });

      const schedule = await availRepo.getWeeklySchedule(membershipId);
      expect(schedule).toHaveLength(3);
      expect(schedule[0].dayOfWeek).toBe(1);
      expect(schedule[1].dayOfWeek).toBe(3);
      expect(schedule[2].dayOfWeek).toBe(5);
    });
  });

  describe("overrides", () => {
    it("creates a date override", async () => {
      const override = await availRepo.createOverride({
        membershipId,
        date: new Date("2026-06-15T00:00:00.000Z"),
        isAvailable: false,
        reason: "Personal day",
      });

      expect(override.isAvailable).toBe(false);
      expect(override.reason).toBe("Personal day");
    });

    it("upserts override for same date", async () => {
      await availRepo.createOverride({
        membershipId,
        date: new Date("2026-06-15T00:00:00.000Z"),
        isAvailable: false,
        reason: "Sick",
      });

      const updated = await availRepo.createOverride({
        membershipId,
        date: new Date("2026-06-15T00:00:00.000Z"),
        isAvailable: true,
        reason: "Recovered",
      });

      expect(updated.isAvailable).toBe(true);
      expect(updated.reason).toBe("Recovered");
    });

    it("gets overrides in date range", async () => {
      await availRepo.createOverride({
        membershipId,
        date: new Date("2026-06-10T00:00:00.000Z"),
        isAvailable: false,
      });
      await availRepo.createOverride({
        membershipId,
        date: new Date("2026-06-15T00:00:00.000Z"),
        isAvailable: false,
      });
      await availRepo.createOverride({
        membershipId,
        date: new Date("2026-06-25T00:00:00.000Z"),
        isAvailable: false,
      });

      const overrides = await availRepo.getOverrides(
        membershipId,
        new Date("2026-06-12T00:00:00.000Z"),
        new Date("2026-06-20T00:00:00.000Z")
      );
      expect(overrides).toHaveLength(1);
    });

    it("deletes an override", async () => {
      const override = await availRepo.createOverride({
        membershipId,
        date: new Date("2026-06-15T00:00:00.000Z"),
        isAvailable: false,
      });

      await availRepo.deleteOverride(override.id, membershipId);

      const found = await availRepo.getOverrideForDate(
        membershipId,
        new Date("2026-06-15T00:00:00.000Z")
      );
      expect(found).toBeNull();
    });

    it("does not delete another member's override", async () => {
      const other = await prisma.membership.create({ data: { userId: (await prisma.user.create({ data: { name: "Other", email: "other-availability@example.com", hashedPassword: "hash" } })).id, organizationId: (await prisma.membership.findUniqueOrThrow({ where: { id: membershipId } })).organizationId, role: "staff" } });
      const override = await availRepo.createOverride({ membershipId: other.id, date: new Date("2026-06-16T00:00:00.000Z"), isAvailable: false });
      await expect(availRepo.deleteOverride(override.id, membershipId)).resolves.toBe(false);
      await expect(availRepo.getOverrideForDate(other.id, new Date("2026-06-16T00:00:00.000Z"))).resolves.not.toBeNull();
    });
  });

  describe("isAvailableAt", () => {
    it("returns unavailable when no schedule set", async () => {
      const result = await availRepo.isAvailableAt(
        membershipId,
        new Date("2026-06-16T00:00:00.000Z"), // Monday
        "09:00",
        "12:00"
      );
      expect(result.available).toBe(false);
      expect(result.reason).toContain("No availability");
    });

    it("returns available when within schedule", async () => {
      await availRepo.setDayAvailability({
        membershipId, dayOfWeek: 1, startTime: "08:00", endTime: "18:00", isAvailable: true,
      });

      const mondayResult = await availRepo.isAvailableAt(
        membershipId,
        new Date("2026-06-15T00:00:00.000Z"), // Monday
        "09:00",
        "12:00"
      );
      expect(mondayResult.available).toBe(true);
    });

    it("returns unavailable when outside schedule hours", async () => {
      await availRepo.setDayAvailability({
        membershipId, dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isAvailable: true,
      });

      const result = await availRepo.isAvailableAt(
        membershipId,
        new Date("2026-06-15T00:00:00.000Z"), // Monday
        "07:00",
        "10:00"
      );
      expect(result.available).toBe(false);
      expect(result.reason).toContain("09:00–17:00");
    });

    it("date override takes priority over weekly schedule", async () => {
      await availRepo.setDayAvailability({
        membershipId, dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isAvailable: true,
      });

      await availRepo.createOverride({
        membershipId,
        date: new Date("2026-06-15T00:00:00.000Z"), // Monday
        isAvailable: false,
        reason: "Sick day",
      });

      const result = await availRepo.isAvailableAt(
        membershipId,
        new Date("2026-06-15T00:00:00.000Z"),
        "09:00",
        "12:00"
      );
      expect(result.available).toBe(false);
      expect(result.reason).toContain("Sick day");
    });

    it("returns unavailable when day marked not available", async () => {
      await availRepo.setDayAvailability({
        membershipId, dayOfWeek: 0, startTime: "09:00", endTime: "17:00", isAvailable: false,
      });

      const result = await availRepo.isAvailableAt(
        membershipId,
        new Date("2026-06-14T00:00:00.000Z"), // Sunday
        "09:00",
        "12:00"
      );
      expect(result.available).toBe(false);
      expect(result.reason).toContain("unavailable");
    });
  });
});
