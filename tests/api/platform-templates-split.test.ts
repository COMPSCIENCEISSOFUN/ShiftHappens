/**
 * The industry-template read, split by audience.
 *
 * `GET /api/platform/templates` used to branch on `isPlatformAdmin` and never
 * deny: an admin got every template with usage counts, and everyone else fell
 * through to the active ones. The manifest recorded it as a KNOWN GAP, because
 * a path under `/api/platform/` that any authenticated user may call is a
 * contradiction — the prefix is the only thing telling the next person who the
 * audience is.
 *
 * The two audiences want different data, which is what makes splitting it a fix
 * rather than a rename:
 *
 *   onboarding / settings → active templates, to pick one
 *   platform console      → every template including retired ones, plus usage
 *                           counts, which are a CROSS-TENANT aggregate
 *
 * These go through the route handlers rather than the services, because the
 * question is which caller gets which payload — and that is decided at the
 * boundary.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { GET as platformGET } from "@/app/api/platform/templates/route";
import { GET as memberGET } from "@/app/api/industry-templates/route";
import { IndustryTemplateRepository } from "@/repositories/industry-template.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const repo = new IndustryTemplateRepository();

let tenant: Tenant;
let platformAdminId: string;

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));
const { auth } = await import("@/lib/auth");

/** Signs the given user in for the next handler call. */
function signedInAs(userId: string) {
  vi.mocked(auth).mockResolvedValue({
    user: { id: userId },
  } as unknown as Awaited<ReturnType<typeof auth>>);
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("tmplsplit");

  const admin = await prisma.user.create({
    data: {
      name: "Platform Admin",
      email: `padmin-${Date.now()}@example.com`,
      hashedPassword: "hash",
      isPlatformAdmin: true,
    },
  });
  platformAdminId = admin.id;

  await repo.create({
    name: "Restaurant",
    icon: "utensils",
    description: "Restaurant template",
    departments: [{ name: "Kitchen" }],
    workRules: [],
    certifications: [],
  });
  const retired = await repo.create({
    name: "Retired",
    icon: "box",
    description: "No longer offered",
    departments: [],
    workRules: [],
    certifications: [],
  });
  await repo.deactivate(retired.id);
});

afterEach(() => {
  vi.mocked(auth).mockReset();
});

describe("the platform endpoint", () => {
  /*
   * The gap itself. An ordinary member is a perfectly normal caller — they are
   * signed in — and the old handler answered them 200.
   */
  it("refuses an ordinary member", async () => {
    signedInAs(tenant.staff.userId);
    const res = await platformGET(new Request("http://x") as never);
    expect(res.status).toBe(403);
  });

  it("refuses a company admin, who is not a PLATFORM admin", async () => {
    signedInAs(tenant.admin.userId);
    const res = await platformGET(new Request("http://x") as never);
    expect(res.status).toBe(403);
  });

  it("refuses an anonymous caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await platformGET(new Request("http://x") as never);
    expect(res.status).toBe(401);
  });

  it("serves a platform admin every template, retired ones included", async () => {
    signedInAs(platformAdminId);
    const res = await platformGET(new Request("http://x") as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.map((t: { name: string }) => t.name)).toEqual([
      "Restaurant",
      "Retired",
    ]);
  });

  // Usage counts are the reason this half stayed behind the guard: how many
  // organisations chose each template is an aggregate across every tenant.
  it("includes usage counts, which the member endpoint must not", async () => {
    signedInAs(platformAdminId);
    const res = await platformGET(new Request("http://x") as never);
    const body = await res.json();

    expect(body[0]).toHaveProperty("usageCount");
  });
});

describe("the member endpoint", () => {
  it("serves a signed-in member the active templates", async () => {
    signedInAs(tenant.staff.userId);
    const res = await memberGET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.map((t: { name: string }) => t.name)).toEqual(["Restaurant"]);
  });

  it("hides retired templates", async () => {
    signedInAs(tenant.staff.userId);
    const body = await (await memberGET()).json();
    expect(body.some((t: { name: string }) => t.name === "Retired")).toBe(false);
  });

  it("does not leak usage counts", async () => {
    signedInAs(tenant.staff.userId);
    const body = await (await memberGET()).json();
    expect(body[0]).not.toHaveProperty("usageCount");
  });

  /*
   * No membership requirement, deliberately. A user mid-onboarding has no
   * organisation yet and this is the list they choose one from — requiring a
   * membership would make the first screen after sign-up unreachable.
   */
  it("serves a user who belongs to no organisation yet", async () => {
    const fresh = await prisma.user.create({
      data: {
        name: "New Signup",
        email: `fresh-${Date.now()}@example.com`,
        hashedPassword: "hash",
      },
    });
    signedInAs(fresh.id);

    const res = await memberGET();
    expect(res.status).toBe(200);
    expect((await res.json())).toHaveLength(1);
  });

  it("refuses an anonymous caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await memberGET();
    expect(res.status).toBe(401);
  });
});
