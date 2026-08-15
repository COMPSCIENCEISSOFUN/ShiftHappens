/**
 * A finished action is not a condition.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Where a persistent success banner is still the right element.
 *
 * `verify-email`: the confirmation is the whole page. There is no content
 * underneath for a toast to float over, and the user's next act is to press
 * the sign-in button directly beneath it.
 *
 * `billing`: the post-checkout banner reports a state that has NOT finished —
 * "your plan will update momentarily", because the tier is granted by the
 * WEBHOOK and not by the redirect — and it is driven by a URL parameter rather
 * than by a click, so it survives the reload it invites.
 *
 * It was on `settings` until 2026-08-11, when the upgrade flow moved to the
 * billing page and the banner went with it. **The canary below is what caught
 * that**: the allowlist still named a file that no longer had a success banner
 * in it, which is an exemption quietly protecting nothing. An allowlist nobody
 * checks is how a scan comes to look thorough while covering less every month.
 */
const ALLOWED = [
  join("src", "app", "(auth)", "verify-email", "page.tsx"),
  join("src", "app", "(app)", "org", "[orgId]", "billing", "page.tsx"),
];

function tsxFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFilesUnder(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("success feedback", () => {
  it("is a toast everywhere except the two places it is a state", () => {
    const offenders = tsxFilesUnder("src")
      .filter((f) => !ALLOWED.includes(f))
      .filter((f) => /variant="success"/.test(readFileSync(f, "utf8")));

    expect(
      offenders,
      "a completed action is confirmed with toast.success(), not a banner that stays on screen — see src/components/ui/alert-banner.tsx"
    ).toEqual([]);
  });

  /*
   * The canary.
   *
   * A scan that finds nothing is indistinguishable from a scan that looks
   * nowhere, and this one walks a directory tree by hand. If the walk breaks —
   * a renamed folder, a changed extension — the assertion above passes for the
   * worst possible reason. Asserting that the ALLOWED files are still found,
   * and still contain what makes them exceptions, proves the scan can see.
   */
  it("can still see the files it is exempting", () => {
    const found = tsxFilesUnder("src");
    for (const allowed of ALLOWED) {
      expect(found, `${allowed} is no longer reachable by the scan`).toContain(
        allowed
      );
      expect(readFileSync(allowed, "utf8")).toContain('variant="success"');
    }
  });
});
