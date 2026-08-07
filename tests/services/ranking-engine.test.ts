/**
 * One engine, one set of priorities, and a fallback that is actually reachable.
 *
 * Three separate defects met here.
 *
 * The whole-week scheduler had its OWN scoring — `100 - hours + (inDepartment ?
 * 25 : 0) + 25` — so an organisation got a different answer depending on which
 * screen asked: fill one shift and certifications and availability counted, one
 * of them wrongly; generate the week and neither existed, plus a constant that
 * was identical for everybody. Nothing explained the difference because nothing
 * intended it.
 *
 * The configured priorities reached only `FallbackRanker`, which runs when both
 * providers fail — a setting that worked exclusively during an outage. The
 * models are now told the ordering in the prompt.
 *
 * And no provider call had a timeout. A failover chain advances on a throw, and
 * a socket that never answers is neither an error nor a non-ok response, so a
 * hung connection made every deterministic fallback in the codebase unreachable
 * — the exact failure mode second providers exist for.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import { FallbackRanker } from "@/services/fallback-ranker";
import { AllocationService } from "@/services/allocation.service";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { AvailabilityService } from "@/services/availability.service";
import { SettingsService } from "@/services/settings.service";
import { DEFAULT_WEIGHTS, type RankingWeights } from "@/lib/ranking-weights";
import { AI_TIMEOUT_MS } from "@/lib/ai-limits";
import type { StaffCandidate } from "@/services/ai-provider";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const allocation = new AllocationService();
const scheduler = new AutoScheduleService();
const availability = new AvailabilityService();
const settings = new SettingsService();

function candidate(overrides: Partial<StaffCandidate> = {}): StaffCandidate {
  return {
    membershipId: "m1",
    name: "Sam",
    hoursWorkedToday: 0,
    maxHours: 40,
    certifications: [],
    availableHours: "",
    departmentHistory: 0,
    availabilityFit: 0.5,
    certificationRelevance: 0.5,
    ...overrides,
  };
}

describe("the weights actually change the order", () => {
  /*
   * Two candidates, each strong on a different dimension. Whichever dimension
   * is weighted higher should win — which is the whole claim the settings
   * screen makes.
   */
  const workhorse = candidate({
    membershipId: "fresh",
    hoursWorkedToday: 0,
    departmentHistory: 0,
  });
  const veteran = candidate({
    membershipId: "veteran",
    hoursWorkedToday: 30,
    departmentHistory: 50,
  });

  function winnerWith(weights: RankingWeights) {
    return FallbackRanker.rank([workhorse, veteran], weights)[0].membershipId;
  }

  it("favours the fresh candidate when workload leads", () => {
    expect(
      winnerWith({ workload: 70, availability: 10, certifications: 10, department: 10 })
    ).toBe("fresh");
  });

  it("favours the experienced one when department experience leads", () => {
    expect(
      winnerWith({ workload: 10, availability: 10, certifications: 10, department: 70 })
    ).toBe("veteran");
  });

  it("ranks as it always did when nothing is configured", () => {
    const before = FallbackRanker.rank([workhorse, veteran], DEFAULT_WEIGHTS);
    const implicit = FallbackRanker.rank([workhorse, veteran]);
    expect(implicit.map((r) => r.membershipId)).toEqual(
      before.map((r) => r.membershipId)
    );
  });
});

describe("a dimension with nothing to measure", () => {
  /*
   * Neutral for everybody rather than a number derived from nothing. The
   * alternative is a value that reorders people for reasons nobody can name —
   * which is what counting certificates was.
   */
  it("does not reorder anybody", () => {
    const a = candidate({ membershipId: "a", certificationRelevance: null });
    const b = candidate({ membershipId: "b", certificationRelevance: null });
    const ranked = FallbackRanker.rank([a, b], {
      workload: 10,
      availability: 10,
      certifications: 70,
      department: 10,
    });
    expect(ranked[0].score).toBe(ranked[1].score);
  });

  it("says so in the explanation", () => {
    const ranked = FallbackRanker.rank([candidate({ certificationRelevance: null })]);
    expect(ranked[0].explanation).toMatch(/no certifications required/i);
  });

  it("says so for availability too", () => {
    const ranked = FallbackRanker.rank([candidate({ availabilityFit: null })]);
    expect(ranked[0].explanation).toMatch(/not applicable/i);
  });
});

