/**
 * Tests for industry template configuration and industry-selection mapping.
 *
 * The selection helpers exist because of a real defect: the settings page
 * classified the stored industry against an option list that had not loaded
 * yet, so a saved "Hospitality / F&B" rendered as "Other" on every reload
 * while the database held the correct value. Moving the decision into a pure
 * function is what makes that decision testable at all — the page itself has
 * no test harness.
 */
import { describe, it, expect } from "vitest";
import {
  INDUSTRY_TEMPLATES,
  CUSTOM_TEMPLATE_ID,
  OTHER_INDUSTRY,
  getTemplateById,
  resolveIndustrySelection,
  industryFromSelection,
} from "@/lib/industry-templates";

const OPTIONS = ["Hospitality / F&B", "Retail", "Healthcare"];

describe("OTHER_INDUSTRY sentinel", () => {
  it("cannot collide with a template name", () => {
    // Platform admins can name templates freely. If the sentinel were the bare
    // string "other", a template called "Other" would submit an empty industry
    // and silently clear the field.
    const names = INDUSTRY_TEMPLATES.map((t) => t.name.toLowerCase());
    expect(names).not.toContain(OTHER_INDUSTRY);
    expect(OTHER_INDUSTRY).not.toBe("other");
  });

  it("is distinct from the custom-template id", () => {
    expect(OTHER_INDUSTRY).not.toBe(CUSTOM_TEMPLATE_ID);
  });
});

describe("resolveIndustrySelection", () => {
  it("selects a known option directly and leaves the free-text field empty", () => {
    expect(resolveIndustrySelection("Hospitality / F&B", OPTIONS)).toEqual({
      select: "Hospitality / F&B",
      custom: "",
    });
  });

  it("falls back to Other for a value not in the list", () => {
    expect(resolveIndustrySelection("Marine Salvage", OPTIONS)).toEqual({
      select: OTHER_INDUSTRY,
      custom: "Marine Salvage",
    });
  });

  it("treats an unset industry as 'Not specified'", () => {
    for (const empty of [null, undefined, "", "   "]) {
      expect(resolveIndustrySelection(empty, OPTIONS)).toEqual({
        select: "",
        custom: "",
      });
    }
  });

  /**
   * The regression this whole module exists for. Before the fix the settings
   * page called the equivalent of this line with an empty array, because the
   * option list was still in flight — so a value chosen from the dropdown came
   * back as Other.
   */
  it("classifies a known industry as Other when the option list is empty", () => {
    expect(resolveIndustrySelection("Hospitality / F&B", [])).toEqual({
      select: OTHER_INDUSTRY,
      custom: "Hospitality / F&B",
    });
  });

  it("preserves the value even when the option list fails to load", () => {
    // Degraded, but not lossy: the string survives and re-saves identically.
    const degraded = resolveIndustrySelection("Hospitality / F&B", []);
    expect(industryFromSelection(degraded.select, degraded.custom)).toBe(
      "Hospitality / F&B"
    );
  });

  it("trims surrounding whitespace before matching", () => {
    expect(resolveIndustrySelection("  Retail  ", OPTIONS)).toEqual({
      select: "Retail",
      custom: "",
    });
  });

  it("matches exactly — a different case is not the same option", () => {
    // Values are written from the option list, so an exact match is correct.
    // Loosening this would let "retail" masquerade as the "Retail" template.
    expect(resolveIndustrySelection("retail", OPTIONS).select).toBe(
      OTHER_INDUSTRY
    );
  });

  it("handles a single-entry and a large option list", () => {
    expect(resolveIndustrySelection("Retail", ["Retail"]).select).toBe("Retail");

    const many = Array.from({ length: 100 }, (_, i) => `Industry ${i}`);
    expect(resolveIndustrySelection("Industry 99", many).select).toBe(
      "Industry 99"
    );
    expect(resolveIndustrySelection("Industry 100", many).select).toBe(
      OTHER_INDUSTRY
    );
  });
});

describe("industryFromSelection", () => {
  it("submits the selected option as-is", () => {
    expect(industryFromSelection("Retail", "")).toBe("Retail");
  });

  it("submits the free-text value when Other is selected", () => {
    expect(industryFromSelection(OTHER_INDUSTRY, "  Marine Salvage  ")).toBe(
      "Marine Salvage"
    );
  });

  it("submits an empty string for 'Not specified' so the API clears the field", () => {
    // Not null and not undefined: the service reads "" as an explicit clear,
    // and Prisma ignores undefined rather than nulling the column.
    expect(industryFromSelection("", "")).toBe("");
  });

  it("submits an empty string when Other is selected but nothing was typed", () => {
    expect(industryFromSelection(OTHER_INDUSTRY, "   ")).toBe("");
  });

  it("ignores stale free text when a real option is selected", () => {
    // The page clears the custom field on change, but the helper must not
    // depend on that having happened.
    expect(industryFromSelection("Retail", "Marine Salvage")).toBe("Retail");
  });
});

describe("industry selection round-trips", () => {
  it("returns the same pair after a save-and-reload cycle", () => {
    const cases = ["Hospitality / F&B", "Retail", "Marine Salvage", ""];

    for (const stored of cases) {
      const shown = resolveIndustrySelection(stored, OPTIONS);
      const submitted = industryFromSelection(shown.select, shown.custom);
      expect(submitted).toBe(stored);
      expect(resolveIndustrySelection(submitted, OPTIONS)).toEqual(shown);
    }
  });

  it("round-trips a value the user typed that happens to match an option", () => {
    // Typed under Other, but on reload it is a known option — so the control
    // legitimately changes shape while the stored value does not.
    const submitted = industryFromSelection(OTHER_INDUSTRY, "Retail");
    expect(submitted).toBe("Retail");
    expect(resolveIndustrySelection(submitted, OPTIONS)).toEqual({
      select: "Retail",
      custom: "",
    });
  });
});

describe("INDUSTRY_TEMPLATES", () => {
  it("has unique ids and names", () => {
    const ids = INDUSTRY_TEMPLATES.map((t) => t.id);
    const names = INDUSTRY_TEMPLATES.map((t) => t.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every template at least one department", () => {
    for (const template of INDUSTRY_TEMPLATES) {
      expect(template.departments.length).toBeGreaterThan(0);
    }
  });

  it("looks templates up by id and returns undefined for unknown ids", () => {
    expect(getTemplateById(INDUSTRY_TEMPLATES[0].id)?.name).toBe(
      INDUSTRY_TEMPLATES[0].name
    );
    expect(getTemplateById("no-such-template")).toBeUndefined();
    expect(getTemplateById(CUSTOM_TEMPLATE_ID)).toBeUndefined();
  });
});
