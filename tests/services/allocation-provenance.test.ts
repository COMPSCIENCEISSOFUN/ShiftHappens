/**
 * Allocation provenance — the write path.
 *
 * The reporting tests read these columns; nothing until now proved anything
 * writes them. That gap is the dangerous kind: the charts would render, the
 * numbers would be plausible, and every assignment would sit in the
 * "unrecorded" bucket forever without a single test failing.
 *
 * The other property pinned here is that an uninstrumented caller records
 * NOTHING rather than defaulting to "manual". A default would mean every future
 * assignment path silently claims a human made the decision.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskService } from "@/services/task.service";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { ALLOCATION_SOURCES, isAllocationSource } from "@/lib/allocation-provenance";

const taskService = new TaskService();
const autoSchedule = new AutoScheduleService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("prov");
});

async function makeTask(headcount = 2) {
  return prisma.task.create({
    data: {
      title: "Evening shift",
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: headcount,
    },
  });
}

function stored(taskId: string, membershipId: string) {
  return prisma.taskAssignment.findFirstOrThrow({
    where: { taskId, membershipId },
    select: {
      allocationSource: true,
      allocationProvider: true,
      allocationRank: true,
      allocationScore: true,
    },
  });
}

describe("assignStaff without provenance", () => {
  it("records nothing rather than assuming a human decided", async () => {
    // Every assignment path that has not been instrumented lands here. A
    // default of "manual" would quietly overstate human involvement for all of
    // them, and the overstatement would be invisible.
    const task = await makeTask(1);

    await taskService.assignStaff(
      task.id,
      tenant.orgId,
      [tenant.staff.membershipId],
      tenant.admin.userId
    );

    expect(await stored(task.id, tenant.staff.membershipId)).toEqual({
      allocationSource: null,
      allocationProvider: null,
      allocationRank: null,
      allocationScore: null,
    });
  });
});

describe("assignStaff with provenance", () => {
  it("writes the source, provider, rank and score", async () => {
    const task = await makeTask(1);

    await taskService.assignStaff(
      task.id,
      tenant.orgId,
      [tenant.staff.membershipId],
      tenant.admin.userId,
      {
        source: "ai_suggested",
        provider: "groq",
        byMembership: { [tenant.staff.membershipId]: { rank: 1, score: 92.5 } },
      }
    );

    expect(await stored(task.id, tenant.staff.membershipId)).toEqual({
      allocationSource: "ai_suggested",
      allocationProvider: "groq",
      allocationRank: 1,
      allocationScore: 92.5,
    });
  });

  it("gives each member their own rank rather than the first one's", async () => {
    // byMembership is keyed, not positional, precisely because assignStaff can
    // reject a membership mid-loop — a parallel array would go off by one and
    // attach the wrong score to the wrong person, which no chart would reveal.
    const task = await makeTask(2);

    await taskService.assignStaff(
      task.id,
      tenant.orgId,
      [tenant.staff.membershipId, tenant.manager.membershipId],
      tenant.admin.userId,
      {
        source: "ai_suggested",
        provider: "groq",
        byMembership: {
          [tenant.staff.membershipId]: { rank: 1, score: 90 },
          [tenant.manager.membershipId]: { rank: 2, score: 71 },
        },
      }
    );

    expect(await stored(task.id, tenant.staff.membershipId)).toMatchObject({
      allocationRank: 1,
      allocationScore: 90,
    });
    expect(await stored(task.id, tenant.manager.membershipId)).toMatchObject({
      allocationRank: 2,
      allocationScore: 71,
    });
  });

  it("records the source even when the engine had no score for someone", async () => {
    const task = await makeTask(1);

    await taskService.assignStaff(
      task.id,
      tenant.orgId,
      [tenant.staff.membershipId],
      tenant.admin.userId,
      { source: "auto_scheduled", provider: "algorithmic" }
    );

    expect(await stored(task.id, tenant.staff.membershipId)).toEqual({
      allocationSource: "auto_scheduled",
      allocationProvider: "algorithmic",
      allocationRank: null,
      allocationScore: null,
    });
  });

  it("puts the source in the audit trail too", async () => {
    const task = await makeTask(1);

    await taskService.assignStaff(
      task.id,
      tenant.orgId,
      [tenant.staff.membershipId],
      tenant.admin.userId,
      { source: "ai_suggested", provider: "gemini" }
    );

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: tenant.orgId, action: "task.assigned" },
    });
    expect(log.details).toMatchObject({
      allocationSource: "ai_suggested",
      allocationProvider: "gemini",
    });
  });
});

describe("confirmSchedule", () => {
  async function draft(taskId: string) {
    return [
      {
        taskId,
        taskTitle: "Evening shift",
        membershipId: tenant.staff.membershipId,
        staffName: "Staff",
        reasoning: "department match",
      },
    ];
  }

  it("marks confirmed rows as auto-scheduled", async () => {
    // Trustworthy regardless of what the client sends: reaching this method
    // means the auto-schedule confirm endpoint ran.
    const task = await makeTask(1);

    await autoSchedule.confirmSchedule(
      tenant.orgId,
      await draft(task.id),
      tenant.admin.userId,
      "groq"
    );

    expect(await stored(task.id, tenant.staff.membershipId)).toMatchObject({
      allocationSource: "auto_scheduled",
      allocationProvider: "groq",
    });
  });

  it("drops a provider name it does not recognise", async () => {
    // The provider is echoed back by the client, so it is a claim. Validating
    // it against the known set means the worst a caller can do is substitute
    // one real strategy for another — not inject arbitrary text into a chart.
    const task = await makeTask(1);

    await autoSchedule.confirmSchedule(
      tenant.orgId,
      await draft(task.id),
      tenant.admin.userId,
      "definitely-a-real-ai"
    );

    expect(await stored(task.id, tenant.staff.membershipId)).toMatchObject({
      allocationSource: "auto_scheduled",
      allocationProvider: null,
    });
  });

  it("still records the source when no provider is sent at all", async () => {
    const task = await makeTask(1);

    await autoSchedule.confirmSchedule(
      tenant.orgId,
      await draft(task.id),
      tenant.admin.userId
    );

    expect(await stored(task.id, tenant.staff.membershipId)).toMatchObject({
      allocationSource: "auto_scheduled",
      allocationProvider: null,
    });
  });
});

describe("the source vocabulary", () => {
  it("accepts every documented source", () => {
    for (const source of ALLOCATION_SOURCES) {
      expect(isAllocationSource(source)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isAllocationSource("ai")).toBe(false);
    expect(isAllocationSource("")).toBe(false);
  });
});
