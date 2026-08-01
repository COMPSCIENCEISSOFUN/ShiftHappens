// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, jsonReq } from "../helpers/route";

const { confirmSchedule, findByUserAndOrg } = vi.hoisted(() => ({
  confirmSchedule: vi.fn(),
  findByUserAndOrg: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({
  getAuthenticatedUser: vi.fn().mockResolvedValue({ id: "admin-user" }),
  unauthorizedResponse: vi.fn(),
  checkOrgSuspended: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/repositories/membership.repository", () => ({
  MembershipRepository: class {
    findByUserAndOrg = findByUserAndOrg;
  },
}));

vi.mock("@/services/auto-schedule.service", () => ({
  AutoScheduleService: class {
    confirmSchedule = confirmSchedule;
  },
}));

import { POST } from "@/app/api/organizations/[orgId]/auto-schedule/confirm/route";

describe("POST auto-schedule confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByUserAndOrg.mockResolvedValue({
      role: "company_admin",
      departmentMemberships: [],
    });
    confirmSchedule.mockResolvedValue({ created: 1, failed: 0 });
  });

  it("rejects client display and AI fields before confirmation", async () => {
    const response = await POST(
      jsonReq("POST", {
        assignments: [
          {
            taskId: "task-1",
            membershipId: "member-1",
            taskTitle: "Tampered title",
            staffName: "Tampered name",
            reasoning: "Tampered AI reason",
            score: 999,
          },
        ],
      }),
      ctx({ orgId: "org-1" })
    );

    expect(response.status).toBe(400);
    expect(confirmSchedule).not.toHaveBeenCalled();
  });

  it("passes only validated identifiers and server-derived scope", async () => {
    const assignments = [{ taskId: "task-1", membershipId: "member-1" }];
    const response = await POST(
      jsonReq("POST", { assignments }),
      ctx({ orgId: "org-1" })
    );

    expect(response.status).toBe(200);
    expect(confirmSchedule).toHaveBeenCalledWith(
      "org-1",
      assignments,
      "admin-user",
      null
    );
  });
});
