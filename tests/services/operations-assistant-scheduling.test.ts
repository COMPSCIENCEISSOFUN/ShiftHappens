import { describe, expect, it, vi } from "vitest";
import { OperationsAssistantService } from "@/services/operations-assistant.service";

describe("OperationsAssistantService schedule requests", () => {
  it("creates a reviewable draft instead of publishing assignments", async () => {
    const service = new OperationsAssistantService() as unknown as {
      scheduler: { generateSchedule: ReturnType<typeof vi.fn>; confirmSchedule: ReturnType<typeof vi.fn> };
      auditService: { log: ReturnType<typeof vi.fn> };
      execute: OperationsAssistantService["execute"];
    };
    service.scheduler = {
      generateSchedule: vi.fn().mockResolvedValue({
        assignments: [{ taskId: "task-1", taskTitle: "Release", membershipId: "member-1", staffName: "Ari", reasoning: "Available" }],
        unfilledTasks: [],
        summary: { totalTasks: 1, totalAssignments: 1, totalUnfilled: 0, hoursDistribution: [] },
      }),
      confirmSchedule: vi.fn(),
    };
    service.auditService = { log: vi.fn() };

    const result = await service.execute({
      text: "Schedule my team this week",
      organizationId: "org-1",
      userId: "user-1",
      membership: { id: "manager-1", role: "manager", departmentMemberships: [{ department: { id: "dept-1", name: "Engineering" } }] },
    });

    expect(result).toMatchObject({ status: "needs_review", title: "Schedule draft ready" });
    expect(result.actions).toEqual([{ label: "Review schedule", href: "/org/org-1/auto-schedule" }]);
    expect(service.scheduler.confirmSchedule).not.toHaveBeenCalled();
  });
});
