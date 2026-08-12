/**
 * Waiving somebody's stated unavailability is an ASK, not a booking.
 *
 * ## The thing being modelled
 *
 * A venue short-staffed on Saturday rings the person who said they were not
 * available. That happens, it is legitimate, and until now the system could not
 * see it — so it happened on WhatsApp and the roster and the record diverged.
 *
 * A manager can therefore waive an availability block with a reason. What that
 * must never become is the system booking somebody over their own stated
 * boundary, so three properties hold, and each is tested here:
 *
 *  1. the assignment is written `pending` even under `auto_accept`;
 *  2. declining it — and accepting it — are excluded from the member's
 *     acceptance rate;
 *  3. how often a member has been asked is countable, and surfaced where the
 *     next such decision gets made.
 *
 * Property 2 is the one that decides whether this is a feature or a pressure
 * tactic. An "offer" you are penalised for refusing is not an offer.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { TaskService } from "@/services/task.service";
import { EligibilityService } from "@/services/eligibility.service";
import { ReportingService } from "@/services/reporting.service";
import { EligibilityOverrideRepository } from "@/repositories/eligibility-override.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, declareOpenWeek, type Tenant } from "../helpers/fixtures";

const tasks = new TaskService();
const eligibility = new EligibilityService();
const reporting = new ReportingService();
const overrides = new EligibilityOverrideRepository();

let tenant: Tenant;
let staffMembership: string;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Rostering has been automatic since the acceptance setting was removed on
 * 2026-08-13, so this no longer has to arrange it — which makes the point of
 * these tests sharper rather than weaker: a `pending` assignment can now ONLY
 * have come from the waiver or from a backfill offer, because nothing else in
 * the product writes one.
 *
 * Kept as a named no-op call site rather than deleted from each test, so the
 * precondition every assertion below depends on is still stated where it is
 * relied upon.
 */
async function autoAccept() {
  /* Nothing to do — it is the only behaviour. */
}

async function futureTask(title = "Saturday close") {
  const start = new Date(Date.now() + 5 * DAY);
  return prisma.task.create({
    data: {
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      title,
      status: "open",
      requiredHeadcount: 2,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 4 * HOUR),
    },
  });
}

async function waiveAvailability(taskId: string, membershipId = staffMembership) {
  return overrides.create({
    taskId,
    membershipId,
    overriddenById: tenant.admin.userId,
    reason: "Short-staffed, asked in person",
    ruleOverridden: "availability",
  });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("consent");
  staffMembership = tenant.staff.membershipId;
  await declareOpenWeek(tenant.staff.membershipId, tenant.manager.membershipId);
  await autoAccept();
});

