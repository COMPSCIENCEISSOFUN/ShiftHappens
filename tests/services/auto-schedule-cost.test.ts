/**
 * What a generated week costs, and which draft wins.
 *
 * ## The query explosion
 *
 * Both auto-schedule paths call `checkEligibilityForTask` per task, and the
 * engine's per-member memo lived for exactly one call — so every member's
 * commitments were reloaded for every task. Worse, the memo was keyed on
 * `membershipId|excludeTaskId`, and the excluded task differs per task, so even
 * a shared memo could not have been reused. At 100 tasks and 100 members that
 * is 10,000 identical round trips for data that does not change during a run.
 *
 * Two changes: the memo is keyed on the member alone and the excluded task is
 * filtered in memory, and the auto-scheduler owns one memo for the whole run.
 * The count is the property worth asserting — timing is flaky and proves
 * nothing on a fast machine.
 *
 * ## Which draft wins
 *
 * `generateSchedule` preferred the AI draft whenever it returned anything at
 * all. That was defensible while the AI path validated nothing, but every
 * proposal is now screened against the engine, so a draft that filled three of
 * twenty slots still won — leaving seventeen shifts for a manager to fill by
 * hand while the panel reported the model had scheduled the week.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { EligibilityService } from "@/services/eligibility.service";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { sgt } from "../helpers/time";

const autoSchedule = new AutoScheduleService();
const eligibility = new EligibilityService();

let tenant: Tenant;
const staffIds: string[] = [];

/** Monday of the fixture week, in the org's timezone. */
const WEEK_START = sgt("2026-09-07T00:00");

beforeEach(async () => {
  await cleanDatabase();
  staffIds.length = 0;
  tenant = await createTenant("autocost");

  await prisma.companySettings.upsert({
    where: { organizationId: tenant.orgId },
    create: { organizationId: tenant.orgId, breakRuleHoursWorked: 1000 },
    update: { breakRuleHoursWorked: 1000 },
  });

  /*
   * The fixture's own manager and staff are casual with no availability rows,
   * so the engine correctly refuses them every shift. Made full-time here so
   * the only thing under test is which DRAFT wins, not who is eligible — a
   * fixture where two of the seven can never work makes "the model filled the
   * week" impossible to express.
   */
  await prisma.membership.updateMany({
    where: { organizationId: tenant.orgId },
    data: { employmentType: "full_time" },
  });

  // Full-time so weekly availability is not a constraint, and in the task's
  // department so the department filter does not remove them.
  for (let i = 0; i < 5; i++) {
    const user = await prisma.user.create({
      data: {
        name: `Staff ${i}`,
        email: `s${i}-${Date.now()}-${i}@example.com`,
        hashedPassword: "hash",
      },
    });
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: tenant.orgId,
        role: "staff",
        status: "active",
        employmentType: "full_time",
        departmentMemberships: { create: { departmentId: tenant.departmentId } },
      },
    });
    staffIds.push(membership.id);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A shift on the given weekday, 09:00–11:00, so nothing overlaps. */
async function shift(dayOffset: number, hour: number) {
  const date = String(7 + dayOffset).padStart(2, "0");
  const h = String(hour).padStart(2, "0");
  return prisma.task.create({
    data: {
      title: `Shift ${dayOffset}-${hour}`,
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: 1,
      status: "open",
      scheduledStart: sgt(`2026-09-${date}T${h}:00`),
      scheduledEnd: sgt(`2026-09-${date}T${String(hour + 2).padStart(2, "0")}:00`),
    },
  });
}

describe("a member's commitments are loaded once per run", () => {
  /*
   * The property, stated as a count: the number of commitment loads must scale
   * with MEMBERS, not with members × tasks. Before, four tasks against five
   * members cost twenty loads; the shared memo makes it five.
   */
  it("does not reload them for every task", async () => {
    for (let d = 0; d < 4; d++) await shift(d, 9);

    const spy = vi.spyOn(
      TaskAssignmentRepository.prototype,
      "findCommittedWithSchedule"
    );

    await autoSchedule.generateSchedule(tenant.orgId, WEEK_START);

    /*
     * The fixture has seven rosterable members (five here plus the tenant's
     * manager and staff) and four tasks. Per-task loading would be ~28; one
     * load per member is 7. The bound is deliberately generous — the property
     * is "scales with members, not members × tasks", not an exact figure that
     * would break the moment a fixture gained a member.
     */
    const members = await prisma.membership.count({
      where: { organizationId: tenant.orgId, status: "active" },
    });
    expect(spy.mock.calls.length).toBeLessThanOrEqual(members + 2);
  });

  /*
   * The correctness the optimisation must not cost.
   *
   * Excluding the task under evaluation moved out of the QUERY and into memory,
   * and the dimension that exclusion actually protects is HOURS — the daily and
   * weekly caps and the break rule all sum `loadCommittedAssignments`. Without
   * it, a member already assigned to the task has that shift counted a second
   * time, and a cap set at exactly one shift's length refuses them from the
   * very shift they are already on.
   *
   * The scheduling dimension is NOT the probe: it uses its own query with its
   * own exclusion, so it passes either way. An earlier version of this test
   * asserted on it and survived the mutation.
   */
  it("does not count the task under evaluation against its own hour cap", async () => {
    const task = await shift(0, 9); // 2 hours
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: staffIds[0],
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });
    // A cap of exactly one shift: fine counted once, breached counted twice.
    await prisma.workRule.create({
      data: {
        organizationId: tenant.orgId,
        name: "Two hours a day",
        type: "max_hours_daily",
        maxHours: 2,
        isActive: true,
      },
    });

    const results = await eligibility.checkEligibilityForTask(
      task.id,
      tenant.orgId
    );
    const mine = results.find((r) => r.membershipId === staffIds[0]);

    expect(mine?.checks.workRules.eligible).toBe(true);
  });

  // And a DIFFERENT shift on the same day still counts — otherwise the
  // in-memory filter would be removing too much.
  it("still counts another shift on the same day", async () => {
    const worked = await shift(0, 9); // 09:00-11:00
    await prisma.taskAssignment.create({
      data: {
        taskId: worked.id,
        membershipId: staffIds[0],
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });
    const proposed = await shift(0, 14); // 14:00-16:00, same day
    await prisma.workRule.create({
      data: {
        organizationId: tenant.orgId,
        name: "Two hours a day",
        type: "max_hours_daily",
        maxHours: 2,
        isActive: true,
      },
    });

    const results = await eligibility.checkEligibilityForTask(
      proposed.id,
      tenant.orgId
    );
    const mine = results.find((r) => r.membershipId === staffIds[0]);

    expect(mine?.checks.workRules.eligible).toBe(false);
  });
});

