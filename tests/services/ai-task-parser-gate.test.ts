// @vitest-environment node
/**
 * What the parser says it could not work out.
 *
 * ## Why this decides everything downstream
 *
 * `missing` is what makes an AI request create a shift unattended instead of
 * opening a form. Get it too eager and the product is a slower way to type a
 * task; get it too lax and a request that never said WHEN becomes a shift the
 * automation then ignores forever, because eligibility needs a window and the
 * hourly sweep skips undated work.
 *
 * ## Why priority and headcount are never in it
 *
 * The prompt gives both a default — "default = medium", "if headcount not
 * specified, default to 1". A returned value is therefore indistinguishable
 * from a filled-in blank, so gating on them would open the form on almost every
 * request. The last test pins that, because it is the rule most likely to be
 * "improved" by somebody adding a field they can see is unset.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AITaskParserService } from "@/services/ai-task-parser.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const parser = new AITaskParserService();

let tenant: Tenant;

/**
 * Drive the AI branch with a reply we control.
 *
 * The service tries Groq, then Gemini, then keywords. Stubbing fetch and
 * setting a key is what makes "the model returned no date" reachable without a
 * provider — and the keyword path is exercised separately by simply not setting
 * one.
 */
function mockModel(json: Record<string, unknown>) {
  vi.stubEnv("GROQ_API_KEY", "test-key-not-a-real-one");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(json) } }],
      }),
    })
  );
}

const COMPLETE = {
  title: "Prep the kitchen",
  description: "Morning prep",
  priority: "medium",
  requiredHeadcount: 2,
  scheduledStart: "2026-08-20T07:00:00+08:00",
  scheduledEnd: "2026-08-20T12:00:00+08:00",
};

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("gate");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a request that says everything", () => {
  it("reports nothing missing, so it can be created unattended", async () => {
    mockModel({ ...COMPLETE, departmentName: "Kitchen" });

    const parsed = await parser.parseTaskDescription(
      "2 kitchen staff for prep on Thursday morning",
      tenant.orgId
    );

    expect(parsed.missing).toEqual([]);
    expect(parsed.parsedBy).toBe("ai");
  });
});

describe("a request that leaves something out", () => {
  it("flags a schedule the model could not work out", async () => {
    mockModel({ ...COMPLETE, scheduledStart: null, scheduledEnd: null });

    const parsed = await parser.parseTaskDescription(
      "someone for prep at some point",
      tenant.orgId
    );

    expect(parsed.missing).toContain("schedule");
  });

  /*
   * Half a window is no window. Eligibility asks whether somebody is free
   * BETWEEN two times, so a start with no end cannot be staffed any more than
   * neither can — and treating it as answered would create a shift the engine
   * silently skips.
   */
  it("flags a schedule with only one end", async () => {
    mockModel({ ...COMPLETE, scheduledEnd: null });

    const parsed = await parser.parseTaskDescription(
      "prep from 7am",
      tenant.orgId
    );

    expect(parsed.missing).toContain("schedule");
  });

  it("flags a title the model did not produce", async () => {
    mockModel({ ...COMPLETE, title: "" });

    const parsed = await parser.parseTaskDescription("....", tenant.orgId);

    expect(parsed.missing).toContain("title");
  });
});

describe("the department question", () => {
  /*
   * The count that matters is what the CALLER may create in, not what the
   * organisation has. A manager who runs one department has a single possible
   * answer, and asking them to choose is a question with one option.
   */
  it("is not asked when the caller has only one department", async () => {
    mockModel({ ...COMPLETE, departmentName: null });

    const parsed = await parser.parseTaskDescription(
      "prep on Thursday morning",
      tenant.orgId,
      [tenant.departmentId]
    );

    expect(parsed.missing).not.toContain("department");
  });

  it("is asked when the caller has several and the request named none", async () => {
    const second = await prisma.department.create({
      data: { name: `Bar ${tenant.orgSlug}`, organizationId: tenant.orgId },
    });
    mockModel({ ...COMPLETE, departmentName: null });

    const parsed = await parser.parseTaskDescription(
      "prep on Thursday morning",
      tenant.orgId,
      [tenant.departmentId, second.id]
    );

    expect(parsed.missing).toContain("department");
  });

  it("is not asked when the request named one", async () => {
    const second = await prisma.department.create({
      data: { name: `Bar ${tenant.orgSlug}`, organizationId: tenant.orgId },
    });
    mockModel({ ...COMPLETE, departmentName: `Bar ${tenant.orgSlug}` });

    const parsed = await parser.parseTaskDescription(
      "bar cover Thursday morning",
      tenant.orgId,
      [tenant.departmentId, second.id]
    );

    expect(parsed.missing).not.toContain("department");
    expect(parsed.departmentId).toBe(second.id);
  });
});

describe("when no provider is reachable", () => {
  /*
   * The keyword parser drops anything it was not written to recognise, so
   * callers treat `parsedBy: "keywords"` as needing review whatever `missing`
   * says. `missing` is still computed, because this path is also taken for
   * very short input, which is not a degraded parse — it is a request that
   * genuinely said almost nothing.
   */
  it("says so, and still reports what it could not fill in", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");

    const parsed = await parser.parseTaskDescription(
      "do the thing at some point",
      tenant.orgId
    );

    expect(parsed.parsedBy).toBe("keywords");
    expect(parsed.missing).toContain("schedule");
  });
});

describe("fields that are never asked about", () => {
  it("does not treat a defaulted priority or headcount as missing", async () => {
    // Exactly what the model returns when the request mentioned neither.
    mockModel({
      ...COMPLETE,
      departmentName: "Kitchen",
      priority: "medium",
      requiredHeadcount: 1,
    });

    const parsed = await parser.parseTaskDescription(
      "prep on Thursday morning",
      tenant.orgId
    );

    expect(parsed.missing).toEqual([]);
    expect(parsed.priority).toBe("medium");
    expect(parsed.requiredHeadcount).toBe(1);
  });
});
