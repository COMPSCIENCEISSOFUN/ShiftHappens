// @vitest-environment node
/**
 * The Boundary-layer contract, asserted against every declared route.
 *
 * This suite deliberately tests ONLY what routes alone do. Business logic is
 * already covered at the service layer, and re-testing it through an extra
 * function call would double the maintenance for no new information. What is
 * verified here has no other home:
 *
 *   1. Anonymous callers are refused (401)
 *   2. A session with no user id is refused — getAuthenticatedUser checks
 *      session?.user?.id, and a rewrite to `if (!session)` would pass everything else
 *   3. Authenticated non-members are refused (403)
 *   4. Members below the required role are refused (403)
 *   5. DEACTIVATED members are refused (403)
 *   6. Suspended organisations are refused where declared (403)
 *
 * Item 5 is the reason this exists. Before `findByUserAndOrg` filtered on
 * status, a deactivated member satisfied every `if (!membership)` gate in the
 * application and kept full access to an organisation they had been removed
 * from. Only three route files checked it themselves.
 *
 * Route modules are loaded lazily through import.meta.glob so that one route
 * failing to import (a missing env var, say) reports as one failure rather than
 * collapsing the file.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, suspendOrg, type Tenant } from "../helpers/fixtures";
import { asUser, asAnonymous, asMalformedSession } from "../helpers/session";
import { ctx, requestFor, bodyOf } from "../helpers/route";
import {
  ORG_ROUTES,
  ROLE_GATED_ROUTES,
  SUSPENSION_ROUTES,
  SESSION_ROUTES,
  type RouteSpec,
} from "./routes.manifest";

/** Lazy loaders for every route module, keyed by path relative to src/app/api. */
const MODULES = import.meta.glob("../../src/app/api/**/route.ts");

function loaderFor(spec: RouteSpec) {
  const key = `../../src/app/api/${spec.path}/route.ts`;
  const loader = MODULES[key];
  if (!loader) {
    throw new Error(
      `No route module found at ${key}. Either the manifest path is wrong or the file was deleted.`
    );
  }
  return loader as () => Promise<Record<string, unknown>>;
}

type Handler = (
  request: unknown,
  context: { params: Promise<Record<string, string>> }
) => Promise<Response>;

async function handlerFor(spec: RouteSpec): Promise<Handler | null> {
  const mod = await loaderFor(spec)();
  const fn = mod[spec.method];
  return typeof fn === "function" ? (fn as Handler) : null;
}

/**
 * Placeholder ids for params other than orgId.
 *
 * Safe because every gate under test runs before the entity is looked up — a
 * non-existent taskId cannot turn a 403 into a 404 if the role check rejects
 * first. If a route ever regressed to looking things up before authorising,
 * these assertions would fail, which is the correct outcome.
 */
function paramsFor(spec: RouteSpec, orgId: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (spec.orgScoped && !spec.orgIdInQuery) params.orgId = orgId;
  for (const name of spec.extraParams ?? []) {
    params[name] = params[name] ?? `placeholder-${name}`;
  }
  return params;
}

async function call(spec: RouteSpec, orgId: string): Promise<Response | null> {
  const handler = await handlerFor(spec);
  if (!handler) return null;

  const request = requestFor(spec.method, {
    query: spec.orgIdInQuery ? { orgId } : {},
    body: {},
  });
  return handler(request, ctx(paramsFor(spec, orgId)));
}

const label = (spec: RouteSpec) => `${spec.method} /api/${spec.path}`;

let tenant: Tenant;

beforeAll(() => {
  // A manifest that silently declares nothing would make every test below
  // vacuously pass.
  expect(SESSION_ROUTES.length).toBeGreaterThan(50);
  expect(ORG_ROUTES.length).toBeGreaterThan(50);
  expect(ROLE_GATED_ROUTES.length).toBeGreaterThan(20);
  expect(SUSPENSION_ROUTES.length).toBeGreaterThan(10);
});

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("contract");
  vi.clearAllMocks();
});

describe("every route module declared in the manifest exists and exports its method", () => {
  it.each(SESSION_ROUTES.map((s) => [label(s), s] as const))(
    "%s is importable",
    async (_name, spec) => {
      const handler = await handlerFor(spec);
      expect(handler).toBeTypeOf("function");
    }
  );
});

describe("anonymous callers are refused", () => {
  it.each(SESSION_ROUTES.map((s) => [label(s), s] as const))(
    "%s → 401",
    async (_name, spec) => {
      asAnonymous();
      const res = await call(spec, tenant.orgId);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
      expect((await bodyOf(res!)).error).toBe("Unauthorized");
    }
  );
});

describe("a session with no user id is refused", () => {
  it.each(SESSION_ROUTES.map((s) => [label(s), s] as const))(
    "%s → 401",
    async (_name, spec) => {
      asMalformedSession();
      const res = await call(spec, tenant.orgId);
      expect(res!.status).toBe(401);
    }
  );
});

describe("authenticated non-members are refused", () => {
  it.each(ORG_ROUTES.map((s) => [label(s), s] as const))(
    "%s → 403",
    async (_name, spec) => {
      asUser(tenant.outsider.userId);
      const res = await call(spec, tenant.orgId);
      expect(res!.status).toBe(403);
    }
  );
});

describe("DEACTIVATED members are refused", () => {
  // The property the membership-status fix exists to provide. Every one of
  // these returned a success or a 404 before that change.
  it.each(ORG_ROUTES.map((s) => [label(s), s] as const))(
    "%s → 403",
    async (_name, spec) => {
      asUser(tenant.inactive.userId);
      const res = await call(spec, tenant.orgId);
      expect(res!.status).toBe(403);
    }
  );
});

describe("members below the required role are refused", () => {
  it.each(
    ROLE_GATED_ROUTES.map((s) => [label(s), s] as const)
  )("%s → 403 for staff", async (_name, spec) => {
    asUser(tenant.staff.userId);
    const res = await call(spec, tenant.orgId);
    expect(res!.status).toBe(403);
  });

  it.each(
    ROLE_GATED_ROUTES.filter((s) => s.roles?.length === 1).map(
      (s) => [label(s), s] as const
    )
  )("%s → 403 for a manager (admin-only)", async (_name, spec) => {
    asUser(tenant.manager.userId);
    const res = await call(spec, tenant.orgId);
    expect(res!.status).toBe(403);
  });
});

describe("suspended organisations are refused", () => {
  it.each(SUSPENSION_ROUTES.map((s) => [label(s), s] as const))(
    "%s → 403",
    async (_name, spec) => {
      await suspendOrg(tenant.orgId);
      // Called as the admin, so only the suspension gate can produce the 403.
      asUser(tenant.admin.userId);
      const res = await call(spec, tenant.orgId);
      expect(res!.status).toBe(403);
      expect((await bodyOf(res!)).error).toBe("Organization is suspended");
    }
  );
});
