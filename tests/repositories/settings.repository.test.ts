/**
 * Tests for Settings Repository (Entity Layer)
 * Verifies company settings CRUD operations including
 * creation with defaults and partial updates.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SettingsRepository } from "@/repositories/settings.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const settingsRepo = new SettingsRepository();
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

describe("SettingsRepository", () => {
  describe("findByOrgId", () => {
    it("returns null when no settings exist", async () => {
      const settings = await settingsRepo.findByOrgId(orgId);
      expect(settings).toBeNull();
    });

    it("returns settings when they exist", async () => {
      await settingsRepo.createDefaults(orgId);

      const settings = await settingsRepo.findByOrgId(orgId);
      expect(settings).not.toBeNull();
      expect(settings!.organizationId).toBe(orgId);
    });
  });

  describe("createDefaults", () => {
    it("creates settings with default values", async () => {
      const settings = await settingsRepo.createDefaults(orgId);

      expect(settings.allocationMode).toBe("manual");
      expect(settings.taskAcceptanceMode).toBe("auto_accept");
      expect(settings.workingDayHours).toBe(8);
    });
  });

  describe("getOrCreate", () => {
    it("returns existing settings", async () => {
      await settingsRepo.createDefaults(orgId);

      const settings = await settingsRepo.getOrCreate(orgId);
      expect(settings.allocationMode).toBe("manual");
    });

    it("creates defaults if none exist", async () => {
      const settings = await settingsRepo.getOrCreate(orgId);
      expect(settings).not.toBeNull();
      expect(settings.allocationMode).toBe("manual");
    });
  });

  describe("update", () => {
    it("updates allocation mode", async () => {
      await settingsRepo.createDefaults(orgId);

      const updated = await settingsRepo.update(orgId, {
        allocationMode: "suggested",
      });
      expect(updated.allocationMode).toBe("suggested");
    });

    it("updates break rules", async () => {
      await settingsRepo.createDefaults(orgId);

      const updated = await settingsRepo.update(orgId, {
        workingDayHours: 6,
      });
      expect(updated.workingDayHours).toBe(6);
    });

    it("updates notification preferences as JSON", async () => {
      await settingsRepo.createDefaults(orgId);

      const prefs = JSON.stringify({
        emailNotifications: true,
        taskAssignment: true,
        hourLimitWarning: false,
      });

      const updated = await settingsRepo.update(orgId, {
        notificationPreferences: prefs,
      });
      expect(updated.notificationPreferences).toBe(prefs);
    });

    it("preserves unchanged fields", async () => {
      await settingsRepo.createDefaults(orgId);

      const updated = await settingsRepo.update(orgId, {
        allocationMode: "auto",
      });
      expect(updated.allocationMode).toBe("auto");
      expect(updated.taskAcceptanceMode).toBe("auto_accept");
      expect(updated.workingDayHours).toBe(8);
    });
  });
});