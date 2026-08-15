/**
 * A screen formats dates in the READER's language; the server picks one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/** Any `toLocale*String("xx-YY"` — a locale written as a literal. */
const LITERAL_LOCALE = /toLocale(?:Date|Time)?String\(\s*["'][a-z]{2}-[A-Z]{2}["']/;

function filesUnder(dir: string, ext: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, ext));
    else if (ext.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const ALL = filesUnder(SRC, [".ts", ".tsx"]);

/**
 * Shared modules with no directive of their own that are nonetheless rendered
 * in a browser.
 *
 * The first version of this scan had no such list and got a file wrong within
 * the hour. `"use client"` marks an ENTRY POINT; a lib imported only by client
 * pages carries no directive and was therefore classified as server-side, so
 * four labels people read on screen were pinned to one locale. The
 * `schedule-week` tests caught it by changing shape — a locale-formatted string
 * is a shape, which is the other half of the lesson below.
 *
 * A named list rather than an import graph. Following imports would be more
 * correct and considerably more machinery, and the list is short enough that
 * an entry is a decision somebody made rather than a fact somebody inferred.
 * If it grows past a handful, build the graph.
 */
const CLIENT_RENDERED_LIBS = [join("src", "lib", "schedule-week.ts")];

/*
 * A file is "on screen" if React will run it in the browser. `"use client"` is
 * the marker for an entry point; the directory tells you nothing, since
 * `src/components` is a mix of both, and neither tells you anything about a
 * shared lib — hence the list above.
 */
function isClientFile(path: string): boolean {
  if (CLIENT_RENDERED_LIBS.some((lib) => path.endsWith(lib))) return true;
  return /^\s*["']use client["']/m.test(readFileSync(path, "utf8"));
}

describe("dates on screen", () => {
  it("never hard-code a locale", () => {
    const offenders = ALL.filter(isClientFile).filter((f) =>
      LITERAL_LOCALE.test(readFileSync(f, "utf8"))
    );

    expect(
      offenders,
      "a screen formats dates in the reader's own language — pass [] rather than a locale string, and see SERVER_LOCALE in lib/timezone for the other half of the rule"
    ).toEqual([]);
  });
});

describe("dates off screen", () => {
  /*
   * Server files may hard-code, but only the shared constant. Written as "no
   * literal outside a client file" rather than "every server file imports
   * SERVER_LOCALE", because most of them format no dates at all and requiring
   * an unused import is a rule nobody would keep.
   */
  it("use the one shared locale, not a literal", () => {
    const offenders = ALL.filter((f) => !isClientFile(f))
      .filter((f) => f !== join(SRC, "lib", "timezone.ts"))
      .filter((f) => {
        const source = readFileSync(f, "utf8");
        // Comments describe these calls in a couple of places; only real calls
        // count. Strip block comments before looking.
        return LITERAL_LOCALE.test(source.replace(/\/\*[\s\S]*?\*\//g, ""));
      });

    expect(
      offenders,
      "server-side output picks one locale for everybody — import SERVER_LOCALE from lib/timezone"
    ).toEqual([]);
  });

  /*
   * The canary. Both assertions above pass trivially if the walk finds
   * nothing, and this file walks a tree by hand — a renamed folder would turn
   * it green and silent. Asserting that it can see a file known to contain a
   * locale reference proves the scan is looking.
   */
  it("can see the files it is scanning", () => {
    expect(ALL.length).toBeGreaterThan(100);
    expect(ALL.filter(isClientFile).length).toBeGreaterThan(20);
    expect(readFileSync(join(SRC, "lib", "timezone.ts"), "utf8")).toContain(
      "SERVER_LOCALE"
    );
  });

  /*
   * And that the exception list points at something real. A renamed or deleted
   * entry would silently stop exempting anything, and the file it names would
   * drift back under the server rule with nothing reporting it.
   */
  it("names only libs that exist", () => {
    for (const lib of CLIENT_RENDERED_LIBS) {
      expect(ALL.some((f) => f.endsWith(lib)), `${lib} is not in src`).toBe(true);
    }
  });
});
