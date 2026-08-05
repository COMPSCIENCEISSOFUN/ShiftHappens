/**
 * Deriving a role's stored `name` from the label somebody typed.
 *
 * The create form used to ask for both, annotating the second "Used in code.
 * Lowercase, no spaces." Nothing read it, the format was never validated, and
 * `updateRoleSchema` had no `name` so it could never be changed — a permanent,
 * unenforced identifier for a purpose that did not exist.
 *
 * These are pure-function tests: no database, no fixtures. The service tests
 * cover what happens when a derived name meets real rows.
 */
import { describe, it, expect } from "vitest";
import { slugifyRoleName, uniqueRoleName } from "@/lib/role-slug";

describe("slugifyRoleName", () => {
  it("lowercases and joins words with underscores", () => {
    expect(slugifyRoleName("Shift Lead")).toBe("shift_lead");
  });

  it("collapses punctuation rather than keeping it", () => {
    expect(slugifyRoleName("Front-of-House Supervisor")).toBe(
      "front_of_house_supervisor"
    );
  });

  it("collapses a run of separators into one underscore", () => {
    expect(slugifyRoleName("Shift   —   Lead")).toBe("shift_lead");
  });

  it("trims separators from both ends", () => {
    expect(slugifyRoleName("  Shift Lead!  ")).toBe("shift_lead");
  });

  it("keeps digits, which roles legitimately use", () => {
    expect(slugifyRoleName("Tier 2 Support")).toBe("tier_2_support");
  });

  // "Café" must not become "caf". Normalising to NFKD splits the accent into a
  // combining mark, which is then stripped rather than turned into a separator.
  it("folds accents to their base letter", () => {
    expect(slugifyRoleName("Café Manager")).toBe("cafe_manager");
  });

  /*
   * Empty, not a substitute.
   *
   * A label with nothing usable in it has no honest slug, and inventing one
   * would store a name unrelated to what the user typed — the exact class of
   * surprise this change removes. Validation refuses such a label before the
   * service is reached; this is the second line.
   */
  it("returns empty for a label with nothing usable in it", () => {
    expect(slugifyRoleName("!!!")).toBe("");
    expect(slugifyRoleName("   ")).toBe("");
    expect(slugifyRoleName("🎉")).toBe("");
  });
});

describe("uniqueRoleName", () => {
  it("uses the plain slug when nothing has taken it", () => {
    expect(uniqueRoleName("Shift Lead", [])).toBe("shift_lead");
  });

  /*
   * Two DIFFERENT labels can slug identically — "Shift Lead" and "shift lead"
   * are distinct to the label uniqueness check but the same string here. The
   * database index is on the slug, so this step is not redundant with it.
   */
  it("suffixes when the slug is already taken", () => {
    expect(uniqueRoleName("Shift Lead", ["shift_lead"])).toBe("shift_lead_2");
  });

  it("keeps counting past the first collision", () => {
    expect(
      uniqueRoleName("Shift Lead", ["shift_lead", "shift_lead_2"])
    ).toBe("shift_lead_3");
  });

  // Deterministic, not random: the same input against the same data gives the
  // same answer, so a retried request cannot produce a second differently-named
  // role.
  it("is deterministic", () => {
    const taken = ["shift_lead"];
    expect(uniqueRoleName("Shift Lead", taken)).toBe(
      uniqueRoleName("Shift Lead", taken)
    );
  });

  /*
   * The system role names are reserved even when no row is holding them.
   *
   * A custom role stored as `manager` would not break authorisation — nothing
   * reads the string, every check uses `isSystemRole` — but it would sit beside
   * the real Manager role in audit entries and in the profile payload, and
   * telling them apart afterwards is work for no benefit.
   */
  it("avoids the system role names", () => {
    expect(uniqueRoleName("Manager", [])).toBe("manager_2");
    expect(uniqueRoleName("Staff", [])).toBe("staff_2");
    expect(uniqueRoleName("Company Admin", [])).toBe("company_admin_2");
  });

  it("returns empty when the label has no usable characters", () => {
    expect(uniqueRoleName("!!!", [])).toBe("");
  });
});
