// @vitest-environment node
/**
 * What the Free plan is, enforced in the CONTROL layer.
 *
 * ## Why the services and not the routes
 *
 * The request that produced this change asked for premium features to be
 * blocked "server-side as well as in the frontend — do not only hide buttons".
 * Hiding a button is one layer; a route guard is a second; and a route guard is
 * still not the answer, because the interesting callers are not routes.
 * `AllocationService.autoAllocate` is reached by the hourly cron sweep, by the
 * recurring-task materialiser and by the task-create path, none of which passes
 * through `requirePermission`. A gate on the URL would have left three
 * unattended paths spending provider quota for an organisation paying nothing.
 *
 * So these tests call the services directly, with no HTTP and no session. If a
 * Free organisation can reach the behaviour from here, it can reach it from
 * anywhere.
 *
 * `tests/api/permission-enforcement.test.ts` covers the boundary layer, and
 * `tier-feature-matrix.test.ts` pins which features belong to which plan. This
 * file is about what a plan can actually DO.
 *
 * ## The positioning being pinned
 *
 *   Free  = core workforce management + deterministic eligibility + manual
 *           allocation.
 *   Pro+  = smart ranking + AI + automation + Projects + advanced tools.
 *
 * Both halves matter equally, so the "Free keeps" block below is not padding:
 * a gating change that quietly took eligibility checks or manual assignment
 * away from Free would be as wrong as one that left auto-allocation open.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, createTask, type Tenant } from "../helpers/fixtures";
import { FeatureNotAvailableError } from "@/lib/subscription-tiers";
import { AllocationService } from "@/services/allocation.service";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { AITaskParserService } from "@/services/ai-task-parser.service";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { SettingsService } from "@/services/settings.service";
import { ProjectService } from "@/services/project.service";
import { SubscriptionService } from "@/services/subscription.service";

const allocation = new AllocationService();
const autoSchedule = new AutoScheduleService();
const parser = new AITaskParserService();
const aiDashboard = new AIDashboardService();
const settings = new SettingsService();
const projects = new ProjectService();
const subscriptions = new SubscriptionService();

let free: Tenant;
let pro: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  free = await createTenant("free", { subscriptionTier: "free" });
  pro = await createTenant("pro", { subscriptionTier: "pro" });
});

/** The plan refusal, asserted as a type rather than by matching a string. */
async function refusesOnPlan(run: () => Promise<unknown>) {
  await expect(run()).rejects.toBeInstanceOf(FeatureNotAvailableError);
}

/*
 * ── What Free cannot do ────────────────────────────────────────────────────
 */

describe("smart ranked suggestions", () => {
  it("is refused for a Free organisation", async () => {
    const task = await createTask(free);
    await refusesOnPlan(() => allocation.getSuggestions(task.id, free.orgId));
  });

  /*
   * `getSuggestions` delegates to `getRankedSuggestions`, and the gate lives in
   * the delegate. Asserted separately because three other callers reach the
   * delegate directly, so a refactor that moved the check up into
   * `getSuggestions` would leave those three open and this suite green.
   */
  it("is refused on the ranked variant that other services call", async () => {
    const task = await createTask(free);
    await refusesOnPlan(() =>
      allocation.getRankedSuggestions(task.id, free.orgId)
    );
  });

  /*
   * The ranked cover shortlist behind a withdrawal decision. It calls no
   * provider — it is the deterministic ranker — and is gated anyway, because
   * the feature being sold is ranked suggestions rather than "AI". Gating only
   * the provider calls would leave Free with the same screen and a slightly
   * worse engine.
   */
  it("is refused for the cover shortlist, which spends no provider call", async () => {
    const task = await createTask(free);
    await refusesOnPlan(() => allocation.coverOptions(task.id, free.orgId));
  });

  /*
   * The other side of the gate. Asserted as "ranks somebody" rather than as a
   * specific list, because the ORDER is the ranker's business and is pinned by
   * `ranking-engine.test.ts`; what matters here is that the plan check lets
   * the call through and the shortlist arrives.
   */
  it("is allowed on Pro", async () => {
    const task = await createTask(pro);
    const options = await allocation.coverOptions(task.id, pro.orgId);
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toMatchObject({ rank: 1 });
  });
});

