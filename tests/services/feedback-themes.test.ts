/**
 * Feedback themes — reading the free text staff wrote.
 *
 * This is the one model surface in the product that is not restating a query.
 * Everything else counts; a model handed a count can only repeat it or get it
 * wrong. Prose is different: no GROUP BY notices that six decline notes
 * describe the same closing shift.
 *
 * The tests below are mostly about what the model is NOT allowed to do — cite
 * a line that does not exist, put its own words inside quotation marks, smuggle
 * a figure into a theme label, or call one comment a pattern.
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
  tenant = await createTenant("themes");
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

/**
 * A worked shift carrying a satisfaction comment.
 *
 * Ordering matters to these tests — the service sorts newest first and the
 * model cites line numbers — so each row is stamped a fixed distance apart
 * rather than all at once.
 */
async function ratedShift(
  comment: string,
  opts: { rating?: number; minutesAgo?: number; departmentId?: string } = {}
) {
  const task = await prisma.task.create({
    data: {
      title: "Evening Service",
      organizationId: tenant.orgId,
      departmentId: opts.departmentId ?? tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: 1,
      status: "completed",
    },
  });
  return prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: tenant.staff.membershipId,
      assignedById: tenant.admin.userId,
      status: "completed",
      satisfactionRating: opts.rating ?? 3,
      satisfactionComment: comment,
      ratedAt: new Date(Date.now() - (opts.minutesAgo ?? 10) * 60 * 1000),
    },
  });
}

async function declinedShift(notes: string, reason = "schedule_conflict") {
  const task = await prisma.task.create({
    data: {
      title: "Late Close",
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: 1,
      status: "open",
    },
  });
  return prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: tenant.staff.membershipId,
      assignedById: tenant.admin.userId,
      status: "rejected",
      rejectionReason: reason,
      rejectionNotes: notes,
      rejectedAt: new Date(),
    },
  });
}

/** Six comments — one over the minimum, so a test can remove one and cross it. */
async function enoughComments() {
  for (let i = 0; i < 6; i++) {
    await ratedShift(`Comment number ${String.fromCharCode(97 + i)}`, {
      minutesAgo: 60 - i,
    });
  }
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

describe("when there is not enough to read", () => {
  it("returns nothing for an organisation with no comments", async () => {
    mockModel({ themes: [{ theme: "Something", lines: [1, 2] }] });

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.themes).toEqual([]);
    expect(result.basedOn).toBe(0);
    expect(result.provider).toBeNull();
  });

  /**
   * The gate that matters most. A model asked for themes in four comments will
   * find three — it has no way to answer "there is not enough here", so the
   * service has to answer it first.
   */
  it("does not call the model below the minimum", async () => {
    for (let i = 0; i < 4; i++) {
      await ratedShift(`Only four of these ${i}`, { minutesAgo: 30 - i });
    }
    mockModel({ themes: [{ theme: "A confident pattern", lines: [1, 2] }] });

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.themes).toEqual([]);
    expect(result.basedOn).toBe(4);
    expect(fetch).not.toHaveBeenCalled();
  });

  // Blank is not feedback. `not: null` in the query cannot express this, and an
  // empty numbered line is one the model may still try to group.
  it("ignores comments that are only whitespace", async () => {
    await enoughComments();
    await ratedShift("   ", { minutesAgo: 5 });
    mockModel({ themes: [] });

    const result = await service.getFeedbackThemes(tenant.orgId);
    expect(result.basedOn).toBe(6);
  });

  // No fabricated fallback: nothing but a model can read prose, so there is
  // nothing to fall back TO.
  it("returns nothing when no model is configured", async () => {
    await enoughComments();

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.themes).toEqual([]);
    expect(result.basedOn).toBe(6);
    expect(result.provider).toBeNull();
  });
});

describe("reading all three sources of text", () => {
  it("reads decline notes alongside shift comments", async () => {
    await ratedShift("Fine shift", { minutesAgo: 20 });
    await ratedShift("Also fine", { minutesAgo: 19 });
    await declinedShift("Cannot do the late close, no transport home");
    await declinedShift("Late close again — nothing runs after midnight");
    await declinedShift("Same problem with getting home");
    mockModel({ themes: [{ theme: "Getting home after late shifts", lines: [1, 2] }] });

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.basedOn).toBe(5);
    expect(result.themes).toHaveLength(1);
  });

  it("labels a quote with the shift and the value beside it", async () => {
    await enoughComments();
    mockModel({ themes: [{ theme: "Something recurring", lines: [1, 2] }] });

    const result = await service.getFeedbackThemes(tenant.orgId);

    const context = result.themes[0].quotes[0].context;
    expect(context).toContain("Evening Service");
    expect(context).toContain("rated 3/5");
  });
});

