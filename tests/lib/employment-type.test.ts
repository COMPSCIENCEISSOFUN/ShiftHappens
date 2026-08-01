import { describe, expect, it } from "vitest";
import {
  EMPLOYMENT_TYPE_KEYS,
  EMPLOYMENT_TYPE_LABELS,
  normalizeEmploymentType,
  requiresManagedAvailability,
} from "@/lib/role-config";
import { EMPLOYMENT_ALIASES } from "@/lib/import-config";

describe("canonical employment types", () => {
  it("exposes only the two approved employment types", () => {
    expect(EMPLOYMENT_TYPE_KEYS).toEqual(["casual", "temporary_part_time"]);
    expect(EMPLOYMENT_TYPE_LABELS).toEqual({
      casual: "Casual",
      temporary_part_time: "Temporary or Part-Time",
    });
  });

  it("maps legacy full_time values to casual", () => {
    expect(normalizeEmploymentType("full_time")).toBe("casual");
    expect(normalizeEmploymentType(null)).toBe("casual");
  });

  it("requires managed availability only for temporary or part-time staff", () => {
    expect(requiresManagedAvailability("temporary_part_time")).toBe(true);
    expect(requiresManagedAvailability("casual")).toBe(false);
    expect(requiresManagedAvailability("full_time")).toBe(false);
  });

  it("normalizes import aliases to canonical values", () => {
    expect(EMPLOYMENT_ALIASES["part-time"]).toBe("temporary_part_time");
    expect(EMPLOYMENT_ALIASES.temporary).toBe("temporary_part_time");
    expect(EMPLOYMENT_ALIASES.full_time).toBe("casual");
  });
});
