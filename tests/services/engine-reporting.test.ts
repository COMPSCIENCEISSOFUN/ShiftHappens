/**
 * Smart-engine reporting.
 *
 * These aggregates are the evidence behind claims made on the Engine Insights
 * page, so the tests are mostly about honesty rather than arithmetic: that an
 * assignment with no recorded provenance is never counted as a human decision,
 * that percentages are null rather than zero when there is nothing to divide,
 * and that a manager's department scope is respected — a scoped manager must
 * not learn the whole organisation's allocation mix from a chart endpoint.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ReportingService } from "@/services/reporting.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const reporting = new ReportingService();

let tenant: Tenant;
let other: Tenant;
let secondDept: string;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("eng");
  other = await createTenant("oth");

  const dept = await prisma.department.create({
    data: { name: "Front of house", organizationId: tenant.orgId, color: "#3B82F6" },
  });
  secondDept = dept.id;
});

async function task(departmentId: string | null = tenant.departmentId, orgId = tenant.orgId) {
  return prisma.task.create({
    data: {
      title: "Shift",
      organizationId: orgId,
      departmentId,
      createdById:
        orgId === tenant.orgId ? tenant.admin.userId : other.admin.userId,
    },
  });
}

async function assignment(opts: {
  departmentId?: string | null;
  source?: string;
  provider?: string;
  rank?: number;
  score?: number;
  status?: string;
  createdAt?: Date;
  orgId?: string;
  membershipId?: string;
}) {
  const orgId = opts.orgId ?? tenant.orgId;
  const t = await task(
    opts.departmentId === undefined ? tenant.departmentId : opts.departmentId,
    orgId
  );

  return prisma.taskAssignment.create({
    data: {
      taskId: t.id,
      membershipId:
        opts.membershipId ??
        (orgId === tenant.orgId ? tenant.staff.membershipId : other.staff.membershipId),
      assignedById:
        orgId === tenant.orgId ? tenant.admin.userId : other.admin.userId,
      status: opts.status ?? "accepted",
      allocationSource: opts.source,
      allocationProvider: opts.provider,
      allocationRank: opts.rank,
      allocationScore: opts.score,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

/* ------------------------------------------------------------------ */

describe("getAllocationEngineStats — sources", () => {
  it("counts each source separately", async () => {
    await assignment({ source: "manual" });
    await assignment({ source: "manual" });
    await assignment({ source: "ai_suggested", rank: 1, score: 90 });
    await assignment({ source: "auto_scheduled", rank: 1, score: 70 });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);

    expect(stats.sourceCounts).toEqual({
      manual: 2,
      ai_suggested: 1,
      auto_scheduled: 1,
    });
  });

  it("never files an unrecorded assignment as manual", async () => {
    // The load-bearing one. Every assignment made before provenance existed
    // has a NULL source; counting those as manual would claim a person made a
    // decision nobody recorded, and would inflate the human share for free.
    await assignment({});
    await assignment({ source: "manual" });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);

    expect(stats.unrecorded).toBe(1);
    expect(stats.sourceCounts.manual).toBe(1);
  });

  it("reports the total including unrecorded rows", async () => {
    await assignment({});
    await assignment({ source: "manual" });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.totalAssignments).toBe(2);
  });

  it("counts only engine-made rows as engine assignments", async () => {
    await assignment({ source: "manual" });
    await assignment({});
    await assignment({ source: "ai_suggested", rank: 1, score: 80 });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.engineAssignments).toBe(1);
  });
});

