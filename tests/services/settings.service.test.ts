import { describe, it, expect, beforeEach } from "vitest";
import { SettingsService } from "@/services/settings.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const settingsService = new SettingsService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  const org = await orgRepo.create(
    { name: "Acme Corp", slug: "acme-corp" },
    user.id
  );
  orgId = org.id;
});

describe("SettingsService", () => {
  it("creates default settings with automatic allocation", async () => {
    const settings = await settingsService.getSettings(orgId);

    expect(settings.allocationMode).toBe("auto");
    expect(settings.breakRuleHoursWorked).toBe(8);
    expect(settings.breakRuleBreakHours).toBe(1);
  });

  it("updates allocation mode to manual", async () => {
    const updated = await settingsService.updateSettings(orgId, {
      allocationMode: "manual",
    });

    expect(updated.allocationMode).toBe("manual");
  });

  it("updates allocation mode back to auto", async () => {
    await settingsService.updateSettings(orgId, { allocationMode: "manual" });

    const updated = await settingsService.updateSettings(orgId, {
      allocationMode: "auto",
    });

    expect(updated.allocationMode).toBe("auto");
  });

  it("updates notification preferences", async () => {
    const updated = await settingsService.updateSettings(orgId, {
      notificationPreferences: {
        emailNotifications: true,
        taskAssignment: true,
        hourLimitWarning: false,
      },
    });

    const parsed = JSON.parse(updated.notificationPreferences!);
    expect(parsed.emailNotifications).toBe(true);
    expect(parsed.hourLimitWarning).toBe(false);
  });

  it("normalizes and returns saved allocation priorities", async () => {
    const updated = await settingsService.updateSettings(orgId, {
      allocationWeights: {
        workloadBalance: 1,
        availabilityFit: 1,
        certificationBreadth: 1,
        departmentExperience: 1,
      },
    });

    expect(updated.allocationWeights).toEqual({
      workloadBalance: 25,
      availabilityFit: 25,
      certificationBreadth: 25,
      departmentExperience: 25,
    });
    const stored = await prisma.companySettings.findUniqueOrThrow({
      where: { organizationId: orgId },
    });
    expect(JSON.parse(stored.smartAllocationWeights!)).toEqual(
      updated.allocationWeights
    );
  });

  it("validates operating hours against merged state", async () => {
    await expect(
      settingsService.updateSettings(orgId, {
        operatingHoursStart: 22,
        operatingHoursEnd: 10,
      })
    ).rejects.toThrow("Operating hours end must be after start");

    const updated = await settingsService.updateSettings(orgId, {
      operatingHoursStart: 8,
      operatingHoursEnd: 20,
    });
    expect(updated.operatingHoursStart).toBe(8);
    expect(updated.operatingHoursEnd).toBe(20);
  });

  it("empty update object does not change any values", async () => {
    const before = await settingsService.getSettings(orgId);
    const after = await settingsService.updateSettings(orgId, {});

    expect(after.allocationMode).toBe(before.allocationMode);
    expect(after.breakRuleHoursWorked).toBe(before.breakRuleHoursWorked);
    expect(after.operatingHoursStart).toBe(before.operatingHoursStart);
    expect(after.operatingHoursEnd).toBe(before.operatingHoursEnd);
  });

  it("returns existing settings if already created", async () => {
    await prisma.companySettings.create({
      data: {
        organizationId: orgId,
        allocationMode: "manual",
      },
    });

    const settings = await settingsService.getSettings(orgId);
    expect(settings.allocationMode).toBe("manual");
  });
});
