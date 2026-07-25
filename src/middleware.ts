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
  "/dashboard-insights",
  "/ai-recommendations",
  "/tasks/parse",
  "/auto-schedule",
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

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
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