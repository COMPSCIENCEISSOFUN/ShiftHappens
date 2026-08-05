/**
 * The priority call — the smart engine's only contribution to the action list.
 *
 * ## What this replaced
 *
 * The dashboard computed deterministic alerts, then handed the same data to a
 * model asking for "3-5 recommendations". Having nothing to add, it restated
 * the alerts — and where it volunteered a figure it sometimes got it wrong,
 * printing "Only 2/3 staff are assigned" beneath an alert reading "0/3".
 *
 * The model now orders rather than enumerates. Most of what follows pins the
 * things it must NOT be able to do: invent an id, smuggle a number back in, or
 * put words in a row it did not write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new AIDashboardService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("prio");
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

/** Understaffed shifts are the alerts that carry an entityId to pick from. */
async function understaffedTask(title: string) {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const t = await prisma.task.create({
    data: {
      title,
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: 3,
      status: "open",
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 4 * 60 * 60 * 1000),
    },
  });
  await prisma.taskAssignment.create({
    data: {
      taskId: t.id,
      membershipId: tenant.staff.membershipId,
      assignedById: tenant.admin.userId,
      status: "accepted",
    },
  });
  return t;
}

function mockModel(reply: unknown) {
  process.env.GROQ_API_KEY = "test-key";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: typeof reply === "string" ? reply : JSON.stringify(reply),
            },
          },
        ],
      }),
    })
  );
}

describe("when there is nothing to prioritise", () => {
  it("returns no call for an empty organisation", async () => {
    const result = await service.getPriorityCall(tenant.orgId);
    expect(result.call).toBeNull();
  });

  // One thing to do is not a prioritisation problem, and dressing it up as one
  // would be the placeholder this design exists to avoid.
  //
  // An expiring certificate, not a shift: an understaffed shift can raise TWO
  // alerts that both carry its id — understaffed and unfillable — so it never
  // exercises the single-candidate guard. The first version of this test used
  // one and passed with the guard deleted.
  it("returns no call for a single alert", async () => {
    const cert = await prisma.certification.create({
      data: {
        membershipId: tenant.staff.membershipId,
        name: "First Aid",
        status: "verified",
        issuedDate: new Date("2026-01-01"),
        expiryDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      },
    });
    mockModel({ entityId: cert.id, why: "It lapses soonest" });

    const result = await service.getPriorityCall(tenant.orgId);
    expect(result.call).toBeNull();
  });

  // No fabricated fallback. The previous design produced "algorithmic
  // recommendations" that were restatements of the alerts beside them.
  it("returns no call when no model is configured", async () => {
    await understaffedTask("Shift A");
    await understaffedTask("Shift B");

    const result = await service.getPriorityCall(tenant.orgId);
    expect(result.call).toBeNull();
  });
});

describe("choosing", () => {
  it("returns the chosen alert with our message, not the model's", async () => {
    const a = await understaffedTask("Lunch Service");
    await understaffedTask("Bar Setup");
    mockModel({
      entityId: a.id,
      // The model's own description of the row is discarded — only the id and
      // the justification are read.
      why: "It is tomorrow and hardest to fix late",
      message: "Lunch Service is completely unstaffed",
    });

    const result = await service.getPriorityCall(tenant.orgId);

    expect(result.call?.entityId).toBe(a.id);
    expect(result.call?.message).toContain("Lunch Service");
    // Ours, not the model's. A task can carry more than one alert — an
    // understaffed one and an unfillable one — so the exact wording is not
    // asserted; what matters is that it came from the alert list rather than
    // from the reply.
    expect(result.call?.message).not.toBe("Lunch Service is completely unstaffed");
    expect(result.call?.reason).toBe("It is tomorrow and hardest to fix late");
    expect(result.call?.provider).toBe("groq");
  });

  // A hallucinated id is the one failure that would put the wrong row at the
  // top of a manager's morning.
  it("discards a pick the model invented", async () => {
    await understaffedTask("Shift A");
    await understaffedTask("Shift B");
    mockModel({ entityId: "not-a-real-id", why: "Looks urgent" });

    const result = await service.getPriorityCall(tenant.orgId);
    expect(result.call).toBeNull();
  });

  it("survives a reply that is not JSON at all", async () => {
    await understaffedTask("Shift A");
    await understaffedTask("Shift B");
    mockModel("I think you should look at the lunch service first!");

    const result = await service.getPriorityCall(tenant.orgId);
    expect(result.call).toBeNull();
  });

  it("reads a reply the model wrapped in a code fence", async () => {
    const a = await understaffedTask("Shift A");
    await understaffedTask("Shift B");
    mockModel(
      '```json\n{"entityId":"' + a.id + '","why":"Soonest and hardest to fill"}\n```'
    );

    const result = await service.getPriorityCall(tenant.orgId);
    expect(result.call?.entityId).toBe(a.id);
  });
});

describe("the reason is held to a standard the row above it already meets", () => {
  /**
   * The bug that caused this whole redesign. Every figure on the panel is
   * computed from the database; a figure the model repeats is either the same
   * one or a different one, and a different one is a contradiction printed
   * directly beneath the truth.
   */
  it("drops a reason containing a figure, keeping the pick", async () => {
    const a = await understaffedTask("Shift A");
    await understaffedTask("Shift B");
    mockModel({ entityId: a.id, why: "Only 2 of 3 staff are assigned" });

    const result = await service.getPriorityCall(tenant.orgId);

    // The ordering was the contribution and it survives; the claim does not.
    expect(result.call?.entityId).toBe(a.id);
    expect(result.call?.reason).toBeNull();
  });

  it("drops an empty reason", async () => {
    const a = await understaffedTask("Shift A");
    await understaffedTask("Shift B");
    mockModel({ entityId: a.id, why: "   " });

    const result = await service.getPriorityCall(tenant.orgId);
    expect(result.call?.reason).toBeNull();
  });

  it("drops a reason that runs to a paragraph", async () => {
    const a = await understaffedTask("Shift A");
    await understaffedTask("Shift B");
    mockModel({ entityId: a.id, why: "Because ".repeat(60) });

    const result = await service.getPriorityCall(tenant.orgId);
    expect(result.call?.reason).toBeNull();
  });

  it("keeps a plain qualitative reason", async () => {
    const a = await understaffedTask("Shift A");
    await understaffedTask("Shift B");
    mockModel({
      entityId: a.id,
      why: "It starts soonest and the others can still be filled afterwards",
    });

    const result = await service.getPriorityCall(tenant.orgId);
    expect(result.call?.reason).toContain("starts soonest");
  });
});

describe("scoping", () => {
  it("never picks an alert outside the caller's departments", async () => {
    const other = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    const outside = await prisma.task.create({
      data: {
        title: "Bar shift",
        organizationId: tenant.orgId,
        departmentId: other.id,
        createdById: tenant.admin.userId,
        requiredHeadcount: 3,
        status: "open",
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: outside.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });
    await understaffedTask("Kitchen A");
    await understaffedTask("Kitchen B");

    // The model names the out-of-scope shift; it was never in the list it was
    // shown, so it cannot be resolved.
    mockModel({ entityId: outside.id, why: "Looks worst" });

    const result = await service.getPriorityCall(tenant.orgId, [tenant.departmentId]);
    expect(result.call).toBeNull();
  });
});
