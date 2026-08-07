/**
 * Next.js Middleware — Tiered Rate Limiting
 * 
 * Intercepts all API requests and applies rate limits based on
 * route pattern matching. Non-API routes (pages, assets) pass through.
 * 
 * Tiers:
 * - Strict (5 req/min): auth endpoints vulnerable to brute force
 * - Moderate (20 req/min): AI and invitation endpoints
 * - Relaxed (100 req/min): all other API endpoints
 * 
 * Rate limit headers are set on all API responses:
 * - X-RateLimit-Limit: max requests per window
 * - X-RateLimit-Remaining: requests left in current window
 * - X-RateLimit-Reset: seconds until window resets
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

/** Route patterns and their rate limit tiers */
const STRICT_PATTERNS = [
  "/api/register",
  "/api/forgot-password",
  "/api/reset-password",
  "/api/auth",
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
  "/feedback-themes",
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

function getTier(pathname: string): keyof typeof TIER_LIMITS {
  for (const pattern of STRICT_PATTERNS) {
    if (pathname.startsWith(pattern)) return "strict";
  }
  for (const pattern of MODERATE_PATTERNS) {
    if (pathname.includes(pattern)) return "moderate";
  }
  return "relaxed";
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
  const tier = getTier(pathname);
  const limit = TIER_LIMITS[tier];
  const key = `${ip}:${tier}`;

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