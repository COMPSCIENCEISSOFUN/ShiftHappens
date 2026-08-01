/**
 * Tests for the platform admin guard.
 *
 * `getPlatformAdmin` used to read `isPlatformAdmin` straight off the session.
 * That claim is written into the JWT once at sign-in and never revalidated,
 * and sessions run on NextAuth's 30-day default — so revoking platform admin
 * in the database left the existing cookie fully privileged for up to a month.
 * That privilege includes suspending any tenant and changing any tenant's
 * subscription tier, across every organisation on the platform.
 *
 * The tests that matter here are the two where the token and the database
 * DISAGREE. A test that only checks "admin gets in, non-admin does not" passes
 * against the broken version too, because in the happy path the two agree.
 *
 * `@/lib/auth` is mocked rather than `@/lib/platform-guard`: the guard is the
 * thing under test, so stubbing it would leave the suite asserting against its
 * own mock. Everything below the session lookup — the service, the repository,
 * the database — is real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getPlatformAdmin } from "@/lib/platform-guard";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { asUser, asPlatformAdmin, asAnonymous } from "../helpers/session";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const userRepo = new UserRepository();

let adminId: string;
let plainId: string;

beforeEach(async () => {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Platform Admin",
    email: "platform@example.com",
    hashedPassword: "hash",
  });
  adminId = admin.id;
  await prisma.user.update({
    where: { id: adminId },
    data: { isPlatformAdmin: true },
  });

  const plain = await userRepo.create({
    name: "Ordinary User",
    email: "ordinary@example.com",
    hashedPassword: "hash",
  });
  plainId = plain.id;
});

describe("getPlatformAdmin — the token and the database agree", () => {
  it("allows a real platform admin", async () => {
    asPlatformAdmin(adminId);

    const user = await getPlatformAdmin();

    expect(user).not.toBeNull();
    expect(user!.id).toBe(adminId);
  });

  it("refuses an ordinary authenticated user", async () => {
    asUser(plainId);

    expect(await getPlatformAdmin()).toBeNull();
  });

  it("refuses an anonymous caller", async () => {
    asAnonymous();

    expect(await getPlatformAdmin()).toBeNull();
  });
});

describe("getPlatformAdmin — the token and the database DISAGREE", () => {
  it("refuses a revoked admin whose token still claims the privilege", async () => {
    // The whole point. The session was minted while this user was a platform
    // admin and still says so; the database no longer does. Reading the claim
    // from the token would let this through for the rest of the 30-day session.
    asPlatformAdmin(adminId);
    await prisma.user.update({
      where: { id: adminId },
      data: { isPlatformAdmin: false },
    });

    expect(await getPlatformAdmin()).toBeNull();
  });

  it("refuses a caller who simply asserts the claim in their session", async () => {
    // Defence in depth: even if a token were forged or a session object were
    // tampered with, the flag is no longer what grants access.
    asUser(plainId, { isPlatformAdmin: true });

    expect(await getPlatformAdmin()).toBeNull();
  });

  it("allows a newly granted admin whose token does NOT claim it yet", async () => {
    // The mirror case, and the reason this is a genuine improvement rather than
    // just a tightening: granting used to require the user to sign out and back
    // in before it took effect. Now it applies on the next request.
    asUser(plainId);
    await prisma.user.update({
      where: { id: plainId },
      data: { isPlatformAdmin: true },
    });

    const user = await getPlatformAdmin();

    expect(user).not.toBeNull();
    expect(user!.id).toBe(plainId);
  });

  it("refuses a session whose user no longer exists", async () => {
    asPlatformAdmin(adminId);
    await prisma.user.delete({ where: { id: adminId } });

    expect(await getPlatformAdmin()).toBeNull();
  });
});
