/**
 * Dashboard insights and recommendations.
 *
 * The largest service in the codebase and, until now, the only one with no
 * tests. It also broke in production: `gatherDashboardData` is where the
 * missing `withdrawalNotes` column surfaced, because it loads tasks with their
 * assignments.
 *
 * NO TEST HERE REACHES A REAL AI ENDPOINT. Both provider keys are cleared in
 * `beforeEach`, which drives the algorithmic path; the two tests that exercise
 * the AI path set a key and stub `fetch`. The algorithmic path is the one worth
 * pinning anyway — it is what runs whenever the models are down, and it is
 * deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new AIDashboardService();

const GROQ = process.env.GROQ_API_KEY;
const GEMINI = process.env.GEMINI_API_KEY;

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  vi.restoreAllMocks();
  // No keys → no network. Restored in afterEach so nothing leaks between files.
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  tenant = await createTenant("aid");
});

afterEach(() => {
  if (GROQ === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = GROQ;
  if (GEMINI === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = GEMINI;
});

async function task(
  overrides: Partial<{
    title: string;
    status: string;
    requiredHeadcount: number;
    departmentId: string | null;
  }> = {}
) {
  return prisma.task.create({
    data: {
      title: overrides.title ?? "Evening shift",
      status: overrides.status ?? "open",
      requiredHeadcount: overrides.requiredHeadcount ?? 1,
      departmentId: overrides.departmentId ?? tenant.departmentId,
      organizationId: tenant.orgId,
      createdById: tenant.admin.userId,
    },
  });
}

async function assign(taskId: string, status: string, extra: Record<string, unknown> = {}) {
  return prisma.taskAssignment.create({
    data: {
      taskId,
      membershipId: tenant.staff.membershipId,
      assignedById: tenant.admin.userId,
      status,
      ...extra,
    },
  });
}

describe("An organisation with nothing in it", () => {
  it("recommends getting started rather than analysing zero data", async () => {
    // createTenant makes staff, so drop them to reach the truly-empty branch.
    await prisma.departmentMembership.deleteMany({});
    await prisma.membership.updateMany({
      where: { organizationId: tenant.orgId },
      data: { status: "inactive" },
    });

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].title).toBe("Get started");
    expect(result.footer).toBe("No data to analyze yet");
  });

  it("says the same in the insights view", async () => {
    await prisma.departmentMembership.deleteMany({});
    await prisma.membership.updateMany({
      where: { organizationId: tenant.orgId },
      data: { status: "inactive" },
    });

    const insight = await service.generateInsights(tenant.orgId);

    expect(insight.alerts).toEqual([]);
    expect(insight.summary).toContain("ready");
  });
});

describe("Recommendations without AI", () => {
  it("ranks understaffed tasks first", async () => {
    const t = await task({ title: "Dinner service", requiredHeadcount: 3 });
    await assign(t.id, "accepted");

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations[0].title).toBe("Assign staff to Dinner service");
    expect(result.recommendations[0].priority).toBe(1);
    expect(result.recommendations[0].reasoning).toContain("needs 2 more staff");
  });

  it("does not count a task with nobody on it as understaffed", async () => {
    // Zero assigned is a different problem — "unassigned", handled elsewhere —
    // and the understaffed list requires at least one person already on it.
    await task({ title: "Nobody assigned", requiredHeadcount: 2 });

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations.map((r) => r.title)).not.toContain(
      "Assign staff to Nobody assigned"
    );
  });

  it("suggests fixing availability when rejections cite schedule conflicts", async () => {
    for (let i = 0; i < 2; i++) {
      const t = await task({ title: `Shift ${i}` });
      await assign(t.id, "rejected", { rejectionReason: "schedule_conflict" });
    }

    const result = await service.generateRecommendations(tenant.orgId);
    const availability = result.recommendations.find(
      (r) => r.actionType === "edit_availability"
    );

    expect(availability).toBeDefined();
    expect(availability!.actionUrl).toBe(`/org/${tenant.orgId}/availability`);
  });

  it("only reports a rejection pattern once someone has rejected twice", async () => {
    const t = await task();
    await assign(t.id, "rejected", { rejectionReason: "schedule_conflict" });

    const result = await service.generateRecommendations(tenant.orgId);

    expect(
      result.recommendations.some((r) => r.actionType === "edit_availability")
    ).toBe(false);
  });

  it("flags a department with tasks but no staff", async () => {
    const empty = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    await task({ title: "Bar shift", departmentId: empty.id });

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations.map((r) => r.title)).toContain(
      "Assign staff to Bar"
    );
  });

  it("flags certifications awaiting verification", async () => {
    await prisma.certification.create({
      data: {
        membershipId: tenant.staff.membershipId,
        name: "Food Safety",
        status: "pending",
        issuedDate: new Date(),
      },
    });
    await task();

    const result = await service.generateRecommendations(tenant.orgId);
    const certs = result.recommendations.find((r) => r.actionType === "review_certs");

    expect(certs).toBeDefined();
    expect(certs!.actionUrl).toBe(`/org/${tenant.orgId}/certifications`);
  });

  it("says so when nothing needs attention", async () => {
    const t = await task({ requiredHeadcount: 1 });
    await assign(t.id, "accepted");

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].title).toBe("All looking good");
  });

  it("returns at most five, so the panel cannot grow without bound", async () => {
    for (let i = 0; i < 8; i++) {
      const t = await task({ title: `Shift ${i}`, requiredHeadcount: 3 });
      await assign(t.id, "accepted");
    }
    const empty = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    await task({ title: "Bar shift", departmentId: empty.id });

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations.length).toBeLessThanOrEqual(5);
  });

  it("numbers priorities from one, without gaps", async () => {
    for (let i = 0; i < 2; i++) {
      const t = await task({ title: `Shift ${i}`, requiredHeadcount: 3 });
      await assign(t.id, "accepted");
    }

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations.map((r) => r.priority)).toEqual(
      result.recommendations.map((_, i) => i + 1)
    );
  });

  it("points every recommendation at a URL inside this organisation", async () => {
    const t = await task({ requiredHeadcount: 3 });
    await assign(t.id, "accepted");

    const result = await service.generateRecommendations(tenant.orgId);

    for (const r of result.recommendations) {
      expect(r.actionUrl.startsWith(`/org/${tenant.orgId}/`)).toBe(true);
    }
  });
});

describe("Insights without AI", () => {
  it("warns about tasks with nobody assigned", async () => {
    await task({ title: "Unstaffed" });

    const insight = await service.generateInsights(tenant.orgId);

    expect(insight.alerts.some((a) => a.type === "warning" && a.message.includes("still need staff"))).toBe(true);
  });

  it("reports completed work as a success alert", async () => {
    const t = await task({ status: "completed" });
    await assign(t.id, "completed", { clockOutTime: new Date() });

    const insight = await service.generateInsights(tenant.orgId);

    expect(insight.alerts.some((a) => a.type === "success")).toBe(true);
  });

  it("caps alerts at five", async () => {
    for (let i = 0; i < 10; i++) {
      const t = await task({ title: `Shift ${i}`, requiredHeadcount: 3 });
      await assign(t.id, "accepted");
    }

    const insight = await service.generateInsights(tenant.orgId);

    expect(insight.alerts.length).toBeLessThanOrEqual(5);
  });

  it("summarises the counts in prose", async () => {
    await task();

    const insight = await service.generateInsights(tenant.orgId);

    expect(insight.summary).toContain("1 active task");
    expect(insight.summary).toContain("2 staff");
  });

  it("lists rejection patterns per person", async () => {
    for (let i = 0; i < 2; i++) {
      const t = await task({ title: `Shift ${i}` });
      await assign(t.id, "rejected", { rejectionReason: "feeling_unwell" });
    }

    const insight = await service.generateInsights(tenant.orgId);

    expect(insight.rejectionPatterns).toHaveLength(1);
    expect(insight.rejectionPatterns[0].pattern).toContain("Rejected 2 tasks");
  });
});

describe("Data gathering", () => {
  it("loads tasks with their assignments without erroring", async () => {
    // The regression guard. This is the call that threw
    // "column TaskAssignment.withdrawalNotes does not exist" on the deployed
    // site — any column the schema declares but the database lacks fails here
    // before it fails anywhere a user would see.
    const t = await task();
    await assign(t.id, "accepted");

    await expect(service.generateRecommendations(tenant.orgId)).resolves.toBeDefined();
    await expect(service.generateInsights(tenant.orgId)).resolves.toBeDefined();
  });

  it("counts staff but not the company admin", async () => {
    await task();
    const insight = await service.generateInsights(tenant.orgId);
    // manager + staff; the admin and the deactivated member are excluded.
    expect(insight.summary).toContain("2 staff");
  });

  it("sees nothing belonging to another organisation", async () => {
    const other = await createTenant("oth");
    await prisma.task.create({
      data: {
        title: "Their unstaffed task",
        status: "open",
        organizationId: other.orgId,
        createdById: other.admin.userId,
      },
    });
    await task();

    const insight = await service.generateInsights(tenant.orgId);

    expect(insight.summary).toContain("1 active task");
  });

  it("counts open and in-progress tasks but not completed ones", async () => {
    await task({ status: "open" });
    await task({ status: "in_progress" });
    await task({ status: "completed" });

    const insight = await service.generateInsights(tenant.orgId);

    expect(insight.summary).toContain("2 active tasks");
  });
});

describe("Provider failover", () => {
  it("uses the model's answer when Groq responds", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  recommendations: [
                    {
                      title: "Model suggestion",
                      reasoning: "Because the model said so",
                      actionType: "review_certs",
                    },
                  ],
                }),
              },
            },
          ],
        }),
      })
    );
    await task();

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations[0].title).toBe("Model suggestion");
    expect(result.recommendations[0].actionUrl).toBe(
      `/org/${tenant.orgId}/certifications`
    );
  });

  it("falls back to the algorithmic path when the model returns nonsense", async () => {
    // A hallucinated or truncated payload must not take the dashboard down.
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "not json at all" } }] }),
      })
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await task({ title: "Dinner service", requiredHeadcount: 3 });
    await assign(t.id, "accepted");

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations[0].title).toBe("Assign staff to Dinner service");
  });

  it("falls back when the provider itself fails", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await task();

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("rejects an action type the model invented", async () => {
    // The model is free to return anything; the URL it drives must not be.
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  recommendations: [
                    { title: "Odd one", reasoning: "", actionType: "delete_everything" },
                  ],
                }),
              },
            },
          ],
        }),
      })
    );
    await task();

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations[0].actionType).toBe("view_tasks");
    expect(result.recommendations[0].actionUrl).toBe(`/org/${tenant.orgId}/tasks`);
  });

  it("caps the model at five recommendations too", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  recommendations: Array.from({ length: 12 }, (_, i) => ({
                    title: `Suggestion ${i}`,
                    reasoning: "",
                    actionType: "view_tasks",
                  })),
                }),
              },
            },
          ],
        }),
      })
    );
    await task();

    const result = await service.generateRecommendations(tenant.orgId);

    expect(result.recommendations).toHaveLength(5);
  });

  it("makes no network call at all when neither key is set", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await task();

    await service.generateRecommendations(tenant.orgId);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
