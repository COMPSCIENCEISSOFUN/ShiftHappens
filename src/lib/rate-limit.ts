/**
 * In-Memory Rate Limiter
 * 
 * Provides tiered rate limiting using a sliding window counter.
 * Keyed by IP + route pattern to allow different limits per tier.
 * 
 * Tiers:
 * - Strict (5 req/min): registration and password recovery endpoints
 * - Moderate (20 req/min): credential login, AI endpoints, invitations, email verification
 * - Relaxed (100 req/min): all other API routes
 * 
 * Production note: In-memory storage works for single-server deployments.
 * For serverless (Vercel), swap to Redis or Vercel KV for shared state.
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const store = new Map<string, RateLimitEntry>();

/** Cleanup expired entries every 60 seconds to prevent memory leaks */
const CLEANUP_INTERVAL_MS = 60_000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now >= entry.resetTime) {
        store.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Allow Node.js process to exit even if timer is running
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

startCleanup();

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetIn: number;
}

/**
 * Checks and increments the rate limit counter for a given key.
 * 
 * @param key - Unique identifier (typically "IP:routePattern")
 * @param maxRequests - Maximum requests allowed in the window
 * @param windowMs - Time window in milliseconds (default: 60000 = 1 minute)
 */
export function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number = 60_000
): RateLimitResult {
  const now = Date.now();
  const entry = store.get(key);

  // No existing entry or window expired — start fresh
  if (!entry || now >= entry.resetTime) {
    store.set(key, { count: 1, resetTime: now + windowMs });
    return {
      success: true,
      limit: maxRequests,
      remaining: maxRequests - 1,
      resetIn: windowMs,
    };
  }

  // Within window — increment and check
  entry.count += 1;
  const resetIn = entry.resetTime - now;

  if (entry.count > maxRequests) {
    return {
      success: false,
      limit: maxRequests,
      remaining: 0,
      resetIn,
    };
  }

  return {
    success: true,
    limit: maxRequests,
    remaining: maxRequests - entry.count,
    resetIn,
  };
}

/** Clears all entries — used in tests */
export function resetRateLimitStore() {
  store.clear();
}
