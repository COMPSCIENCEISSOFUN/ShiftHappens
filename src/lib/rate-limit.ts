import { prisma } from "@/lib/prisma";

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetIn: number;
}

type Entry = { count: number; resetTime: number };
const developmentStore = new Map<string, Entry>();

/** Test/dev helper. Production buckets expire in the database. */
export function resetRateLimitStore() {
  developmentStore.clear();
}

function localRateLimit(key: string, maxRequests: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = developmentStore.get(key);
  const entry = !existing || existing.resetTime <= now
    ? { count: 1, resetTime: now + windowMs }
    : { count: existing.count + 1, resetTime: existing.resetTime };
  developmentStore.set(key, entry);
  return {
    success: entry.count <= maxRequests,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - entry.count),
    resetIn: Math.max(0, entry.resetTime - now),
  };
}

/** Shared DB-backed limiter in production; deterministic local limiter in tests/dev. */
export async function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number = 60_000
): Promise<RateLimitResult> {
  if (process.env.NODE_ENV !== "production") {
    return localRateLimit(key, maxRequests, windowMs);
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowMs);
  const rows = await prisma.$queryRaw<{ count: number; expiresAt: Date }[]>`
    INSERT INTO "RateLimitBucket" ("key", "count", "windowStart", "expiresAt")
    VALUES (${key}, 1, ${now}, ${expiresAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitBucket"."expiresAt" <= ${now} THEN 1
        ELSE "RateLimitBucket"."count" + 1
      END,
      "windowStart" = CASE
        WHEN "RateLimitBucket"."expiresAt" <= ${now} THEN ${now}
        ELSE "RateLimitBucket"."windowStart"
      END,
      "expiresAt" = CASE
        WHEN "RateLimitBucket"."expiresAt" <= ${now} THEN ${expiresAt}
        ELSE "RateLimitBucket"."expiresAt"
      END
    RETURNING "count", "expiresAt"
  `;
  const bucket = rows[0];
  return {
    success: bucket.count <= maxRequests,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - bucket.count),
    resetIn: Math.max(0, bucket.expiresAt.getTime() - now.getTime()),
  };
}
