/**
 * Tests that wait on a clock instead of on a condition.
 *
 * ## The bug
 *
 * Audit logging and notifications are fire-and-forget by design — the service
 * fires them with `void` so they can never block or fail the operation that
 * triggered them. That leaves a test with nothing to await, and ten files
 * answered it identically: sleep a fixed number of milliseconds, then assert.
 *
 * It surfaced the same way the `timestamp(3)` ordering bug did — as a test that
 * passed here and failed on Darryn's machine. `smart-swap.test.ts` slept 500ms
 * for work measured at 83ms on this sandbox, a six-fold margin, and still
 * failed on a Windows laptop run straight after a production build. Nothing was
 * wrong with the code. The test was making a claim about the hardware.
 *
 * ## Why a static check as well
 *
 * The seventeen sites were converted, which fixes seventeen tests. This covers
 * the eighteenth, written by whoever next needs to wait for a notification —
 * a promise wrapped round a timer is the natural thing to type when there is
 * nothing to await. That is exactly why it appeared ten times: each author
 * solved it correctly for the file in front of them.
 *
 * (The offending form is described rather than quoted, deliberately. Pasting it
 * in as an example would make this file its own first offender, and the fix for
 * that would be an allowlist entry — turning the list of genuine exceptions
 * into a list that also contains bookkeeping.)
 *
 * `task.service.test.ts` even had a polling helper with a docblock arguing for
 * precisely this, and it stayed file-local while nine other files slept. A
 * scan is what makes reasoning available to the person who has not read that
 * file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TESTS = join(process.cwd(), "tests");

/**
 * Sites where a bare sleep is genuinely the right tool, with the reason.
 *
 * Deliberately a file allowlist rather than an inline comment marker: adding a
 * file here is a visible edit to this list, where an `// eslint-disable`-style
 * escape hatch inside the test would not be.
 */
const ALLOWED: Record<string, string> = {
  // Forcing two rows into different milliseconds, not waiting for an effect.
  "repositories/notification.repository.test.ts":
    "guarantees distinct createdAt values for a countSince boundary",
  // Yielding so a `void promise` rejection reaches its handler. There is no
  // row to poll for — the observable is a spy call on the same tick.
  "services/auth.service.test.ts":
    "lets a discarded promise's rejection reach the logger before asserting",
  // The helper that implements the alternative.
  "helpers/settle.ts": "defines eventually() and pauseForAbsence()",
};

function walk(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) found.push(...walk(full, rel));
    else if (/\.tsx?$/.test(entry)) found.push(rel);
  }
  return found;
}

describe("no test waits on a fixed sleep", () => {
  it("finds no bare setTimeout waits outside the allowlist", () => {
    const offenders: string[] = [];

    for (const rel of walk(TESTS)) {
      if (rel in ALLOWED) continue;
      const source = readFileSync(join(TESTS, rel), "utf8");
      source.split("\n").forEach((line, i) => {
        // `new Promise(... setTimeout ...)` — a sleep. Calls to the named
        // helpers read as `pauseForAbsence(300)` and do not match.
        if (/new Promise\(\s*\(\w+\)\s*=>\s*setTimeout\(/.test(line)) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }

    /*
     * If this fails: waiting for something to APPEAR should use `eventually`,
     * `eventuallyAtLeast` or `eventuallyMatching` from tests/helpers/settle.
     * Waiting to prove something did NOT happen cannot be polled — use
     * `pauseForAbsence`, which is named so these sites stay greppable.
     */
    expect(offenders).toEqual([]);
  });

  // The allowlist is the argument for each exception; an empty reason is a
  // file that was waved through rather than justified.
  it("gives a reason for every allowed exception", () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });
});
