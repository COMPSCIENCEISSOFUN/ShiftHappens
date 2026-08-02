/**
 * The boundary helpers every API route opens with.
 *
 * Exercised indirectly by the whole route contract suite; tested here directly
 * because the guard conditions are easy to weaken by accident — `if (!session)`
 * instead of `if (!session?.user?.id)` passes every route test while letting a
 * session with no user id through.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  orgSuspendedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { asUser, asAnonymous, asMalformedSession } from "../helpers/session";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

describe("getAuthenticatedUser", () => {
  it("returns the user when signed in", async () => {
    asUser("user_1");
    await expect(getAuthenticatedUser()).resolves.toMatchObject({ id: "user_1" });
  });

  it("returns null when anonymous", async () => {
    asAnonymous();
    await expect(getAuthenticatedUser()).resolves.toBeNull();
  });

  it("returns null for a session with no user id", async () => {
    // The case a `if (!session)` rewrite would let through.
    asMalformedSession();
    await expect(getAuthenticatedUser()).resolves.toBeNull();
  });
});

describe("response helpers", () => {
  it("unauthorizedResponse is a 401", async () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("orgSuspendedResponse is a 403, not a 401", async () => {
    // Different status on purpose: the caller IS authenticated, so a 401 would
    // send the client back to sign in and achieve nothing.
    const res = orgSuspendedResponse();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "Organization is suspended",
    });
  });
});

describe("checkOrgSuspended", () => {
  let activeOrgId: string;
  let suspendedOrgId: string;

  beforeEach(async () => {
    await cleanDatabase();
    const owner = await userRepo.create({
      name: "Owner",
      email: "owner@example.com",
      hashedPassword: "hash",
    });

    const active = await orgRepo.create({ name: "Active", slug: "active" }, owner.id);
    activeOrgId = active.id;

    const suspended = await orgRepo.create({ name: "Suspended", slug: "suspended" }, owner.id);
    suspendedOrgId = suspended.id;
    await prisma.organization.update({
      where: { id: suspended.id },
      data: { status: "suspended" },
    });
  });

  it("returns null for an active organisation, so the route proceeds", async () => {
    // Null is the "carry on" signal — routes do `if (suspended) return suspended`.
    await expect(checkOrgSuspended(activeOrgId)).resolves.toBeNull();
  });

  it("returns a 403 response for a suspended organisation", async () => {
    const res = await checkOrgSuspended(suspendedOrgId);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("treats an organisation that does not exist as suspended", async () => {
    // A caller must not be able to tell "suspended" from "never existed".
    const res = await checkOrgSuspended("does-not-exist");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
