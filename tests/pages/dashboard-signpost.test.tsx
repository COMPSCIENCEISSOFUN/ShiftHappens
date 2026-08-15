// @vitest-environment node
/**
 * `/dashboard` decides which organisation you meant, or admits it cannot.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const nav = vi.hoisted(() => ({ destinations: [] as string[] }));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    redirect: (url: string) => {
      nav.destinations.push(url);
      throw new Error("NEXT_REDIRECT");
    },
  };
});

import DashboardPage from "@/app/(app)/dashboard/page";
import SelectOrganizationPage from "@/app/(app)/select-organization/page";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { asUser, asAnonymous } from "../helpers/session";

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  nav.destinations.length = 0;
  tenant = await createTenant("signpost");
  vi.clearAllMocks();
});

/** Where the page sent this user. Fails the test if it sent them nowhere. */
async function destinationFor(
  userId: string,
  page: () => Promise<unknown> = DashboardPage
) {
  asUser(userId);
  await expect(page()).rejects.toThrow("NEXT_REDIRECT");
  return nav.destinations.at(-1);
}

/** A signed-up user who has not joined or created anything. */
async function userWithNoOrganisation() {
  const user = await prisma.user.create({
    data: {
      name: "Nobody",
      email: `nobody-${Date.now()}@example.com`,
      hashedPassword: "hash",
    },
  });
  return user.id;
}

/** Puts an existing user into a second organisation as plain staff. */
async function joinSecondOrganisation(userId: string) {
  const second = await createTenant("signpost-second");
  await prisma.membership.create({
    data: {
      userId,
      organizationId: second.orgId,
      role: "staff",
      status: "active",
    },
  });
  return second;
}

describe("the signpost", () => {
  it("sends a user with no organisation to onboarding", async () => {
    const userId = await userWithNoOrganisation();
    expect(await destinationFor(userId)).toBe("/onboarding");
  });

  /*
   * The common case, and the one the change must not make worse. Almost every
   * user is in exactly one organisation, and being shown a chooser with one
   * option on it would be a new click for no decision.
   */
  it("sends a user with one organisation straight into it", async () => {
    expect(await destinationFor(tenant.admin.userId)).toBe(
      `/org/${tenant.orgId}/dashboard`
    );
  });

  it("sends a user with two organisations to the picker", async () => {
    await joinSecondOrganisation(tenant.admin.userId);
    expect(await destinationFor(tenant.admin.userId)).toBe(
      "/select-organization"
    );
  });

  /*
   * A deactivated member is not a member. `getUserOrganizations` is
   * active-only, so somebody deactivated from their only organisation is in
   * the same position as somebody who never joined one — and onboarding, not a
   * dashboard about an organisation they have been removed from, is the honest
   * destination.
   */
  it("treats a deactivated member as having no organisation", async () => {
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { status: "inactive" },
    });
    expect(await destinationFor(tenant.manager.userId)).toBe("/onboarding");
  });

  it("sends an anonymous visitor to sign in", async () => {
    asAnonymous();
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.destinations.at(-1)).toBe("/login");
  });
});

describe("the picker", () => {
  /*
   * Typing the URL is a real path to this page, and both of these would leave
   * somebody looking at a list they cannot use. The rule lives in two files,
   * so it is asserted in both — a picker that trusted `/dashboard` to have
   * filtered its callers would render an empty page for a new user.
   */
  it("sends a user with no organisation to onboarding", async () => {
    const userId = await userWithNoOrganisation();
    expect(await destinationFor(userId, SelectOrganizationPage)).toBe(
      "/onboarding"
    );
  });

  it("sends a user with one organisation straight into it", async () => {
    expect(
      await destinationFor(tenant.admin.userId, SelectOrganizationPage)
    ).toBe(`/org/${tenant.orgId}/dashboard`);
  });

  /*
   * And the case it exists for: two organisations, so it renders rather than
   * redirecting. Asserted as "did not redirect" rather than by inspecting the
   * markup — the question here is whether the page stands its ground, and the
   * three redirects above are what could take it away.
   */
  it("renders for a user with two organisations", async () => {
    await joinSecondOrganisation(tenant.admin.userId);
    asUser(tenant.admin.userId);

    const element = await SelectOrganizationPage();

    expect(element).toBeTruthy();
    expect(nav.destinations).toHaveLength(0);
  });
});