describe("getAllocationEngineStats — providers", () => {
  it("splits engine assignments by strategy", async () => {
    await assignment({ source: "ai_suggested", provider: "groq", rank: 1 });
    await assignment({ source: "ai_suggested", provider: "groq", rank: 2 });
    await assignment({ source: "auto_scheduled", provider: "algorithmic", rank: 1 });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.providerCounts).toEqual({ groq: 2, algorithmic: 1 });
  });

  it("excludes manual assignments from the provider split", async () => {
    // A manual pick has no strategy. Left in, it would arrive as a null bucket
    // and usually dominate the chart the panel exists to show.
    await assignment({ source: "manual" });
    await assignment({ source: "ai_suggested", provider: "groq", rank: 1 });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.providerCounts).toEqual({ groq: 1 });
  });

  it("keeps an engine row with no provider distinct from the algorithmic ranker", async () => {
    // "We did not capture which strategy ran" and "the algorithmic ranker ran"
    // are different facts. Merging them would let a silent instrumentation gap
    // read as a deliberate fallback.
    await assignment({ source: "auto_scheduled", rank: 1 });
    await assignment({ source: "ai_suggested", provider: "algorithmic", rank: 1 });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.providerCounts).toEqual({ unrecorded: 1, algorithmic: 1 });
  });
});

describe("getAllocationEngineStats — did the top pick hold up", () => {
  it("counts a rejected top pick as not retained", async () => {
    await assignment({ source: "ai_suggested", rank: 1, status: "accepted" });
    await assignment({ source: "ai_suggested", rank: 1, status: "rejected" });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);

    expect(stats.topPick).toMatchObject({ total: 2, retained: 1, percentage: 50 });
  });

  it("treats a withdrawal as falling through, like a rejection", async () => {
    await assignment({ source: "ai_suggested", rank: 1, status: "withdrawn" });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.topPick.retained).toBe(0);
  });

  it("counts a completed shift as retained", async () => {
    await assignment({ source: "ai_suggested", rank: 1, status: "completed" });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.topPick).toMatchObject({ total: 1, retained: 1, percentage: 100 });
  });

  it("separates lower-ranked picks from the top pick", async () => {
    // The two figures only mean something side by side — a retention rate for
    // rank 1 with nothing to compare against says nothing about ranking.
    await assignment({ source: "ai_suggested", rank: 1, status: "accepted" });
    await assignment({ source: "ai_suggested", rank: 3, status: "rejected" });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);

    expect(stats.topPick).toMatchObject({ total: 1, retained: 1 });
    expect(stats.otherPicks).toMatchObject({ total: 1, retained: 0, percentage: 0 });
  });

  it("reports null rather than 0% when nothing was ranked", async () => {
    // 0% reads as "the engine got everything wrong". Null renders as an em dash.
    await assignment({ source: "manual" });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.topPick.percentage).toBeNull();
    expect(stats.otherPicks.percentage).toBeNull();
  });

  it("ignores engine rows with no rank when splitting top from lower", async () => {
    await assignment({ source: "auto_scheduled", status: "accepted" });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.topPick.total).toBe(0);
    expect(stats.otherPicks.total).toBe(0);
    expect(stats.engineAssignments).toBe(1);
  });

  it("averages the scores it has, and reports null when it has none", async () => {
    await assignment({ source: "ai_suggested", rank: 1, score: 90 });
    await assignment({ source: "ai_suggested", rank: 2, score: 70 });
    await assignment({ source: "ai_suggested", rank: 3 });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.averageScore).toBe(80);

    await cleanDatabase();
    tenant = await createTenant("eng2");
    await assignment({ source: "manual" });
    const empty = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(empty.averageScore).toBeNull();
  });
});

describe("getAllocationEngineStats — scoping", () => {
  it("counts nothing from another organisation", async () => {
    await assignment({ source: "manual", orgId: other.orgId, departmentId: null });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId);
    expect(stats.totalAssignments).toBe(0);
  });

  it("honours a manager's department scope", async () => {
    await assignment({ source: "manual", departmentId: tenant.departmentId });
    await assignment({ source: "ai_suggested", rank: 1, departmentId: secondDept });

    const scoped = await reporting.getAllocationEngineStats(tenant.orgId, 30, [
      tenant.departmentId,
    ]);

    expect(scoped.totalAssignments).toBe(1);
    expect(scoped.sourceCounts).toEqual({ manual: 1 });
  });

  it("an unscoped call still sees everything", async () => {
    await assignment({ source: "manual", departmentId: tenant.departmentId });
    await assignment({ source: "manual", departmentId: secondDept });

    const all = await reporting.getAllocationEngineStats(tenant.orgId, 30, null);
    expect(all.totalAssignments).toBe(2);
  });

  it("excludes assignments older than the window", async () => {
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await assignment({ source: "manual", createdAt: longAgo });
    await assignment({ source: "manual" });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId, 30);
    expect(stats.totalAssignments).toBe(1);
  });

  it("a wider window reaches further back", async () => {
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await assignment({ source: "manual", createdAt: longAgo });

    const stats = await reporting.getAllocationEngineStats(tenant.orgId, 90);
    expect(stats.totalAssignments).toBe(1);
    expect(stats.windowDays).toBe(90);
  });
});

