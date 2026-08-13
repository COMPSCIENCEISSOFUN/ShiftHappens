/**
 * Next.js Middleware — Tiered Rate Limiting
 *
 * Intercepts all API requests and applies rate limits based on
 * route pattern matching. Non-API routes (pages, assets) pass through.
 *
 * Tiers:
 * - Strict (5 req/min): the endpoints where a secret is guessed
 * - Moderate (20 req/min): AI and invitation endpoints
 * - Relaxed (100 req/min): all other API endpoints
 *
 * Rate limit headers are set on all API responses:
 * - X-RateLimit-Limit: max requests per window
 * - X-RateLimit-Remaining: requests left in current window
 * - X-RateLimit-Reset: seconds until window resets
 *
 * ## `/api/auth` was the whole of Auth.js, not the password check
 *
 * The strict list carried the bare prefix `/api/auth`, which is the mount point
 * for EVERY Auth.js endpoint — issuing a CSRF token, reading the session,
 * listing providers, signing out — and only one of them, the credentials
 * callback, has a secret in it to guess. The rest is machinery the client must
 * call to do anything at all, and it was competing for the same five requests.
 *
 * The arithmetic made that fatal rather than merely tight. `signIn()` costs
 * three requests (`providers`, `csrf`, `callback/credentials`) and `signOut()`
 * costs two (`csrf`, `signout`) — so signing in and straight back out is five,
 * the entire minute's allowance, before a mistyped password is considered.
 *
 * And the failure was silent. `getCsrfToken()` swallows a failed fetch, logs a
 * `ClientFetchError` and returns `""`; `signOut` then posts an empty token,
 * which is rejected, so THE SESSION COOKIE WAS NEVER CLEARED. The browser
 * redirected to `/login` anyway, `/login` bounced the still-signed-in user to
 * `/dashboard`, and they landed back where they started. Pressing Log out did
 * nothing, visibly succeeded, and left a console error with no message in it.
 *
 * Development made it constant: with no `x-real-ip` or `x-forwarded-for`,
 * `getClientIp` returns `"unknown"` and every tab shares one bucket.
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

/**
 * The endpoints where somebody is guessing a secret.
 *
 * Each is a password or a single-use token being submitted for checking, which
 * is the only thing 5-per-minute is the right answer to. `/api/auth/csrf`,
 * `/api/auth/session`, `/api/auth/signout` and `/api/auth/providers` are
 * deliberately NOT here — nothing about them can be brute-forced, and they fall
 * to the relaxed tier with every other read.
 *
 * ⚠️ `callback/credentials` is where `signIn()` posts a password, and it is
 * named exactly rather than by prefix. If the provider is ever renamed, or a
 * second one added, this list must move with it — a path that matches nothing
 * removes the protection SILENTLY, which is the dangerous direction. The tests
 * build their request from the same construction Auth.js uses, so a change
 * there fails the suite rather than quietly widening the door.
 */
const STRICT_PATTERNS = [
  "/api/register",
  "/api/forgot-password",
  "/api/reset-password",
  "/api/auth/callback/credentials",
];

const MODERATE_PATTERNS = [
  "/api/verify-email",
  "/api/invitations",
  "/tasks/suggest",
  "/tasks/auto-allocate",
  "/ai-recommendations",
  // Reads every comment in the window and sends them to a model. Its docblock
  // claimed the moderate tier; the pattern list did not carry it, so it sat in
  // the relaxed 100/min bucket while its sibling next door was capped at 20.
  "/tasks/parse",
  "/auto-schedule",
  // Spends Groq and, on a parse failure, Gemini too — and needs only a session,
  // no membership and no subscription tier. It was the one AI endpoint left in
  // the relaxed 100/min bucket while every sibling sat at 20.
  "/organizations/generate-template",
];

const TIER_LIMITS = {
  strict: 5,
  moderate: 20,
  relaxed: 100,
} as const;

/**
 * Which tier a path falls in, and which COUNTER it draws from.
 *
 * The two used to be the same thing — one bucket per tier — so the four strict
 * endpoints shared a single allowance of five. Asking for a password reset
 * therefore spent the sign-in attempts, and vice versa: a limit described as
 * "5 sign-in attempts a minute" was nothing of the kind.
 *
 * Strict gets a bucket PER PATTERN, because each one protects a different
 * secret and exhausting one says nothing about the others.
 *
 * Moderate deliberately keeps ONE shared bucket. It is not protecting a secret;
 * it is capping spend on Groq and Gemini, and that budget is shared by
 * definition. Splitting it per pattern would turn 20 calls a minute into 20 ×
 * the number of AI endpoints, which is the opposite of what the tier is for.
 *
 * Relaxed likewise stays shared — a flood guard over everything else.
 */
function classify(pathname: string): {
  tier: keyof typeof TIER_LIMITS;
  bucket: string;
} {
  for (const pattern of STRICT_PATTERNS) {
    if (pathname.startsWith(pattern)) return { tier: "strict", bucket: pattern };
  }
  for (const pattern of MODERATE_PATTERNS) {
    if (pathname.includes(pattern)) return { tier: "moderate", bucket: "moderate" };
  }
  return { tier: "relaxed", bucket: "relaxed" };
}

/**
 * The client's IP, as far as it can be trusted.
 *
 * ## Why not the first x-forwarded-for entry
 *
 * X-Forwarded-For is `client, proxy1, proxy2` — and the LEFT-most entry is
 * whatever the caller sent. A client can put anything there; the proxy appends
 * rather than replaces. Reading `[0]` therefore let anyone mint a fresh rate
 * limit bucket per request simply by varying a header, which made the 5/min
 * cap on credential sign-in decorative rather than protective.
 *
 * Behind exactly one trusted proxy — which is what Vercel is — the entry the
 * proxy appended is the LAST one, and it is the only one the caller could not
 * forge. So: prefer `x-real-ip`, which the platform sets and overwrites, and
 * otherwise take the right-most forwarded entry.
 *
 * ⚠️ If this app is ever put behind a second proxy (a CDN in front of Vercel,
 * say), the right-most entry becomes that proxy's address and every caller
 * collapses into one bucket. At that point this needs to skip a known number of
 * trusted hops instead. Nothing here can detect that automatically.
 */
function getClientIp(request: NextRequest): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  // Everything without a usable address shares one bucket. That is deliberately
  // strict: an unidentifiable caller should be limited alongside every other
  // unidentifiable caller rather than handed its own allowance.
  return "unknown";
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only rate limit API routes
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const ip = getClientIp(request);
  const { tier, bucket } = classify(pathname);
  const limit = TIER_LIMITS[tier];
  const key = `${ip}:${bucket}`;

  const result = rateLimit(key, limit);

  if (!result.success) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(result.limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil(result.resetIn / 1000)),
          "Retry-After": String(Math.ceil(result.resetIn / 1000)),
        },
      }
    );
  }

  const response = NextResponse.next();
  response.headers.set("X-RateLimit-Limit", String(result.limit));
  response.headers.set("X-RateLimit-Remaining", String(result.remaining));
  response.headers.set("X-RateLimit-Reset", String(Math.ceil(result.resetIn / 1000)));

  return response;
}

export const config = {
  matcher: "/api/:path*",
};