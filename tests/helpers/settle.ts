/**
 * Waiting for work the service deliberately did not await.
 */

/** How long to keep asking before giving up. Well under the 20s test timeout. */
const DEFAULT_TIMEOUT_MS = 5000;

/** How long to wait between attempts. Short enough to stay fast when it lands. */
const DEFAULT_INTERVAL_MS = 25;

/**
 * Re-run `probe` until `isDone` accepts its result, or the timeout expires.
 *
 * Returns the LAST observed value either way rather than throwing. The caller's
 * own assertion then produces the failure, which matters: a helper that threw
 * "timed out after 5000ms" would replace a message about the actual data with a
 * message about the clock, and the two failures need different fixes.
 */
export async function eventually<T>(
  probe: () => Promise<T>,
  isDone: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();
    if (isDone(value) || Date.now() >= deadline) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Wait until at least `count` rows come back, then return them.
 *
 * The common shape: a fire-and-forget write is expected to produce one or more
 * rows, and the test wants them.
 */
export async function eventuallyAtLeast<T>(
  probe: () => Promise<T[]>,
  count = 1,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<T[]> {
  return eventually(probe, (rows) => rows.length >= count, options);
}

/**
 * Wait for a row matching `match`, returning every row seen on the last attempt.
 *
 * Returns the whole list, not the match. Asserting against the full set is what
 * lets a failure distinguish "nothing arrived yet" from "the wrong thing
 * arrived" — `expect(titles).toContain(x)` names what WAS there, where
 * `expect(found).toBeDefined()` reports only `undefined` and sends the reader
 * looking for a race that may not exist.
 */
export async function eventuallyMatching<T>(
  probe: () => Promise<T[]>,
  match: (row: T) => boolean,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<T[]> {
  return eventually(probe, (rows) => rows.some(match), options);
}

/**
 * A fixed pause, for the one case polling cannot serve: asserting that a
 * fire-and-forget effect did NOT happen.
 *
 * Named rather than inlined so these sites are greppable and honest about what
 * they are. Read the caveat at the top of this file before adding one.
 */
export function pauseForAbsence(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