describe("the assignment is an offer", () => {
  it("is written pending despite auto-accept", async () => {
    const task = await futureTask();
    await waiveAvailability(task.id);

    await tasks.assignStaff(task.id, tenant.orgId, [staffMembership], tenant.admin.userId);

    const row = await prisma.taskAssignment.findFirst({
      where: { taskId: task.id, membershipId: staffMembership },
    });
    expect(row?.status).toBe("pending");
  });

  /*
   * The control. Without this the test above would pass on an organisation that
   * never auto-accepts anything, and would be asserting the fixture rather than
   * the rule.
   */
  it("while an ordinary assignment still auto-accepts", async () => {
    const task = await futureTask();

    await tasks.assignStaff(task.id, tenant.orgId, [staffMembership], tenant.admin.userId);

    const row = await prisma.taskAssignment.findFirst({
      where: { taskId: task.id, membershipId: staffMembership },
    });
    expect(row?.status).toBe("accepted");
  });

  /*
   * Per member, not per call. One assignment can mix a waived candidate with
   * ordinary ones, and the ordinary ones should still get the behaviour the
   * organisation asked for — otherwise waiving one person's availability
   * quietly changes the terms for everybody else on the shift.
   */
  it("does not turn everybody else's assignment into an offer too", async () => {
    const task = await futureTask();
    await waiveAvailability(task.id, staffMembership);

    await tasks.assignStaff(
      task.id,
      tenant.orgId,
      [staffMembership, tenant.manager.membershipId],
      tenant.admin.userId
    );

    const rows = await prisma.taskAssignment.findMany({ where: { taskId: task.id } });
    const byMember = new Map(rows.map((r) => [r.membershipId, r.status]));

    expect(byMember.get(staffMembership)).toBe("pending");
    expect(byMember.get(tenant.manager.membershipId)).toBe("accepted");
  });

  /*
   * `all` is what the assign screen wrote for every waiver before it learned to
   * name the rule. Those rows cannot be told apart afterwards, so they are
   * treated as consent waivers — erring toward asking rather than booking,
   * which is the safe direction for a guess about somebody's consent.
   */
  it("treats a legacy blanket override the same way", async () => {
    const task = await futureTask();
    await overrides.create({
      taskId: task.id,
      membershipId: staffMembership,
      overriddenById: tenant.admin.userId,
      reason: "Legacy row",
      ruleOverridden: "all",
    });

    await tasks.assignStaff(task.id, tenant.orgId, [staffMembership], tenant.admin.userId);

    const row = await prisma.taskAssignment.findFirst({
      where: { taskId: task.id, membershipId: staffMembership },
    });
    expect(row?.status).toBe("pending");
  });

  /*
   * A certification waiver is about competence, not consent — the member has no
   * say in whether they hold one — so it must NOT force an offer. This is the
   * distinction the old blanket `all` key could not express.
   */
  it("leaves a competence waiver alone", async () => {
    const task = await futureTask();
    await overrides.create({
      taskId: task.id,
      membershipId: staffMembership,
      overriddenById: tenant.admin.userId,
      reason: "Cert lapses next week, fine for this shift",
      ruleOverridden: "certification",
    });

    await tasks.assignStaff(task.id, tenant.orgId, [staffMembership], tenant.admin.userId);

    const row = await prisma.taskAssignment.findFirst({
      where: { taskId: task.id, membershipId: staffMembership },
    });
    expect(row?.status).toBe("accepted");
  });
});

describe("saying no is free", () => {
  /** A decided assignment on its own task, optionally waived. */
  async function decided(status: string, options: { waived: boolean }) {
    const task = await futureTask(`Shift ${status}-${options.waived}`);
    if (options.waived) await waiveAvailability(task.id);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: staffMembership,
        assignedById: tenant.admin.userId,
        status,
      },
    });
  }

  async function acceptanceRate() {
    const data = await reporting.getStaffDashboardData(staffMembership, tenant.orgId);
    return data.stats.acceptanceRate;
  }

  it("counts an ordinary decline against the acceptance rate", async () => {
    await decided("accepted", { waived: false });
    await decided("rejected", { waived: false });

    expect(await acceptanceRate()).toBe(50);
  });

  /*
   * The property that makes the offer real. If refusing a shift you had already
   * declared yourself unavailable for dented your own figures, the "choice"
   * would carry a penalty for exercising it.
   */
  it("does not count a decline of a shift they were asked despite being unavailable", async () => {
    await decided("accepted", { waived: false });
    await decided("rejected", { waived: true });

    expect(await acceptanceRate()).toBe(100);
  });

  /*
   * And the accept is dropped as well, not only the decline. Keeping it would
   * let a manager improve somebody's rate by asking them to work days off —
   * the same lever, pointing the other way.
   */
  it("does not count an acceptance of one either", async () => {
    await decided("rejected", { waived: false });
    await decided("accepted", { waived: true });

    expect(await acceptanceRate()).toBe(0);
  });

  // Nothing left to judge them on is not zero — it is no opinion.
  it("reports a full rate when every decision was excused", async () => {
    await decided("rejected", { waived: true });

    expect(await acceptanceRate()).toBe(100);
  });
});

