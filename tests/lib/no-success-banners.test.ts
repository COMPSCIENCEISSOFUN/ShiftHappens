/**
 * A finished action is not a condition.
 *
 * Eight pages confirmed a completed action — "Invitation sent to …", "Schedule
 * saved", "Task updated" — with a persistent `AlertBanner`. Each one pushed the
 * page down, landed wherever that page happened to render it (on Members,
 * between the stat tiles and the search box), and stayed until the next
 * navigation. One of them had already been "fixed" locally by clearing the
 * state at the top of every handler, which left the same defect standing on the
 * other seven: it was treated as a bug in one file rather than as a consequence
 * of the choice of element.
 *
 * They are toasts now. This stops the ninth.
 *
 * ## Why a scan rather than a lint rule or a code review
 *
 * The mistake is invisible in review: `<AlertBanner variant="success" />` is
 * correct-looking, consistent with the file around it, and behaves fine on the
 * screen where you test it. Nothing fails. The reason not to write it is a
 * convention, and a convention nobody can see is a convention that erodes —
 * which is exactly the argument `audit-coverage` makes about audit entries
 * being raised from Control.
 *
 * ## The exceptions are named, not pattern-matched
 *
 * Both are success messages that describe something still true rather than
 * something finished, and the difference cannot be read off the markup. Listing
 * the files means adding a ninth is a deliberate act with a reason attached to
 * it, rather than a scan quietly widening.
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
