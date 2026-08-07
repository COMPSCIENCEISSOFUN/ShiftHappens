/**
 * Session control for route tests.
 *
 * WHAT IS MOCKED, AND WHY IT MATTERS
 *
 * These helpers drive a mock of `@/lib/auth` — the NextAuth `auth()` function
 * itself. They deliberately do NOT mock `@/lib/auth-guard`.
 *
 * `auth-guard` is the thing under test: `getAuthenticatedUser`,
 * `unauthorizedResponse`, `checkOrgSuspended` and `orgSuspendedResponse` are the
 * boundary logic these tests exist to verify. Stubbing that module would leave
 * the suite asserting against its own mock and proving nothing.
 *
 * Mocking one level lower — the session lookup — means everything from
 * `getAuthenticatedUser()` downwards is real: the membership query, the role
 * gate, the suspension check, the service call and the database.
 *
 * `auth()` is a plain function, not a class, so this also sidesteps the
 * documented Vitest 4 quirk where `vi.fn().mockImplementation()` misbehaves on
 * class mocks.
 *
 * USAGE — the mock declaration must live in the test file, because `vi.mock` is
 * hoisted to the top of the module it appears in:
 *
 *   vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
 *
 *   import { asUser, asAnonymous } from "../helpers/session";
 *
 *   asUser(tenant.admin.userId);
 *   const res = await GET(req(), ctx({ orgId: tenant.orgId }));
 */
import { vi } from "vitest";
import { auth } from "@/lib/auth";

/**
 * Signs in as a given user id.
 *
 * The shape mirrors what `getAuthenticatedUser` actually reads — it returns
 * `session.user` after checking `session?.user?.id` — so only `id` is load
 * bearing. `email` and `name` are included because some routes echo them.
 */
export function asUser(userId: string, extra: Record<string, unknown> = {}) {
  vi.mocked(auth).mockResolvedValue({
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: "Test User",
      sessionVersion: 0,
      ...extra,
    },
  } as never);
}

/** Signs in as a platform admin (for /api/platform/* routes). */
export function asPlatformAdmin(userId: string) {
  asUser(userId, { isPlatformAdmin: true });
}

/** No session at all — the 401 case. */
export function asAnonymous() {
  vi.mocked(auth).mockResolvedValue(null as never);
}

/**
 * A session whose user object has no id.
 *
 * `getAuthenticatedUser` checks `session?.user?.id`, not just `session`, so a
 * malformed session must also produce a 401. Worth asserting separately: a
 * naive rewrite to `if (!session)` would pass every other test in this suite.
 */
export function asMalformedSession() {
  vi.mocked(auth).mockResolvedValue({ user: {} } as never);
}