describe("automatic allocation", () => {
  it("is refused for a Free organisation", async () => {
    const task = await createTask(free);
    await refusesOnPlan(() =>
      allocation.autoAllocate(task.id, free.orgId, free.admin.userId)
    );
  });

  /*
   * The refusal has to come from the PLAN, not from the mode.
   *
   * With `allocationMode` left at its default a Free organisation is refused
   * either way, and "auto allocation is not enabled" would be the wrong reason
   * — it describes a setting an admin would go and try to change, and on Free
   * there is no setting that fixes it. Forcing the column to "auto" behind the
   * service's back isolates which gate answers.
   */
  it("refuses on the plan even when the settings row says auto", async () => {
    await prisma.companySettings.update({
      where: { organizationId: free.orgId },
      data: { allocationMode: "auto" },
    });
    const task = await createTask(free);
    await refusesOnPlan(() =>
      allocation.autoAllocate(task.id, free.orgId, free.admin.userId)
    );
  });

  /*
   * The unattended path. A stored `"auto"` left over from a Pro subscription
   * must not keep the cron sweep staffing shifts after a downgrade — and it
   * must fail QUIETLY, because a plan without automation is a normal state of
   * the world rather than a fault worth an error per tenant per hour.
   */
  it("skips the cron sweep silently rather than throwing", async () => {
    await prisma.companySettings.update({
      where: { organizationId: free.orgId },
      data: { allocationMode: "auto" },
    });
    await expect(allocation.staffUnfilled(free.orgId)).resolves.toEqual({
      considered: 0,
      filled: 0,
    });
  });
});

describe("the weekly auto-schedule", () => {
  it("refuses to generate a draft for a Free organisation", async () => {
    await refusesOnPlan(() =>
      autoSchedule.generateSchedule(free.orgId, new Date("2026-09-07T00:00:00Z"))
    );
  });

  /*
   * Confirming is gated in its own right. A caller holding a draft from before
   * a downgrade must not be able to commit it: confirmation creates real
   * assignments and notifies staff, which is a new obligation on people.
   */
  it("refuses to confirm a draft for a Free organisation", async () => {
    await refusesOnPlan(() =>
      autoSchedule.confirmSchedule(free.orgId, [], free.admin.userId)
    );
  });
});

describe("natural-language task creation", () => {
  it("is refused for a Free organisation", async () => {
    await refusesOnPlan(() =>
      parser.parseTaskDescription("2 kitchen staff tomorrow", free.orgId, null)
    );
  });

  /*
   * Including when no provider is configured, which is the case in the test
   * environment. The keyword fallback is not a free consolation prize — it is
   * the same feature answering when a provider is down — so a gate placed
   * after the `hasApiKey` check would have sold Free the feature whenever the
   * model was unavailable.
   */
  it("is refused before the keyword fallback can answer", async () => {
    await refusesOnPlan(() => parser.parseTaskDescription("x", free.orgId, null));
  });
});

describe("advanced analytics", () => {
  /*
   * The empty answer rather than a throw, and that asymmetry is deliberate:
   * every other "no honest answer" case in `getPriorityCall` is `{ call: null }`
   * and its one caller renders nothing for it. Throwing would turn an optional
   * dashboard panel into a 500 on every Free page load.
   */
  it("returns no priority call for a Free organisation", async () => {
    await expect(aiDashboard.getPriorityCall(free.orgId)).resolves.toEqual({
      call: null,
    });
  });
});

describe("projects", () => {
  it("refuses creation for a Free organisation", async () => {
    await refusesOnPlan(() =>
      projects.create(
        { title: "Refit", staffingMode: "task_based", departmentIds: [free.departmentId] },
        free.orgId,
        free.admin.userId
      )
    );
  });

  /*
   * The FEATURE refusal, not the limit one. Free's allowance is zero, so both
   * gates fire — but "projects limit reached (0/0)" describes a full container
   * where the truth is that the plan has no projects in it at all.
   */
  it("refuses with the feature error rather than the limit error", async () => {
    await expect(
      projects.create(
        { title: "Refit", staffingMode: "task_based", departmentIds: [free.departmentId] },
        free.orgId,
        free.admin.userId
      )
    ).rejects.toThrow(/not available on the Free plan/i);
  });

  /*
   * A downgraded organisation keeps its projects and can still edit nothing.
   * Built on Pro and then dropped to Free, because that is the only way to
   * have a project on a plan that cannot create one.
   */
  it("refuses to edit a project carried across a downgrade", async () => {
    const project = await projects.create(
      { title: "Refit", staffingMode: "task_based", departmentIds: [pro.departmentId] },
      pro.orgId,
      pro.admin.userId
    );
    await prisma.organization.update({
      where: { id: pro.orgId },
      data: { subscriptionTier: "free" },
    });

    await refusesOnPlan(() =>
      projects.update(project.id, pro.orgId, { title: "Renamed" }, pro.admin.userId)
    );
  });

  /*
   * The rows survive the downgrade even though the FEATURE does not.
   *
   * Free shows no Projects link and an upsell in place of the page — the
   * product is hidden, because a Free organisation cannot have projects. What
   * is not destroyed is the data: it comes back intact on upgrade, and
   * leaving the service read ungated is what keeps it reachable for export,
   * audit and migration in the meantime.
   */
  it("keeps the rows readable at the service even though the UI hides them", async () => {
    await projects.create(
      { title: "Refit", staffingMode: "task_based", departmentIds: [pro.departmentId] },
      pro.orgId,
      pro.admin.userId
    );
    await prisma.organization.update({
      where: { id: pro.orgId },
      data: { subscriptionTier: "free" },
    });

    const list = await projects.list(pro.orgId);
    expect(list.map((p) => p.title)).toContain("Refit");
  });
});

