/**
 * Bounds on how long an AI provider gets to answer.
 *
 * ## Why this is a shared constant rather than a local one
 *
 * The dashboard fixed this properly and nowhere else did. Its docblock states
 * the problem exactly — a hung connection is neither an error nor a non-ok
 * response, so a failover chain that advances on a throw never advances at all,
 * and the whole point of having a second provider is defeated by the failure
 * mode second providers exist for.
 *
 * That reasoning applies to every provider call in the codebase, and four other
 * call sites had no bound: both allocation providers, both auto-schedule calls,
 * both task-parser calls and both template-generation calls. Each of them sits
 * in front of a real deterministic fallback — `FallbackRanker`,
 * `generateAlgorithmic`, `fallbackParse`, the preset templates — and each of
 * those fallbacks was unreachable on a hang.
 *
 * Stated once so a new provider call cannot quietly omit it.
 */
export const AI_TIMEOUT_MS = 8000;

/**
 * A signal that aborts an AI call after {@link AI_TIMEOUT_MS}.
 *
 * A function rather than a shared signal: `AbortSignal.timeout` starts counting
 * the moment it is created, so one module-level instance would already be
 * expired by the second request.
 */
export function aiTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(AI_TIMEOUT_MS);
}

/**
 * Is a provider usable at all?
 *
 * Auto-schedule checked nothing and sent `Authorization: Bearer undefined` to
 * Groq, then `?key=undefined` to Gemini — two real outbound round-trips per
 * generate in an environment with no keys, each of which then had to time out
 * before the deterministic scheduler ran. Every other call site guards; this
 * makes the guard one expression rather than a convention to remember.
 */
export function hasApiKey(key: string | undefined | null): key is string {
  return typeof key === "string" && key.trim().length > 0;
}
