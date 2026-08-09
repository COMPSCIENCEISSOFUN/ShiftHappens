/**
 * Which endpoints are rate limited, and out of whose allowance.
 *
 * ## The bug these were written for
 *
 * The strict list carried the bare prefix `/api/auth`. That is the mount point
 * for every Auth.js endpoint, and only one of them — the credentials callback —
 * has a secret in it to guess. Issuing a CSRF token, listing providers, reading
 * a session and signing out were all competing for the same five requests a
 * minute.
 *
 * The arithmetic is what made it break rather than merely pinch. `signIn()`
 * costs three requests and `signOut()` costs two, so signing in and straight
 * back out spends the whole minute before a mistyped password is considered.
 *
 * And logging out then failed SILENTLY: `getCsrfToken()` swallows a failed
 * fetch and returns an empty string, `signOut` posts that, the server rejects
 * it, and the session cookie is never cleared. The browser redirects to
 * `/login` regardless, which bounces a still-signed-in user onward. Pressing
 * Log out appeared to work and did nothing.
 *
 * ## What is asserted
 *
 * Both halves, because either alone would have let the bug through: that the
 * password check is STILL strictly limited, and that the machinery around it is
 * not. A test of the first alone passes on the broken version.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { resetRateLimitStore } from "@/lib/rate-limit";

const IP = "203.0.113.9";

/*
 * The Auth.js endpoints, spelled as the client builds them.
 *
 * `signIn()` composes `${basePath}/callback/${provider}` for a credentials
 * provider and calls `providers` then `csrf` first; `signOut()` calls `csrf`
 * then posts to `signout`. Verified against `node_modules/next-auth/react.js`
 * rather than recalled, because the whole fix depends on one of these paths
 * being named exactly and a wrong spelling would remove the protection without
 * failing anything.
 */
const SIGN_IN = "/api/auth/callback/credentials";
const CSRF = "/api/auth/csrf";
const SESSION = "/api/auth/session";
const SIGN_OUT = "/api/auth/signout";
const PROVIDERS = "/api/auth/providers";

function call(path: string) {
  return middleware(
    new NextRequest(`https://example.com${path}`, {
      headers: new Headers({ "x-real-ip": IP }),
    })
  );
}

/** The limit the middleware applied, read off the response it produced. */
function limitOf(path: string): number {
  return Number(call(path).headers.get("X-RateLimit-Limit"));
}

/** Calls a path until it is refused, and reports how many got through. */
function untilRefused(path: string, attempts = 40): number {
  let allowed = 0;
  for (let i = 0; i < attempts; i++) {
    if (call(path).status === 429) return allowed;
    allowed++;
  }
  return allowed;
}

beforeEach(() => {
  resetRateLimitStore();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what the strict tier covers", () => {
  it("still limits the password check to five a minute", () => {
    expect(limitOf(SIGN_IN)).toBe(5);
    expect(untilRefused(SIGN_IN)).toBe(4); // one already spent above
  });

  it("still limits registration and the two password-reset endpoints", () => {
    expect(limitOf("/api/register")).toBe(5);
    expect(limitOf("/api/forgot-password")).toBe(5);
    expect(limitOf("/api/reset-password")).toBe(5);
  });

  /*
   * The other half, and the one the bug lived in. None of these has anything to
   * guess: a CSRF token is issued, not submitted; a session read returns what
   * the cookie already proves; signing out destroys rather than tests.
   */
  it("does not put the Auth.js machinery in with them", () => {
    expect(limitOf(CSRF)).toBe(100);
    expect(limitOf(SESSION)).toBe(100);
    expect(limitOf(SIGN_OUT)).toBe(100);
    expect(limitOf(PROVIDERS)).toBe(100);
  });

  /*
   * The machinery costs the password check NOTHING, which is the statement the
   * whole fix rests on.
   *
   * Asserted this way round rather than as "a sign-in and a sign-out both
   * complete" — that journey is five requests against a limit of five, so it
   * sits exactly ON the old boundary and passes on the broken version too. It
   * would have read as a test of the bug while being unable to detect it, which
   * is the failure mode this project keeps finding. Counting the allowance left
   * afterwards discriminates; walking the happy path does not.
   */
  it("spends none of the sign-in allowance on the machinery", () => {
    for (const path of [PROVIDERS, CSRF, SIGN_OUT, SESSION]) call(path);

    expect(untilRefused(SIGN_IN)).toBe(5);
  });

  // And with a mistyped password in the middle, which is the case that made it
  // intermittent rather than constant.
  it("survives a failed attempt before the successful one", () => {
    const journey = [PROVIDERS, CSRF, SIGN_IN, CSRF, SIGN_IN, CSRF, SIGN_OUT];
    for (const path of journey) {
      expect(call(path).status).not.toBe(429);
    }
  });
});

describe("one counter per secret", () => {
  /*
   * The four strict endpoints shared a single bucket, so a limit described as
   * "five sign-in attempts a minute" was really five attempts across sign-in,
   * registration and both halves of password reset combined.
   */
  it("does not let a password reset spend the sign-in attempts", () => {
    untilRefused("/api/forgot-password");

    expect(call(SIGN_IN).status).not.toBe(429);
  });

  it("does not let registration spend them either", () => {
    untilRefused("/api/register");

    expect(call(SIGN_IN).status).not.toBe(429);
  });

  it("still exhausts the one that is being hammered", () => {
    untilRefused("/api/register");

    expect(call("/api/register").status).toBe(429);
  });

  // Different callers are still separate, which is what the whole thing is for.
  it("keeps one caller's exhaustion away from another's", () => {
    untilRefused(SIGN_IN);

    const other = middleware(
      new NextRequest(`https://example.com${SIGN_IN}`, {
        headers: new Headers({ "x-real-ip": "198.51.100.4" }),
      })
    );
    expect(other.status).not.toBe(429);
  });
});

describe("the moderate tier stays shared, deliberately", () => {
  /*
   * Not an oversight and not the same question as the strict tier. Moderate is
   * capping spend on Groq and Gemini, and that budget is shared by definition —
   * a bucket per pattern would turn 20 calls a minute into 20 times the number
   * of AI endpoints, which is the opposite of the point.
   */
  it("counts two different AI endpoints against one allowance", () => {
    untilRefused("/api/organizations/o1/tasks/suggest");

    expect(call("/api/organizations/o1/auto-schedule").status).toBe(429);
  });

  it("caps them at twenty rather than five", () => {
    expect(limitOf("/api/organizations/o1/tasks/suggest")).toBe(20);
  });

  // The tier is decided in order, so an AI path that also began with a strict
  // prefix would have to be caught by the strict check first. None does today;
  // this pins the ordering rather than the current list.
  it("leaves everything else in the relaxed tier", () => {
    expect(limitOf("/api/organizations/o1/tasks")).toBe(100);
  });
});

describe("what is not limited at all", () => {
  it("lets pages through untouched", () => {
    const res = middleware(
      new NextRequest("https://example.com/org/o1/members", {
        headers: new Headers({ "x-real-ip": IP }),
      })
    );

    expect(res.status).not.toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
  });
});
