/**
 * Tests for client IP resolution in the rate-limiting middleware.
 *
 * The middleware keyed its buckets on the FIRST entry of `X-Forwarded-For`.
 * That header is `client, proxy1, proxy2` and the left-most entry is whatever
 * the caller sent — a proxy appends to it, it does not replace it. So anyone
 * could vary a header per request, land in a fresh bucket every time, and never
 * meet a limit. The 5-per-minute cap on credential sign-in was decorative.
 *
 * Behind exactly one trusted proxy — Vercel — the entry the proxy appended is
 * the LAST one, and it is the only one the caller cannot forge.
 *
 * `getClientIp` is not exported (Next.js middleware modules export only
 * `middleware` and `config`), so these tests exercise it through `middleware`
 * itself and read the bucket back out of the rate limiter. That is a stronger
 * test than calling the helper directly: it proves the value actually used for
 * limiting is the one we think it is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { rateLimit, resetRateLimitStore } from "@/lib/rate-limit";

/**
 * The path a password is posted to, spelled the way Auth.js builds it.
 *
 * `signIn()` composes `${basePath}/callback/${provider}` for a credentials
 * provider — verified against `node_modules/next-auth/react.js` — and the
 * middleware's strict list names that exact path rather than the `/api/auth`
 * prefix it used to carry. Writing it here as one constant is what makes these
 * tests fail rather than silently pass if the two ever drift: a strict pattern
 * matching nothing removes the protection without breaking anything.
 */
const SIGN_IN_PATH = "/api/auth/callback/credentials";

/** A request to a strict-tier path (5/min) with the given forwarding headers. */
function request(headers: Record<string, string>) {
  return new NextRequest(`https://example.com${SIGN_IN_PATH}`, {
    headers: new Headers(headers),
  });
}

/**
 * How many of sign-in's 5 requests remain for this IP.
 *
 * The bucket is keyed on the PATTERN now, not the tier. Each strict endpoint
 * protects a different secret, and one shared counter meant a password reset
 * spent the sign-in attempts.
 *
 * `rateLimit` counts, so calling it consumes one. The caller accounts for that.
 */
function remainingFor(ip: string): number {
  return rateLimit(`${ip}:${SIGN_IN_PATH}`, 5).remaining;
}

beforeEach(() => {
  resetRateLimitStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getClientIp — spoofing", () => {
  it("keys on the LAST forwarded entry, not the caller-supplied first", () => {
    middleware(request({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }));

    // The proxy-appended address consumed the request...
    expect(remainingFor("203.0.113.9")).toBe(3);
    // ...and the address the caller claimed did not.
    expect(remainingFor("1.1.1.1")).toBe(4);
  });

  it("a caller varying the spoofed prefix still shares one bucket", () => {
    // The actual attack: five sign-in attempts, each claiming a different
    // origin. Before the fix each got its own allowance and the limit never
    // engaged. Now all five land on the address the proxy appended.
    for (let i = 0; i < 5; i++) {
      middleware(request({ "x-forwarded-for": `10.0.0.${i}, 203.0.113.9` }));
    }

    const blocked = middleware(request({ "x-forwarded-for": "10.0.0.99, 203.0.113.9" }));
    expect(blocked.status).toBe(429);
  });

  it("prefers x-real-ip, which the platform sets and a caller cannot append to", () => {
    middleware(
      request({
        "x-real-ip": "203.0.113.9",
        "x-forwarded-for": "1.1.1.1, 2.2.2.2",
      })
    );

    expect(remainingFor("203.0.113.9")).toBe(3);
    expect(remainingFor("2.2.2.2")).toBe(4);
  });

  it("still identifies a normal single-proxy request", () => {
    // Guard against over-correction — the ordinary case must keep working.
    middleware(request({ "x-forwarded-for": "203.0.113.9" }));

    expect(remainingFor("203.0.113.9")).toBe(3);
  });
});

describe("getClientIp — edge cases", () => {
  it("ignores empty entries and stray whitespace", () => {
    middleware(request({ "x-forwarded-for": "1.1.1.1, , 203.0.113.9 ," }));

    expect(remainingFor("203.0.113.9")).toBe(3);
  });

  it("falls back to a shared bucket when no address is available", () => {
    // Deliberately strict: an unidentifiable caller is limited alongside every
    // other unidentifiable caller rather than being handed its own allowance.
    middleware(request({}));
    middleware(request({}));

    expect(remainingFor("unknown")).toBe(2);
  });

  it("treats an entirely empty forwarded header as no address", () => {
    middleware(request({ "x-forwarded-for": "  " }));

    expect(remainingFor("unknown")).toBe(3);
  });

  it("does not rate limit non-API paths", () => {
    const res = middleware(
      new NextRequest("https://example.com/login", {
        headers: new Headers({ "x-forwarded-for": "203.0.113.9" }),
      })
    );

    expect(res.status).not.toBe(429);
    // Nothing was counted against the address.
    expect(remainingFor("203.0.113.9")).toBe(4);
  });
});
