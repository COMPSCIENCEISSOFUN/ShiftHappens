/**
 * Tests for Settings Service (Control Layer)
 *
 * Verifies company settings retrieval, updates, and validation.
 * Uses lazy initialization via getOrCreate pattern.
 *
 * Coverage:
 * - Default settings creation
 * - Individual field updates
 * - Operating hours validation (merged-state, zero-safe, boundaries)
 * - Partial update safety (unchanged fields persist)
 * - Notification preferences serialization
 * - Seniority thresholds, including the merged-state cross-field rule
 */
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
  describe("getSettings", () => {
    it("returns default settings for new org", async () => {
      const settings = await settingsService.getSettings(orgId);

      // "auto" since 2026-08-13. A new organisation gets the automation it
      // signed up for; existing ones were left where they were by the
      // migration rather than switched under them.
      expect(settings.allocationMode).toBe("auto");
      expect(settings.workingDayHours).toBe(8);
    });

    it("returns default operating hours for new org", async () => {
      const settings = await settingsService.getSettings(orgId);

      expect(settings.operatingHoursStart).toBe(6);
      expect(settings.operatingHoursEnd).toBe(22);
    });

    it("returns existing settings if already created", async () => {
      await prisma.companySettings.create({
        data: {
          organizationId: orgId,
          allocationMode: "suggested",
        },
      });

      const settings = await settingsService.getSettings(orgId);
      expect(settings.allocationMode).toBe("suggested");
    });
  });

  describe("updateSettings", () => {
    describe("basic field updates", () => {
      it("updates allocation mode", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          allocationMode: "auto",
        });
        expect(updated.allocationMode).toBe("auto");
      });

      /*
       * One field, not two. `breakRuleBreakHours` was removed: it was stored,
       * validated, seeded and asserted here to round-trip, while no eligibility
       * check, report or prompt ever read it. A test that a setting saves is
       * not a test that it does anything, and this one had been passing for
       * months over a field with no effect.
       */
      it("updates the working day", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          workingDayHours: 6,
        });
        expect(updated.workingDayHours).toBe(6);
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

      it("creates settings if none exist before updating", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          allocationMode: "suggested",
        });

        expect(updated.allocationMode).toBe("suggested");
      });
    });

    describe("operating hours — valid updates", () => {
      it("updates both start and end together", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursStart: 8,
          operatingHoursEnd: 20,
        });
        expect(updated.operatingHoursStart).toBe(8);
        expect(updated.operatingHoursEnd).toBe(20);
      });

      it("accepts start=0 for midnight opening (zero-safe)", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursStart: 0,
          operatingHoursEnd: 24,
        });
        expect(updated.operatingHoursStart).toBe(0);
        expect(updated.operatingHoursEnd).toBe(24);
      });

      it("accepts full 24-hour range (start=0, end=24)", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursStart: 0,
          operatingHoursEnd: 24,
        });
        expect(updated.operatingHoursEnd - updated.operatingHoursStart).toBe(24);
      });

      it("accepts minimum 1-hour range (start=23, end=24)", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursStart: 23,
          operatingHoursEnd: 24,
        });
        expect(updated.operatingHoursStart).toBe(23);
        expect(updated.operatingHoursEnd).toBe(24);
      });

      it("partial update: only start sent, leaves the end alone", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursStart: 8,
        });
        expect(updated.operatingHoursStart).toBe(8);
        expect(updated.operatingHoursEnd).toBe(22); // unchanged
      });

      it("partial update: only end sent, leaves the start alone", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursEnd: 20,
        });
        expect(updated.operatingHoursStart).toBe(6); // unchanged
        expect(updated.operatingHoursEnd).toBe(20);
      });
    });

    /**
     * These replace an "invalid updates" block that asserted the service threw
     * "Operating hours end must be after start" for any window with
     * `end <= start`.
     *
     * That rule has been deliberately removed. It read as ordinary input
     * validation but was a modelling error: it made a window running past
     * midnight inexpressible, so a business trading 20:00–04:00 could not enter
     * its own hours. Since `operatingHoursStart` is also the organisation's day
     * boundary, it additionally forced every organisation onto a boundary
     * somewhere in the morning.
     *
     * The tests below pin the new contract, so that a future reader who assumes
     * the old rule was simply lost finds it stated as a decision instead.
     */
    describe("operating hours — a window may wrap past midnight", () => {
      it("accepts a night-time window", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursStart: 20,
          operatingHoursEnd: 4,
        });
        expect(updated.operatingHoursStart).toBe(20);
        expect(updated.operatingHoursEnd).toBe(4);
      });

      it("accepts an identical start and end, meaning open around the clock", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursStart: 12,
          operatingHoursEnd: 12,
        });
        expect(updated.operatingHoursStart).toBe(12);
        expect(updated.operatingHoursEnd).toBe(12);
      });

      it("accepts a partial update that makes the merged window wrap", async () => {
        // Default end is 22. Sending start=22 alone once threw; it now means a
        // 24-hour operation whose day begins at 22:00.
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursStart: 22,
        });
        expect(updated.operatingHoursStart).toBe(22);
        expect(updated.operatingHoursEnd).toBe(22);
      });

      it("accepts a partial update that pulls the end below the start", async () => {
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursEnd: 5,
        });
        expect(updated.operatingHoursStart).toBe(6); // unchanged
        expect(updated.operatingHoursEnd).toBe(5);
      });

      it("stores the pair verbatim rather than normalising it", async () => {
        // 20→4 and 20→28 describe the same window, but only one of them is a
        // legal hour. The service must not silently rewrite what the admin
        // entered, or the settings screen would show something they did not
        // type.
        const updated = await settingsService.updateSettings(orgId, {
          operatingHoursStart: 20,
          operatingHoursEnd: 4,
        });
        expect(updated.operatingHoursEnd).toBe(4);
      });
    });

    describe("getDisplaySettings", () => {
      it("returns the operating hours", async () => {
        await settingsService.updateSettings(orgId, {
          operatingHoursStart: 9,
          operatingHoursEnd: 18,
        });

        const display = await settingsService.getDisplaySettings(orgId);

        expect(display.operatingHoursStart).toBe(9);
        expect(display.operatingHoursEnd).toBe(18);
      });

      it("leaks nothing else — this read is not admin-gated", async () => {
        // The whole point of the narrow shape. Any member of the organisation
        // can call this, so allocation strategy, notification policy and smart
        // allocation weights must not travel with it.
        await settingsService.updateSettings(orgId, {
          allocationMode: "auto",
        });

        const display = await settingsService.getDisplaySettings(orgId);

        expect(Object.keys(display).sort()).toEqual([
          "operatingHoursEnd",
          "operatingHoursStart",
        ]);
      });

      it("lazily creates settings for an organisation that has none", async () => {
        const display = await settingsService.getDisplaySettings(orgId);

        expect(display.operatingHoursStart).toBe(6);
        expect(display.operatingHoursEnd).toBe(22);
      });
    });

    describe("partial update safety", () => {
      it("updating one field does not clear other fields", async () => {
        // Set all fields
        await settingsService.updateSettings(orgId, {
          allocationMode: "suggested",
          workingDayHours: 10,
          operatingHoursStart: 7,
          operatingHoursEnd: 23,
        });

        // Update only allocation mode
        const updated = await settingsService.updateSettings(orgId, {
          allocationMode: "auto",
        });

        // All other fields should remain unchanged
        expect(updated.allocationMode).toBe("auto");
        expect(updated.workingDayHours).toBe(10);
        expect(updated.operatingHoursStart).toBe(7);
        expect(updated.operatingHoursEnd).toBe(23);
      });

  describe("seniority thresholds", () => {
    it("starts at the schema defaults", async () => {
      const settings = await settingsService.getSettings(orgId);
      expect(settings.experiencedShiftThreshold).toBe(10);
      expect(settings.seniorShiftThreshold).toBe(40);
    });

    it("saves a valid pair", async () => {
      const updated = await settingsService.updateSettings(orgId, {
        experiencedShiftThreshold: 5,
        seniorShiftThreshold: 25,
      });
      expect(updated.experiencedShiftThreshold).toBe(5);
      expect(updated.seniorShiftThreshold).toBe(25);
    });

    // An inverted or equal pair makes "senior" either unreachable or
    // indistinguishable from "experienced", so the scale quietly collapses to
    // two levels and every composition rule mentioning senior stops meaning
    // what it says.
    it("refuses an inverted pair", async () => {
      await expect(
        settingsService.updateSettings(orgId, {
          experiencedShiftThreshold: 40,
          seniorShiftThreshold: 10,
        })
      ).rejects.toThrow("Senior threshold must be higher");
    });

    it("refuses an equal pair", async () => {
      await expect(
        settingsService.updateSettings(orgId, {
          experiencedShiftThreshold: 10,
          seniorShiftThreshold: 10,
        })
      ).rejects.toThrow("Senior threshold must be higher");
    });

    // The likely way to get here: raise only the experienced threshold past a
    // senior one that was never resent. Checked against the merged values, so
    // a partial update cannot slip an invalid pair through.
    it("checks the merged pair, not only the submitted fields", async () => {
      await settingsService.updateSettings(orgId, {
        experiencedShiftThreshold: 10,
        seniorShiftThreshold: 20,
      });

      await expect(
        settingsService.updateSettings(orgId, { experiencedShiftThreshold: 30 })
      ).rejects.toThrow("Senior threshold must be higher");
    });

    it("leaves the stored pair untouched when a change is refused", async () => {
      await settingsService
        .updateSettings(orgId, { experiencedShiftThreshold: 99 })
        .catch(() => undefined);

      const settings = await settingsService.getSettings(orgId);
      expect(settings.experiencedShiftThreshold).toBe(10);
    });

    it("does not block an unrelated update", async () => {
      const updated = await settingsService.updateSettings(orgId, {
        allocationMode: "auto",
      });
      expect(updated.allocationMode).toBe("auto");
    });
  });

      it("empty update object does not change any values", async () => {
        const before = await settingsService.getSettings(orgId);
        const after = await settingsService.updateSettings(orgId, {});

        expect(after.allocationMode).toBe(before.allocationMode);
        expect(after.workingDayHours).toBe(before.workingDayHours);
        expect(after.operatingHoursStart).toBe(before.operatingHoursStart);
        expect(after.operatingHoursEnd).toBe(before.operatingHoursEnd);
      });
    });
  });
});