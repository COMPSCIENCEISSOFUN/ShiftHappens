import { describe, it, expect, beforeEach } from "vitest";
import { SettingsRepository } from "@/repositories/settings.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
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
  it("returns null when no settings exist", async () => {
    const settings = await settingsRepo.findByOrgId(orgId);
    expect(settings).toBeNull();
  });

  it("creates settings with automatic allocation by default", async () => {
    const settings = await settingsRepo.createDefaults(orgId);

    expect(settings.allocationMode).toBe("auto");
    expect(settings.breakRuleHoursWorked).toBe(8);
    expect(settings.breakRuleBreakHours).toBe(1);
  });

  it("gets or creates default settings", async () => {
    const settings = await settingsRepo.getOrCreate(orgId);

    expect(settings).not.toBeNull();
    expect(settings.allocationMode).toBe("auto");
  });

  it("updates allocation mode", async () => {
    await settingsRepo.createDefaults(orgId);

    const updated = await settingsRepo.update(orgId, {
      allocationMode: "manual",
    });
    expect(updated.allocationMode).toBe("manual");
  });

  it("preserves unchanged fields", async () => {
    await settingsRepo.createDefaults(orgId);

    const updated = await settingsRepo.update(orgId, {
      allocationMode: "manual",
    });
    expect(updated.allocationMode).toBe("manual");
    expect(updated.breakRuleHoursWorked).toBe(8);
  });
});
