const DEFAULT_TIMEOUT_MS = 15_000;

/** Fetch wrapper that prevents external providers from occupying a request indefinitely. */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayAbort = () => controller.abort();
  init.signal?.addEventListener("abort", relayAbort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", relayAbort);
  }
}