describe("the draft that fills more of the week is the one returned", () => {
  /*
   * With no provider keys configured `generateWithAI` throws immediately, so
   * this exercises the algorithmic path end to end — the case a manager gets on
   * a dev machine, and the one that must still fill the week.
   */
  it("fills every slot it can with no model configured", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;

    for (let d = 0; d < 3; d++) await shift(d, 9);

    const draft = await autoSchedule.generateSchedule(tenant.orgId, WEEK_START);

    expect(draft.provider).toBe("algorithmic");
    expect(draft.assignments).toHaveLength(3);
    expect(draft.unfilledTasks).toHaveLength(0);
  });

  /*
   * A model that fills only part of the week no longer wins by default. The
   * stub answers with one assignment for three tasks; the algorithmic pass can
   * fill all three, so that is what comes back.
   */
  it("prefers the algorithmic pass when the model fills less of it", async () => {
    for (let d = 0; d < 3; d++) await shift(d, 9);

    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: JSON.stringify([{ task: 1, staff: "A" }]) } },
          ],
        }),
      })
    );

    const draft = await autoSchedule.generateSchedule(tenant.orgId, WEEK_START);

    expect(draft.assignments.length).toBe(3);
    expect(draft.provider).toBe("algorithmic");

    vi.unstubAllGlobals();
    delete process.env.GROQ_API_KEY;
  });

  /*
   * And a model that fills the week keeps it. The reasoning strings are the
   * model's contribution, so a draft that is as complete as the alternative
   * should not be discarded for a tie.
   */
  it("keeps the model's draft when it fills the week", async () => {
    for (let d = 0; d < 3; d++) await shift(d, 9);

    /*
     * The stub answers from the prompt it was actually given rather than from
     * guessed labels: task numbering and staff letters are assigned inside
     * `buildAIPrompt`, so hard-coding them makes the test pass or fail on
     * fixture ordering rather than on the behaviour under test.
     */
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        const prompt = JSON.parse(init.body).messages[0].content as string;
        const tasks = [...prompt.matchAll(/^ {2}Task (\d+):/gm)].map((m) => Number(m[1]));
        const staff = [...prompt.matchAll(/^ {2}Staff ([A-Z]):/gm)].map((m) => m[1]);
        const answer = tasks.map((task, i) => ({ task, staff: staff[i % staff.length] }));
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(answer) } }],
          }),
        };
      })
    );

    const draft = await autoSchedule.generateSchedule(tenant.orgId, WEEK_START);

    expect(draft.assignments).toHaveLength(3);
    expect(draft.provider).toBe("groq");

    vi.unstubAllGlobals();
    delete process.env.GROQ_API_KEY;
  });
});

describe("the prompt states the hard constraints", () => {
  /*
   * Department and certifications are hard filters in the engine, but the
   * prompt called department a preference and never mentioned certifications
   * at all. So the model proposed people who were then screened out, and the
   * draft it produced was routinely worse than it needed to be.
   */
  it("names department and certifications as hard rules", async () => {
    await shift(0, 9);
    await prisma.task.updateMany({
      where: { organizationId: tenant.orgId },
      data: { requiredCertifications: ["Food Safety"] },
    });

    let sentPrompt = "";
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        sentPrompt = JSON.parse(init.body).messages[0].content;
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "[]" } }],
          }),
        };
      })
    );

    await autoSchedule.generateSchedule(tenant.orgId, WEEK_START);

    expect(sentPrompt).toMatch(/HARD RULES/);
    expect(sentPrompt).toMatch(/Department must MATCH/);
    expect(sentPrompt).toMatch(/Certifications must be held/);
    // And the task line carries the certifications it actually requires.
    expect(sentPrompt).toContain("REQUIRES certs: Food Safety");

    vi.unstubAllGlobals();
    delete process.env.GROQ_API_KEY;
  });
});
