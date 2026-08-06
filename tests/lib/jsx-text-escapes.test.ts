/**
 * `—` written as JSX text renders the six characters, not an em dash.
 *
 * Inside a JavaScript expression — `{cond ? label : "—"}` — the escape is
 * part of a string literal and resolves. As JSX TEXT — `<span>—</span>` —
 * it is not a string literal at all, and React prints it verbatim. The two
 * spellings sit one line apart in a table cell and look identical in review.
 *
 * That is exactly how it shipped: the Members table showed a real em dash under
 * TYPE and a literal `—` under SENIORITY, on the same row, and it took a
 * screenshot from Darryn to spot it. The lesson is not "be careful" — it is that
 * the character should be typed directly, since a real dash cannot be written
 * one way that works and one that does not.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...tsxFiles(path));
    else if (entry.endsWith(".tsx")) found.push(path);
  }
  return found;
}

describe("unicode escapes in JSX", () => {
  it("finds none written as text rather than as a string", () => {
    const offenders: string[] = [];

    for (const file of tsxFiles(join(process.cwd(), "src"))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // `>\uXXXX` or `\uXXXX<` — an escape sequence directly adjacent to a
          // tag boundary, which is only possible in text position. An escape
          // inside quotes is fine and common, so this does not match it.
          if (/>\s*\\u[0-9a-fA-F]{4}|\\u[0-9a-fA-F]{4}\s*</.test(line)) {
            offenders.push(`${file.replace(process.cwd(), "")}:${i + 1}`);
          }
        });
    }

    // If this fails, type the character itself instead of escaping it.
    expect(offenders).toEqual([]);
  });
});
