import { describe, expect, it } from "vitest";
import { createProjectSchema, createTaskSchema } from "@/lib/validations";

describe("project validation", () => {
  it("accepts a multi-day project timeframe", () => {
    const result = createProjectSchema.safeParse({
      title: "Atlas API release",
      departmentId: "department-1",
      plannedStart: "2026-08-10T09:00:00.000Z",
      plannedEnd: "2026-08-14T17:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  it("allows a linked task to carry its project id", () => {
    const result = createTaskSchema.safeParse({
      title: "Complete integration tests",
      projectId: "project-1",
      scheduledStart: "2026-08-11T09:00:00.000Z",
      scheduledEnd: "2026-08-12T17:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });
});
