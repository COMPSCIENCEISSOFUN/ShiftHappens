/**
 * Bounds on how long an AI provider gets to answer.
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
