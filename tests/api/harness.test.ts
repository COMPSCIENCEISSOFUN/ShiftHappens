// @vitest-environment node
/**
 * Harness smoke test — RUN THIS FIRST.
 *
 * Before the contract suite is worth anything, four assumptions have to hold.
 * This file proves each one against a single real route, so that a failure here
 * points at the harness rather than at 90 routes at once:
 *
 *   1. `next/server` works under the node environment (jsdom lacks Request/
 *      Response/Headers, which NextRequest extends).
 *   2. A route module can be imported through the `@` alias despite the
 *      bracketed `[orgId]` path segment.
 *   3. Mocking `@/lib/auth` genuinely defeats `getAuthenticatedUser`, without
 *      stubbing the auth-guard logic under test.
 *   4. `ctx()` satisfies the Next 16 Promise-params contract.
 *
 * If this file passes and the contract suite does not, the problem is a route
 * or a manifest entry — not the plumbing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, POST } from "@/app/api/organizations/[orgId]/certifications/route";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { asUser, asAnonymous, asMalformedSession } from "../helpers/session";
import { ctx, req, jsonReq, bodyOf } from "../helpers/route";

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("harness");
  vi.clearAllMocks();
});

describe("route test harness", () => {
  it("can construct a NextRequest (proves the node environment)", () => {
    const request = req("/api/anything", { limit: 5 });
    expect(request.method).toBe("GET");
    expect(request.nextUrl.searchParams.get("limit")).toBe("5");
  });

  it("imported a real route module through the @ alias", () => {
    expect(typeof GET).toBe("function");
    expect(typeof POST).toBe("function");
  });

  it("returns 401 when there is no session", async () => {
    asAnonymous();
    const res = await GET(req(), ctx({ orgId: tenant.orgId }));
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error).toBe("Unauthorized");
  });

  it("returns 401 for a session with no user id", async () => {
    // getAuthenticatedUser checks session?.user?.id, not merely session.
    asMalformedSession();
    const res = await GET(req(), ctx({ orgId: tenant.orgId }));
    expect(res.status).toBe(401);
  });

  it("returns 403 for an authenticated non-member", async () => {
    asUser(tenant.outsider.userId);
    const res = await GET(req(), ctx({ orgId: tenant.orgId }));
    expect(res.status).toBe(403);
  });

  it("returns 403 for a member whose role is too low", async () => {
    // GET here is gated to company_admin | manager.
    asUser(tenant.staff.userId);
    const res = await GET(req(), ctx({ orgId: tenant.orgId }));
    expect(res.status).toBe(403);
  });

  it("returns 200 for a permitted member (proves the DB path is real)", async () => {
    asUser(tenant.admin.userId);
    const res = await GET(req(), ctx({ orgId: tenant.orgId }));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("reaches validation on a POST, proving the body is parsed", async () => {
    asUser(tenant.staff.userId);
    const res = await POST(
      jsonReq("POST", { name: "" }),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(400);
  });

  it("writes to the database on a valid POST", async () => {
    asUser(tenant.staff.userId);
    const res = await POST(
      jsonReq("POST", {
        name: "Food Safety Level 2",
        issuedDate: "2026-01-15T00:00:00.000Z",
      }),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(201);
  });

  /**
   * The property the whole exercise is for. A deactivated member is not a
   * member. Before the repository fix this returned 201 — the submission was
   * accepted from someone who had been removed from the organisation.
   */
  it("refuses a deactivated member", async () => {
    asUser(tenant.inactive.userId);
    const res = await POST(
      jsonReq("POST", {
        name: "Should Not Be Accepted",
        issuedDate: "2026-01-15T00:00:00.000Z",
      }),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(403);
  });
});