describe("the quotes are ours", () => {
  /**
   * The failure this design exists to prevent. Asking the model to hand back
   * quotations means trusting it to reproduce someone's words exactly, and a
   * paraphrase inside quotation marks is worse than a wrong summary — it
   * attributes a sentence to a person who did not write it.
   *
   * Two layers stop it, which mutation testing made visible: the parser keeps
   * only `theme` and `lines`, so a `quotes` field never reaches the builder at
   * all, and the builder reads `snippets[idx]` rather than anything on the
   * reply. Deleting either alone is caught here; deleting only the builder's
   * side is not, because by then there is nothing left to misuse.
   */
  it("shows the cited line verbatim, not the model's version of it", async () => {
    // Newest first, so these two are lines 1 and 2 — the ones the model cites.
    await ratedShift("Third comment", { minutesAgo: 58 });
    await ratedShift("Fourth comment", { minutesAgo: 57 });
    await ratedShift("Fifth comment", { minutesAgo: 56 });
    await ratedShift("No handover again at the start of the shift", { minutesAgo: 6 });
    await ratedShift("Nobody briefed me and I was alone for the first hour", {
      minutesAgo: 5,
    });
    mockModel({
      themes: [
        {
          theme: "Handover at the start of shifts",
          lines: [1, 2],
          // The model volunteering its own text for the quotes. Ignored.
          quotes: ["Staff say they are not briefed properly"],
        },
      ],
    });

    const result = await service.getFeedbackThemes(tenant.orgId);
    const texts = result.themes[0].quotes.map((q) => q.text);

    expect(texts).toContain("Nobody briefed me and I was alone for the first hour");
    expect(texts).not.toContain("Staff say they are not briefed properly");
  });

  it("drops a line number that does not exist", async () => {
    await enoughComments();
    mockModel({
      themes: [
        { theme: "Cites one real line and one invented", lines: [1, 99] },
        { theme: "Cites two real lines", lines: [2, 3] },
      ],
    });

    const result = await service.getFeedbackThemes(tenant.orgId);

    // The first theme is left with a single line and fails the corroboration
    // rule; only the second survives.
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0].theme).toBe("Cites two real lines");
  });

  it("ignores a line cited twice rather than quoting it twice", async () => {
    await enoughComments();
    mockModel({ themes: [{ theme: "Duplicated citation", lines: [1, 1, 2] }] });

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.themes[0].quotes).toHaveLength(2);
  });

  it("reads line numbers the model sent as strings", async () => {
    await enoughComments();
    mockModel({ themes: [{ theme: "Quoted numbers", lines: ["1", "2"] }] });

    const result = await service.getFeedbackThemes(tenant.orgId);
    expect(result.themes).toHaveLength(1);
  });
});

describe("a theme needs corroboration", () => {
  /**
   * One comment is a comment. If a single line were enough, the panel would be
   * a model-narrated list of individual remarks — which is the restatement
   * problem the priority-call redesign was for, moved to a new panel.
   */
  it("drops a theme resting on a single line", async () => {
    await enoughComments();
    mockModel({
      themes: [
        { theme: "One person mentioned this", lines: [1] },
        { theme: "Two people mentioned this", lines: [2, 3] },
      ],
    });

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.themes.map((t) => t.theme)).toEqual([
      "Two people mentioned this",
    ]);
  });

  it("keeps a well-supported theme even though it shows only three quotes", async () => {
    for (let i = 0; i < 8; i++) {
      await ratedShift(`Supporting comment ${String.fromCharCode(97 + i)}`, {
        minutesAgo: 60 - i,
      });
    }
    mockModel({
      themes: [{ theme: "Raised across the board", lines: [1, 2, 3, 4, 5, 6] }],
    });

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.themes).toHaveLength(1);
    // Display cap, not an evidence cap — the theme stands on six lines.
    expect(result.themes[0].quotes).toHaveLength(3);
  });

  it("caps the number of themes shown", async () => {
    await enoughComments();
    mockModel({
      themes: [
        { theme: "First", lines: [1, 2] },
        { theme: "Second", lines: [2, 3] },
        { theme: "Third", lines: [3, 4] },
        { theme: "Fourth", lines: [4, 5] },
        { theme: "Fifth", lines: [5, 6] },
      ],
    });

    const result = await service.getFeedbackThemes(tenant.orgId);
    expect(result.themes).toHaveLength(3);
  });
});

