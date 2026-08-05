import { describe, expect, it } from "vitest";
import { settingsImpactSummary } from "@/lib/settings-impact";

describe("settings impact summary", () => {
  it("names every operational group affected by a settings change", () => {
    expect(settingsImpactSummary({ activeStaff: 12, openTasks: 4, scheduledAssignments: 9 }))
      .toBe("This change can affect 12 active staff, 4 open tasks, and 9 scheduled assignments.");
  });
});
