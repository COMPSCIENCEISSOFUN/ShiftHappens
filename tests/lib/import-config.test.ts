/**
 * Tests for the CSV import column-header aliases.
 *
 * Two aliases were ambiguous, and both broke an entirely ordinary spreadsheet:
 *
 *   - `role` claimed `"type"`. An HR export with a **Type** column meaning
 *     employment type mapped to job role, and every row failed with
 *     `Unknown role: "Full-time"`.
 *   - `employmentType` claimed `"status"`. An export with a **Status** column
 *     meaning active/inactive mapped to employment type, and every row failed
 *     with `Unknown type: "Active"`.
 *
 * Both are unrecoverable from inside the app: the preview screen lets you edit
 * cell VALUES but not the column mapping, so the only fix was to go and rename
 * headings in the spreadsheet.
 *
 * These are unit tests — the alias tables are pure data with no I/O, and they
 * had no coverage at all despite the CSV import service being well tested.
 */
import { describe, it, expect } from "vitest";
import { HEADER_ALIASES } from "@/lib/import-config";

/** Which field, if any, claims a given spreadsheet heading. */
function fieldFor(heading: string): string[] {
  const needle = heading.trim().toLowerCase();
  return Object.entries(HEADER_ALIASES)
    .filter(([, aliases]) => (aliases as string[]).includes(needle))
    .map(([field]) => field);
}

describe("HEADER_ALIASES — the two ambiguous headings", () => {
  it('"Status" is no longer read as employment type', () => {
    // In an HR export this means active/inactive, not casual/full-time.
    expect(fieldFor("Status")).not.toContain("employmentType");
  });

  it('"Type" is no longer read as job role', () => {
    expect(fieldFor("Type")).not.toContain("role");
  });

  it('"Type" is read as employment type, which is what it usually means', () => {
    expect(fieldFor("Type")).toEqual(["employmentType"]);
  });

  it('"Employment Status" is accepted, since it is unambiguous', () => {
    // Removing "status" should not cost the reading of it that IS clear.
    expect(fieldFor("Employment Status")).toEqual(["employmentType"]);
  });
});

describe("HEADER_ALIASES — no heading maps to two fields", () => {
  it("every alias is claimed by exactly one field", () => {
    // The general property behind both bugs. A heading claimed twice resolves
    // by whichever field is checked first, which is an ordering accident rather
    // than a decision.
    const seen = new Map<string, string>();
    const collisions: string[] = [];

    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      for (const alias of aliases as string[]) {
        const existing = seen.get(alias);
        if (existing) collisions.push(`"${alias}" claimed by ${existing} and ${field}`);
        else seen.set(alias, field);
      }
    }

    expect(collisions).toEqual([]);
  });

  it("aliases are all lowercase, so matching is case-insensitive in practice", () => {
    for (const aliases of Object.values(HEADER_ALIASES)) {
      for (const alias of aliases as string[]) {
        expect(alias).toBe(alias.toLowerCase());
      }
    }
  });

  it("no alias has stray whitespace", () => {
    for (const aliases of Object.values(HEADER_ALIASES)) {
      for (const alias of aliases as string[]) {
        expect(alias).toBe(alias.trim());
      }
    }
  });
});

describe("HEADER_ALIASES — the ordinary headings still work", () => {
  it.each([
    ["Name", "name"],
    ["Full Name", "name"],
    ["Email", "email"],
    ["Email Address", "email"],
    ["Role", "role"],
    ["Position", "role"],
    ["Department", "department"],
    ["Dept", "department"],
    ["Employment Type", "employmentType"],
  ])("%s maps to %s", (heading, field) => {
    expect(fieldFor(heading)).toContain(field);
  });

  it("an unrecognised heading maps to nothing rather than guessing", () => {
    expect(fieldFor("Payroll Number")).toEqual([]);
  });
});