describe("the theme label is held to the same standard as the priority reason", () => {
  /**
   * "Six comments mention the pass" is a count the model did not compute and we
   * did not check. Every figure elsewhere on this dashboard comes from the
   * database; this panel is not going to be the exception.
   */
  it("drops a theme whose label contains a figure", async () => {
    await enoughComments();
    mockModel({
      themes: [
        { theme: "3 people mentioned the pass", lines: [1, 2] },
        { theme: "Several mentioned the pass", lines: [2, 3] },
      ],
    });

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.themes.map((t) => t.theme)).toEqual([
      "Several mentioned the pass",
    ]);
  });

  it("drops an empty label", async () => {
    await enoughComments();
    mockModel({ themes: [{ theme: "   ", lines: [1, 2] }] });

    const result = await service.getFeedbackThemes(tenant.orgId);
    expect(result.themes).toEqual([]);
  });

  it("drops a label that runs to a paragraph", async () => {
    await enoughComments();
    mockModel({ themes: [{ theme: "Because ".repeat(40), lines: [1, 2] }] });

    const result = await service.getFeedbackThemes(tenant.orgId);
    expect(result.themes).toEqual([]);
  });
});

describe("malformed replies", () => {
  it("survives a reply that is not JSON at all", async () => {
    await enoughComments();
    mockModel("Staff seem unhappy about the evening shifts, mostly.");

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.themes).toEqual([]);
    // We still read the comments, and saying so is more honest than implying
    // there was nothing to read.
    expect(result.basedOn).toBe(6);
  });

  it("reads a reply the model wrapped in a code fence", async () => {
    await enoughComments();
    mockModel('```json\n{"themes":[{"theme":"Fenced","lines":[1,2]}]}\n```');

    const result = await service.getFeedbackThemes(tenant.orgId);
    expect(result.themes[0].theme).toBe("Fenced");
  });

  it("accepts a bare array without the themes wrapper", async () => {
    await enoughComments();
    mockModel([{ theme: "Unwrapped", lines: [1, 2] }]);

    const result = await service.getFeedbackThemes(tenant.orgId);
    expect(result.themes[0].theme).toBe("Unwrapped");
  });

  it("skips an entry missing its lines rather than discarding the reply", async () => {
    await enoughComments();
    mockModel({
      themes: [{ theme: "No lines given" }, { theme: "Complete", lines: [1, 2] }],
    });

    const result = await service.getFeedbackThemes(tenant.orgId);
    expect(result.themes.map((t) => t.theme)).toEqual(["Complete"]);
  });

  /**
   * A reply that arrived but produced nothing showable still came from a
   * provider. Reporting null would read as "no model configured", which is a
   * different problem with a different fix.
   */
  it("still names the provider when every theme fails validation", async () => {
    await enoughComments();
    mockModel({ themes: [{ theme: "4 people said so", lines: [1, 2] }] });

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.themes).toEqual([]);
    expect(result.provider).toBe("groq");
  });
});

describe("scoping", () => {
  it("never reads text from outside the caller's departments", async () => {
    const other = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    for (let i = 0; i < 6; i++) {
      await ratedShift(`Bar comment ${i}`, {
        minutesAgo: 60 - i,
        departmentId: other.id,
      });
    }
    mockModel({ themes: [{ theme: "Bar themes", lines: [1, 2] }] });

    const result = await service.getFeedbackThemes(tenant.orgId, [
      tenant.departmentId,
    ]);

    expect(result.basedOn).toBe(0);
    expect(result.themes).toEqual([]);
  });

  it("never reads text from another organisation", async () => {
    const otherTenant = await createTenant("themes-other");
    const otherTask = await prisma.task.create({
      data: {
        title: "Their shift",
        organizationId: otherTenant.orgId,
        departmentId: otherTenant.departmentId,
        createdById: otherTenant.admin.userId,
        requiredHeadcount: 1,
        status: "completed",
      },
    });
    for (let i = 0; i < 6; i++) {
      await prisma.taskAssignment.create({
        data: {
          taskId: otherTask.id,
          membershipId:
            i === 0 ? otherTenant.staff.membershipId : otherTenant.manager.membershipId,
          assignedById: otherTenant.admin.userId,
          status: "completed",
          satisfactionRating: 2,
          satisfactionComment: `Their comment ${i}`,
          ratedAt: new Date(),
        },
      });
      if (i === 1) break; // the unique (taskId, membershipId) pair allows two
    }
    mockModel({ themes: [{ theme: "Leaked", lines: [1, 2] }] });

    const result = await service.getFeedbackThemes(tenant.orgId);

    expect(result.basedOn).toBe(0);
  });
});

describe("the window", () => {
  it("ignores comments older than the window", async () => {
    await enoughComments();
    const stale = await ratedShift("Ancient complaint", { minutesAgo: 1 });
    await prisma.taskAssignment.update({
      where: { id: stale.id },
      data: {
        ratedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
        // updatedAt is what the fallback reads, so it has to move too or the
        // row would be picked up by the predates-the-column branch.
        updatedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      },
    });
    mockModel({ themes: [] });

    const result = await service.getFeedbackThemes(tenant.orgId);
    expect(result.basedOn).toBe(6);
  });
});