/* ------------------------------------------------------------------ */

describe("getEligibilityEngineStats", () => {
  async function override(rule: string, createdAt?: Date) {
    const t = await task();
    return prisma.eligibilityOverride.create({
      data: {
        taskId: t.id,
        membershipId: tenant.staff.membershipId,
        overriddenById: tenant.admin.userId,
        ruleOverridden: rule,
        reason: "Short-staffed",
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }

  it("groups overrides by the rule that was bypassed", async () => {
    await override("hours_limit");
    await override("hours_limit");
    await override("certification");

    const stats = await reporting.getEligibilityEngineStats(tenant.orgId);
    expect(stats.ruleCounts).toEqual({ hours_limit: 2, certification: 1 });
  });

  it("reports the override rate against assignments in the same window", async () => {
    await assignment({ source: "manual" });
    await assignment({ source: "manual" });
    await assignment({ source: "manual" });
    await assignment({ source: "manual" });
    await override("hours_limit");

    const stats = await reporting.getEligibilityEngineStats(tenant.orgId);
    expect(stats.totalOverrides).toBe(1);
    expect(stats.totalAssignments).toBe(4);
    expect(stats.overrideRate).toBe(25);
  });

  it("reports null rather than 0% when there were no assignments", async () => {
    const stats = await reporting.getEligibilityEngineStats(tenant.orgId);
    expect(stats.overrideRate).toBeNull();
  });

  it("distinguishes no overrides from no data", async () => {
    // Both render as an empty bar list, but the panel says different things:
    // "every assignment passed on its own" versus "nothing happened here".
    await assignment({ source: "manual" });

    const stats = await reporting.getEligibilityEngineStats(tenant.orgId);
    expect(stats.totalOverrides).toBe(0);
    expect(stats.totalAssignments).toBe(1);
    expect(stats.ruleCounts).toEqual({});
  });

  it("excludes overrides older than the window", async () => {
    await override("hours_limit", new Date(Date.now() - 60 * 24 * 60 * 60 * 1000));
    await override("availability");

    const stats = await reporting.getEligibilityEngineStats(tenant.orgId, 30);
    expect(stats.totalOverrides).toBe(1);
  });

  it("honours a manager's department scope", async () => {
    const outside = await prisma.task.create({
      data: {
        title: "Elsewhere",
        organizationId: tenant.orgId,
        departmentId: secondDept,
        createdById: tenant.admin.userId,
      },
    });
    await prisma.eligibilityOverride.create({
      data: {
        taskId: outside.id,
        membershipId: tenant.staff.membershipId,
        overriddenById: tenant.admin.userId,
        ruleOverridden: "availability",
        reason: "Cover",
      },
    });
    await override("hours_limit");

    const scoped = await reporting.getEligibilityEngineStats(tenant.orgId, 30, [
      tenant.departmentId,
    ]);
    expect(scoped.ruleCounts).toEqual({ hours_limit: 1 });
  });

  it("counts nothing from another organisation", async () => {
    const foreign = await task(null, other.orgId);
    await prisma.eligibilityOverride.create({
      data: {
        taskId: foreign.id,
        membershipId: other.staff.membershipId,
        overriddenById: other.admin.userId,
        ruleOverridden: "hours_limit",
        reason: "Theirs",
      },
    });

    const stats = await reporting.getEligibilityEngineStats(tenant.orgId);
    expect(stats.totalOverrides).toBe(0);
  });
});