describe("how often it happens is answerable", () => {
  it("counts nothing for a member nobody has waived", async () => {
    const counts = await overrides.countConsentOverrides(
      [staffMembership],
      new Date(Date.now() - 90 * DAY)
    );
    expect(counts.get(staffMembership) ?? 0).toBe(0);
  });

  it("counts each ask", async () => {
    for (let i = 0; i < 3; i++) {
      const task = await futureTask(`Shift ${i}`);
      await waiveAvailability(task.id);
    }

    const counts = await overrides.countConsentOverrides(
      [staffMembership],
      new Date(Date.now() - 90 * DAY)
    );
    expect(counts.get(staffMembership)).toBe(3);
  });

  // A competence waiver is not an ask, and must not inflate the figure that
  // makes a manager pause.
  it("does not count a certification waiver", async () => {
    const task = await futureTask();
    await overrides.create({
      taskId: task.id,
      membershipId: staffMembership,
      overriddenById: tenant.admin.userId,
      reason: "Cert",
      ruleOverridden: "certification",
    });

    const counts = await overrides.countConsentOverrides(
      [staffMembership],
      new Date(Date.now() - 90 * DAY)
    );
    expect(counts.get(staffMembership) ?? 0).toBe(0);
  });

  /*
   * A count that only grows stops being a signal once it is large. The question
   * is whether this is a habit NOW.
   */
  it("ignores asks older than the window", async () => {
    const task = await futureTask();
    const override = await waiveAvailability(task.id);
    await prisma.eligibilityOverride.update({
      where: { id: override.id },
      data: { createdAt: new Date(Date.now() - 200 * DAY) },
    });

    const counts = await overrides.countConsentOverrides(
      [staffMembership],
      new Date(Date.now() - 90 * DAY)
    );
    expect(counts.get(staffMembership) ?? 0).toBe(0);
  });

  it("keeps members apart", async () => {
    const task = await futureTask();
    await waiveAvailability(task.id, tenant.manager.membershipId);

    const counts = await overrides.countConsentOverrides(
      [staffMembership, tenant.manager.membershipId],
      new Date(Date.now() - 90 * DAY)
    );
    expect(counts.get(tenant.manager.membershipId)).toBe(1);
    expect(counts.get(staffMembership) ?? 0).toBe(0);
  });

  /*
   * Reaches the assign panel, which is the only place the number does any work.
   * Counted across ALL tasks, not just the one being assigned — the question is
   * about the member's treatment, not about this shift.
   */
  it("reaches the eligibility result the assign panel reads", async () => {
    const earlier = await futureTask("Earlier shift");
    await waiveAvailability(earlier.id);

    const task = await futureTask("The one being assigned");
    const rows = await eligibility.checkEligibilityForTask(task.id, tenant.orgId);
    const mine = rows.find((r) => r.membershipId === staffMembership);

    expect(mine?.askedDespiteUnavailable).toBe(1);
  });

  /*
   * Through the SERVICE, so the 90-day constant it applies is covered rather
   * than the window the repository test passes in by hand. Mutating
   * CONSENT_LOOKBACK_DAYS survived the first version of this file for exactly
   * that reason: every test named the window itself, so none of them could
   * notice the service using a different one.
   */
  it("applies its own window, not an unbounded one", async () => {
    const old = await futureTask("Months ago");
    const stale = await waiveAvailability(old.id);
    await prisma.eligibilityOverride.update({
      where: { id: stale.id },
      data: { createdAt: new Date(Date.now() - 200 * DAY) },
    });

    const task = await futureTask("The one being assigned");
    const rows = await eligibility.checkEligibilityForTask(task.id, tenant.orgId);
    const mine = rows.find((r) => r.membershipId === staffMembership);

    expect(mine?.askedDespiteUnavailable).toBe(0);
  });
});
