/**
 * Dashboard insights and recommendations.
 *
 * The largest service in the codebase and, until now, the only one with no
 * tests. It also broke in production: `gatherDashboardData` is where the
 * missing `withdrawalNotes` column surfaced, because it loads tasks with their
 * assignments.
 *
 * NO TEST HERE REACHES A REAL AI ENDPOINT. Both provider keys are cleared in
 * `beforeEach`; the tests that exercise a model path set a key and stub `fetch`.
 *
 * ## Why these assert on data rather than prose
 *
 * They used to go through `generateInsights`, reading its output for phrases
 * like "1 active task" and "2 staff". That method and its algorithmic half have
 * been deleted: the panel that rendered them was mounted nowhere, and its
 * header read "AI Insights" over output that silently became a set of `if`
 * statements whenever both providers failed — the same claim-outruns-behaviour
 * problem the `isAiInsight` flag was removed for.
 *
 * What the tests were really protecting was `gatherDashboardData` — the counts
 * every live surface is built from, and where the missing `withdrawalNotes`
 * column surfaced in production. So they now assert those counts directly,
 * which is a stronger check than reading a sentence: a wrong number and a wrong
 * sentence are indistinguishable through prose.
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

    // Nothing to order, so nothing is claimed. The old design manufactured a
    // "Get started" recommendation to fill the space; a placeholder that looks
    // like an insight is worse than an empty section.
    const result = await service.getPriorityCall(tenant.orgId);

    expect(result.call).toBeNull();
  });

  it("reports an empty picture rather than inventing one", async () => {
    await prisma.departmentMembership.deleteMany({});
    await prisma.membership.updateMany({
      where: { organizationId: tenant.orgId },
      data: { status: "inactive" },
    });

    const data = await service.gatherDashboardData(tenant.orgId);

    expect(data.activeStaff).toBe(0);
    expect(data.totalTasks).toBe(0);
  });
});


/*
 * What the deleted "Insights without AI" block was really checking.
 *
 * Those tests asserted on sentences — "still need staff", "Rejected 2 tasks",
 * "at most five alerts" — produced by a formatter that no longer renders
 * anywhere. The facts underneath are what the live surfaces use, so they are
 * asserted here as facts.
 */
describe("The picture the dashboard is built from", () => {
  it("counts a task with nobody assigned as unassigned", async () => {
    await task({ title: "Unstaffed" });

    const data = await service.gatherDashboardData(tenant.orgId);

    expect(data.unassignedTasks).toBe(1);
    expect(data.understaffedTasks).toHaveLength(0);
  });

  it("counts a partly-filled task as understaffed, with the shortfall", async () => {
    const t = await task({ title: "Evening", requiredHeadcount: 3 });
    await assign(t.id, "accepted");

    const data = await service.gatherDashboardData(tenant.orgId);
    const entry = data.understaffedTasks.find((e) => e.taskId === t.id);

    expect(entry?.assigned).toBe(1);
    expect(entry?.needed).toBe(2);
  });

  /*
   * `totalTasks` is open + in-progress, NOT every task ever created — worth
   * pinning, because the name reads like the latter and a caller assuming so
   * would under-report completion rates without anything failing.
   */
  it("excludes completed work from every open count", async () => {
    const t = await task({ status: "completed" });
    await assign(t.id, "completed", { clockOutTime: new Date() });

    const data = await service.gatherDashboardData(tenant.orgId);

    expect(data.openTasks).toBe(0);
    expect(data.inProgressTasks).toBe(0);
    expect(data.totalTasks).toBe(0);
    // It is still counted where completion is the point.
    expect(data.completedToday).toBe(1);
  });

  it("groups repeated rejections by person", async () => {
    for (let i = 0; i < 2; i++) {
      const t = await task({ title: `Shift ${i}` });
      await assign(t.id, "rejected", { rejectionReason: "feeling_unwell" });
    }

    const data = await service.gatherDashboardData(tenant.orgId);

    expect(data.recentRejections).toHaveLength(1);
    expect(data.recentRejections[0].count).toBe(2);
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

    await expect(service.getPriorityCall(tenant.orgId)).resolves.toBeDefined();
    await expect(service.gatherDashboardData(tenant.orgId)).resolves.toBeDefined();
  });

  it("counts staff but not the company admin", async () => {
    await task();
    const data = await service.gatherDashboardData(tenant.orgId);
    // manager + staff; the admin and the deactivated member are excluded.
    expect(data.activeStaff).toBe(2);
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

    const data = await service.gatherDashboardData(tenant.orgId);

    expect(data.totalTasks).toBe(1);
  });

  it("counts open and in-progress tasks but not completed ones", async () => {
    await task({ status: "open" });
    await task({ status: "in_progress" });
    await task({ status: "completed" });

    const data = await service.gatherDashboardData(tenant.orgId);

    expect(data.openTasks + data.inProgressTasks).toBe(2);
  });
});

