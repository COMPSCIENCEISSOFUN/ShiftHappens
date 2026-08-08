/**
 * Icons drawn by hand where the icon set already has one.
 *
 * ## The bug
 *
 * `lucide-react` is the house icon set and most of the application uses it.
 * Alongside it, 46 `<svg>` elements had been hand-written across nine page
 * files — and sampling the paths showed them reproducing icons lucide already
 * provides and this codebase already imports elsewhere: `Sparkles`, `Clock`,
 * `Users`, `Zap`, `Search`, `Trash2`, `SquarePen`.
 *
 * They were drawn at different stroke widths and sizes, so a screen carrying
 * both showed two icons of the same idea that did not match. The tasks page had
 * eleven, four of them the same star at four different sizes.
 *
 * ## Why a scan and not another sweep
 *
 * `claude/PHASE7-ICON-SWEEP-AND-HOURS-FIX.md` records an icon sweep already
 * having been done once. It drifted back, because pasting an `<svg>` is the
 * fastest way to get a glyph on screen and nothing objected. A second sweep
 * without a guard buys the same amount of time as the first one did.
 *
 * Same reasoning as `ordering-determinism` and `no-fixed-sleeps`: the defect is
 * the natural thing to type, so fixing the known instances is not enough.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PAGES = join(process.cwd(), "src", "app");

/**
 * Files where a hand-drawn `<svg>` is the right answer, with the reason.
 *
 * A file allowlist rather than an inline marker: adding one is a visible edit
 * here, where an escape-hatch comment inside the file would not be.
 */
const ALLOWED: Record<string, string> = {
  // The favicon-ish brand mark, which is not an icon-set glyph and has no
  // lucide equivalent by definition.
  "layout.tsx": "brand mark, not an icon from the set",
};

function walk(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) found.push(...walk(full, rel));
    else if (/\.tsx$/.test(entry)) found.push(rel);
  }
  return found;
}

describe("pages use the icon set rather than drawing their own", () => {
  it("finds no inline <svg> outside the allowlist", () => {
    const offenders: string[] = [];

    for (const rel of walk(PAGES)) {
      if (ALLOWED[rel.split("/").pop() ?? ""]) continue;
      const source = readFileSync(join(PAGES, rel), "utf8");
      source.split("\n").forEach((line, i) => {
        if (line.includes("<svg")) offenders.push(`${rel}:${i + 1}`);
      });
    }

    /*
     * If this fails: find the matching component at https://lucide.dev, import
     * it, and size it with `className="h-4 w-4"` rather than width/height
     * attributes — that is what every already-converted call site does, and
     * matching it is most of the point.
     *
     * Deliberately scoped to `src/app`. `components/layout/app-sidebar.tsx`
     * draws its navigation glyphs by hand ON PURPOSE, so that the menu can
     * carry marks the icon set has no equivalent for, and each one is
     * documented where it is defined.
     */
    expect(offenders).toEqual([]);
  });

  it("gives a reason for every allowed exception", () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(15);
    }
  });
});
