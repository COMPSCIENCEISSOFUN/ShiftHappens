/**
 * Profile reads and updates.
 *
 * The load-bearing behaviours are that `hashedPassword` never leaves the
 * service, and that a password change verifies the current one first.
 */
import { describe, it, expect, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { ProfileService } from "@/services/profile.service";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const profileService = new ProfileService();
const userRepo = new UserRepository();

const CURRENT = "CurrentPass1!";
const NEXT = "BrandNewPass1!";

let userId: string;
let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("prof");

  const user = await userRepo.create({
    name: "Priya Menon",
    email: "priya@example.com",
    hashedPassword: await bcrypt.hash(CURRENT, 12),
  });
  userId = user.id;
});

describe("getProfile", () => {
  it("returns the profile fields", async () => {
    const profile = await profileService.getProfile(userId);
    expect(profile).toMatchObject({ name: "Priya Menon", email: "priya@example.com" });
  });

  it("never returns the password hash", async () => {
    const profile = await profileService.getProfile(userId);
    expect(profile).not.toHaveProperty("hashedPassword");
  });

  it("returns null for a user that does not exist", async () => {
    await expect(profileService.getProfile("no-such-user")).resolves.toBeNull();
  });
});

describe("getFullProfile", () => {
  it("includes the user's memberships", async () => {
    const profile = await profileService.getFullProfile(tenant.staff.userId);
    expect(profile!.memberships).toHaveLength(1);
    expect(profile!.memberships[0].organization.id).toBe(tenant.orgId);
  });

  it("reports the membership role and status", async () => {
    const profile = await profileService.getFullProfile(tenant.manager.userId);
    expect(profile!.memberships[0]).toMatchObject({ role: "manager", status: "active" });
  });

  it("includes a DEACTIVATED membership", async () => {
    // Deliberately different from AccessService, which hides it. This is the
    // user reading their own account, not a route deciding whether to let them
    // act — "you were removed from Acme" is information they should have.
    const profile = await profileService.getFullProfile(tenant.inactive.userId);
    expect(profile!.memberships[0].status).toBe("inactive");
  });

  it("returns an empty membership list for someone in no organisation", async () => {
    const profile = await profileService.getFullProfile(userId);
    expect(profile!.memberships).toEqual([]);
  });

  it("returns null customRole when none is assigned", async () => {
    const profile = await profileService.getFullProfile(tenant.staff.userId);
    expect(profile!.memberships[0].customRole).toBeNull();
  });

  it("never returns the password hash", async () => {
    const profile = await profileService.getFullProfile(tenant.staff.userId);
    expect(profile).not.toHaveProperty("hashedPassword");
  });

  it("returns null for a user that does not exist", async () => {
    await expect(profileService.getFullProfile("no-such-user")).resolves.toBeNull();
  });
});

describe("updateProfile", () => {
  it("changes the name", async () => {
    const updated = await profileService.updateProfile(userId, { name: "Priya M." });
    expect(updated.name).toBe("Priya M.");
  });

  it("changes the password when the current one is right", async () => {
    await profileService.updateProfile(userId, {
      currentPassword: CURRENT,
      newPassword: NEXT,
    });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await expect(bcrypt.compare(NEXT, stored.hashedPassword)).resolves.toBe(true);
  });

  it("rejects a wrong current password", async () => {
    await expect(
      profileService.updateProfile(userId, {
        currentPassword: "WrongPass1!",
        newPassword: NEXT,
      })
    ).rejects.toThrow("Current password is incorrect");
  });

  it("leaves the password untouched when verification fails", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    await expect(
      profileService.updateProfile(userId, {
        currentPassword: "WrongPass1!",
        newPassword: NEXT,
      })
    ).rejects.toThrow();

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.hashedPassword).toBe(before.hashedPassword);
  });

  it("ignores a new password sent without the current one", async () => {
    // The route's schema refuses this, but the service is the last line: a
    // password change that skips verification is account takeover.
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    await profileService.updateProfile(userId, { newPassword: NEXT });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.hashedPassword).toBe(before.hashedPassword);
  });

  it("stores the password hashed, not in the clear", async () => {
    await profileService.updateProfile(userId, {
      currentPassword: CURRENT,
      newPassword: NEXT,
    });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.hashedPassword).not.toBe(NEXT);
  });

  it("changes the name and the password together", async () => {
    const updated = await profileService.updateProfile(userId, {
      name: "Priya M.",
      currentPassword: CURRENT,
      newPassword: NEXT,
    });

    expect(updated.name).toBe("Priya M.");
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await expect(bcrypt.compare(NEXT, stored.hashedPassword)).resolves.toBe(true);
  });

  it("returns only id, name and email", async () => {
    const updated = await profileService.updateProfile(userId, { name: "Priya M." });
    expect(Object.keys(updated).sort()).toEqual(["email", "id", "name"]);
  });

  it("throws for a user that does not exist when changing a password", async () => {
    await expect(
      profileService.updateProfile("no-such-user", {
        currentPassword: CURRENT,
        newPassword: NEXT,
      })
    ).rejects.toThrow("User not found");
  });
});
