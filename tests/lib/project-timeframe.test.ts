import { describe, expect, it } from "vitest";
import { projectTimeframeError } from "@/lib/project-timeframe";

describe("project timeframe", () => {
  it("accepts a multi-day timeframe", () => {
    expect(projectTimeframeError("2026-08-10T09:00:00.000Z", "2026-08-14T17:00:00.000Z")).toBeNull();
  });

  it("requires both bounds when a project is scheduled", () => {
    expect(projectTimeframeError("2026-08-10T09:00:00.000Z", null)).toBe("A project needs both a start and end date, or neither");
  });

  it("rejects an end before the start", () => {
    expect(projectTimeframeError("2026-08-14T17:00:00.000Z", "2026-08-10T09:00:00.000Z")).toBe("Project end must be after its start");
  });
});