describe("the allocation mode setting", () => {
  it("refuses to select auto on a Free organisation", async () => {
    await refusesOnPlan(() =>
      settings.updateSettings(free.orgId, { allocationMode: "auto" })
    );
  });

  /*
   * The stored mode is moved off "suggested" first, because the guard only
   * fires when the field is actually CHANGING — see the test below, which is
   * what that rule exists for.
   */
  it("refuses to select the ranked mode on a Free organisation", async () => {
    await prisma.companySettings.update({
      where: { organizationId: free.orgId },
      data: { allocationMode: "auto" },
    });

    await refusesOnPlan(() =>
      settings.updateSettings(free.orgId, { allocationMode: "suggested" })
    );
  });

  /*
   * Re-submitting the mode already stored is NOT a plan refusal, and this is
   * load-bearing rather than a leniency.
   *
   * The settings screen posts every field it holds, so a Free admin who opens
   * the panel to change their opening hours and presses Save sends the stored
   * `allocationMode` back with it. Refusing an unchanged value would make the
   * entire settings form unsaveable on Free — the plan would be taking away a
   * setting it does not gate.
   */
  it("allows re-saving the mode already stored", async () => {
    const before = await prisma.companySettings.findUniqueOrThrow({
      where: { organizationId: free.orgId },
    });

    await expect(
      settings.updateSettings(free.orgId, {
        allocationMode: before.allocationMode as "suggested" | "auto",
        operatingHoursStart: 7,
      })
    ).resolves.toMatchObject({ operatingHoursStart: 7 });
  });

  /*
   * A downgraded organisation must not be forced to give up its preference in
   * order to change its opening hours. The mode is only checked when the field
   * is actually being changed.
   */
  it("does not block an unrelated update on a Free organisation", async () => {
    await expect(
      settings.updateSettings(free.orgId, { operatingHoursStart: 7 })
    ).resolves.toMatchObject({ operatingHoursStart: 7 });
  });

  it("reports the effective mode as manual, and says it was held back", async () => {
    await prisma.companySettings.update({
      where: { organizationId: free.orgId },
      data: { allocationMode: "auto" },
    });

    const read = await settings.getSettings(free.orgId);
    expect(read.allocationMode).toBe("manual");
    expect(read.requestedAllocationMode).toBe("auto");
    expect(read.allocationModeDowngraded).toBe(true);
  });

  /*
   * A save and a read must agree. The PATCH route returns `updateSettings`
   * and the GET route returns `getSettings`, so a raw repository row from the
   * former meant saving showed the stored preference and the next reload
   * replaced it with the effective mode — a word changing on screen for no
   * visible reason.
   */
  it("returns the same shape from a save as from a read", async () => {
    const saved = await settings.updateSettings(pro.orgId, {
      allocationMode: "auto",
    });
    const read = await settings.getSettings(pro.orgId);
    expect(saved.allocationMode).toBe(read.allocationMode);
    expect(saved.requestedAllocationMode).toBe(read.requestedAllocationMode);
  });
});

/*
 * ── What Free keeps ────────────────────────────────────────────────────────
 *
 * The other half of the positioning. A gating change that took any of these
 * away would be as wrong as one that left automation open, and rather easier
 * to ship by accident.
 */

describe("core workforce management stays on Free", () => {
  it("grants none of the gated features and needs none of them to work", async () => {
    const usage = await subscriptions.getUsage(free.orgId);
    expect(Object.values(usage.features).every((granted) => !granted)).toBe(true);
  });

  it("keeps deterministic eligibility, which is not a gated feature", async () => {
    const { EligibilityService } = await import("@/services/eligibility.service");
    const task = await createTask(free);
    // No plan refusal: the call either answers or fails on its own merits.
    await expect(
      new EligibilityService().checkEligibilityForTask(task.id, free.orgId)
    ).resolves.toBeDefined();
  });

  it("keeps manual assignment, which is what Free allocation means", async () => {
    const { TaskService } = await import("@/services/task.service");
    const task = await createTask(free);
    await expect(
      new TaskService().assignStaff(
        task.id,
        free.orgId,
        [free.staff.membershipId],
        free.admin.userId
      )
    ).resolves.toBeDefined();
  });

  it("keeps task creation within the plan's limits", async () => {
    const { TaskService } = await import("@/services/task.service");
    await expect(
      new TaskService().create(
        { title: "Prep", requiredHeadcount: 1, departmentId: free.departmentId },
        free.orgId,
        free.admin.userId
      )
    ).resolves.toBeDefined();
  });
});