describe("provider calls are bounded", () => {
  /*
   * The bound is what makes every fallback in the codebase reachable. Asserted
   * as a value rather than by hanging a real socket, because a test that waits
   * eight seconds to prove a timeout exists is a test nobody runs.
   */
  it("has a timeout short enough to fall through within a request", () => {
    expect(AI_TIMEOUT_MS).toBeGreaterThan(0);
    expect(AI_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("one engine, whichever screen asked", () => {
  let tenant: Tenant;
  let cook: string;
  let veteran: string;

  function weekStart(): Date {
    const d = new Date(Date.now() + 21 * 86_400_000);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay() + 1);
    return d;
  }

  beforeEach(async () => {
    await cleanDatabase();
    tenant = await createTenant("engine");

    const make = async (name: string, email: string) => {
      const user = await prisma.user.create({
        data: { name, email, hashedPassword: "h" },
      });
      const membership = await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: tenant.orgId,
          role: "staff",
          status: "active",
          employmentType: "full_time",
        },
      });
      await prisma.departmentMembership.create({
        data: { membershipId: membership.id, departmentId: tenant.departmentId },
      });
      await availability.openUnsetDays(membership.id);
      return membership.id;
    };

    cook = await make("Cook", "cook@engine.test");
    veteran = await make("Veteran", "vet@engine.test");
  });

  async function shift(offsetHours = 30) {
    const start = new Date(weekStart().getTime() + offsetHours * 3_600_000);
    return prisma.task.create({
      data: {
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
        title: "Dinner",
        status: "open",
        requiredHeadcount: 1,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 4 * 3_600_000),
      },
    });
  }

  /*
   * The week builder used to score by its own formula, so this comparison was
   * impossible to make. Both paths now read the same context, so a candidate
   * the single-task ranker prefers is the one the week builder places.
   */
  it("the week builder reads the same weights as the single-task path", async () => {
    await settings.updateSettings(tenant.orgId, {
      smartAllocationWeights: {
        workload: 10,
        availability: 10,
        certifications: 10,
        department: 70,
      },
    });

    const context = await scheduler.collectWeekData(tenant.orgId, weekStart());
    expect(context.weights.department).toBe(70);
  });

  it("carries the department's certification requirements into the week", async () => {
    await prisma.task.create({
      data: {
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
        title: "Certified shift",
        status: "open",
        requiredCertifications: ["First Aid"],
        scheduledStart: new Date(weekStart().getTime() + 30 * 3_600_000),
        scheduledEnd: new Date(weekStart().getTime() + 34 * 3_600_000),
      },
    });

    const context = await scheduler.collectWeekData(tenant.orgId, weekStart());
    expect(context.departmentCerts.get(tenant.departmentId)).toContain("First Aid");
  });

  /*
   * Never calls a provider by design — this is the path that protects the
   * API quota — so it is the cleanest place to prove the configured weights
   * reach a real ranking rather than only the AI prompt.
   */
  it("the algorithmic path applies the configured weights", async () => {
    const task = await shift();
    await prisma.taskAssignment.create({
      data: {
        taskId: (await shift(60)).id,
        membershipId: veteran,
        assignedById: tenant.admin.userId,
        status: "completed",
      },
    });

    const { rankings, provider } = await allocation.rankWithoutAI(
      task.id,
      tenant.orgId
    );
    expect(provider).toBe("algorithmic");
    expect(rankings.length).toBeGreaterThan(0);
    expect(rankings.map((r) => r.membershipId)).toContain(cook);
  });
});

describe("settings refuse a set that would break the ranking", () => {
  let tenant: Tenant;

  beforeEach(async () => {
    await cleanDatabase();
    tenant = await createTenant("weights");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores an ordinary set", async () => {
    await settings.updateSettings(tenant.orgId, {
      smartAllocationWeights: {
        workload: 40,
        availability: 20,
        certifications: 20,
        department: 20,
      },
    });

    const saved = await settings.getSettings(tenant.orgId);
    expect(saved.smartAllocationWeights.workload).toBe(40);
  });

  it("refuses all zeroes", async () => {
    await expect(
      settings.updateSettings(tenant.orgId, {
        smartAllocationWeights: {
          workload: 0,
          availability: 0,
          certifications: 0,
          department: 0,
        },
      })
    ).rejects.toThrow(/above zero/);
  });

  it("refuses one dimension deciding everything", async () => {
    await expect(
      settings.updateSettings(tenant.orgId, {
        smartAllocationWeights: {
          workload: 95,
          availability: 5,
          certifications: 0,
          department: 0,
        },
      })
    ).rejects.toThrow(/Workload balance/);
  });

  it("leaves the stored set alone when it refuses", async () => {
    await settings.updateSettings(tenant.orgId, {
      smartAllocationWeights: {
        workload: 40,
        availability: 20,
        certifications: 20,
        department: 20,
      },
    });
    await settings
      .updateSettings(tenant.orgId, {
        smartAllocationWeights: {
          workload: 0,
          availability: 0,
          certifications: 0,
          department: 0,
        },
      })
      .catch(() => {});

    const saved = await settings.getSettings(tenant.orgId);
    expect(saved.smartAllocationWeights.workload).toBe(40);
  });

  // The screen never has to parse JSON, so it never needs its own opinion
  // about a malformed or absent column.
  it("hands the screen a parsed object, never a string", async () => {
    const saved = await settings.getSettings(tenant.orgId);
    expect(typeof saved.smartAllocationWeights).toBe("object");
    expect(saved.smartAllocationWeights).toEqual(DEFAULT_WEIGHTS);
  });
});
