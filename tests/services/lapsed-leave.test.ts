/**
 * A leave request nobody answered before its date arrived.
 *
 * The state the product had no name for. A request is written `pending` and
 * leaves that state only when a manager acts; if nobody does, the day passes
 * and the row stays exactly as it was. It then led the reviewer's queue (which
 * is ordered by date ascending), counted towards the sidebar badge, and read to
 * the member as "Awaiting approval" indefinitely.
 *
 * Answering one was worse than ignoring it. Approving released nothing, because
 * the release only considers shifts from now onward — but the member still
 * received "Your request for <a date in the past> was approved". The tests
 * below exist because that notification is the part that cannot be allowed
 * back: an audit entry that is merely untidy is survivable, a message telling
 * somebody their leave was granted for a day they worked is not.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { AvailabilityService } from "@/services/availability.service";
import {
  isLapsedLeave,
  overrideDateKey,
} from "@/repositories/availability.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { todaySgtAt } from "../helpers/time";
import { pauseForAbsence } from "../helpers/settle";

const service = new AvailabilityService();

let tenant: Tenant;
let fullTimer: string;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("lapsed-leave");

  const user = await prisma.user.create({
    data: { name: "Full Timer", email: "ft@lapsed.test", hashedPassword: "h" },
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
  fullTimer = membership.id;
});

/**
 * Writes a pending request directly, because the service refuses to CREATE one
 * for a date already past — which is correct, and is why this state can only be
 * reached by a live request ageing into it. Going through Prisma is the only
 * honest way to reproduce a row that was legal when it was written.
 */
function pendingOn(dayOffset: number, reason = "Away") {
  return prisma.availabilityOverride.create({
    data: {
      membershipId: fullTimer,
      date: overrideDateKey(todaySgtAt(12, dayOffset)),
      isAvailable: false,
      reason,
      status: "pending",
    },
  });
}

const asAdmin = (id: string, decision: "approved" | "rejected" | "dismissed") =>
  service.reviewLeave(id, decision, tenant.admin.userId, tenant.orgId, null);

describe("the rule itself", () => {
  /*
   * `now` is injected, so these are claims about the dates named rather than
   * about the day the suite runs — the defect that made an assistant test pass
   * every afternoon and fail at 01:00.
   */
  const now = new Date("2026-08-11T04:00:00Z"); // noon in Singapore

  it("is true for yesterday and false for tomorrow", () => {
    expect(isLapsedLeave(new Date("2026-08-10T00:00:00Z"), now)).toBe(true);
    expect(isLapsedLeave(new Date("2026-08-12T00:00:00Z"), now)).toBe(false);
  });

  it("is false on the day itself", () => {
    // A request for TODAY has not lapsed. The day is not over, the shift may
    // not have started, and a manager can still answer it in time.
    expect(isLapsedLeave(new Date("2026-08-11T00:00:00Z"), now)).toBe(false);
  });

  /*
   * The boundary is the organisation's calendar day, not the server's. At
   * 23:00 UTC it is already tomorrow in Singapore, so a request for the UTC
   * "today" has lapsed for this organisation — and a rule that read the host's
   * clock would keep it live for another eight hours.
   */
  it("draws the boundary on the organisation's day, not the host's", () => {
    const lateUtc = new Date("2026-08-11T23:00:00Z"); // 07:00 on the 12th, SGT
    expect(isLapsedLeave(new Date("2026-08-11T00:00:00Z"), lateUtc)).toBe(true);
  });
});

describe("what each side is told", () => {
  it("marks a request whose date has passed, and one that has not", async () => {
    await pendingOn(-3, "Old");
    await pendingOn(3, "Soon");

    const { rows } = await service.getLeaveRegister(tenant.orgId, null, {
      view: "pending",
    });
    const byReason = new Map(rows.map((r) => [r.reason, r.lapsed]));

    expect(byReason.get("Old")).toBe(true);
    expect(byReason.get("Soon")).toBe(false);
  });

  /*
   * Both sides read the same flag. The member's screen said "Awaiting approval"
   * against a day long gone, identically to one next week — so the person with
   * the most reason to chase it was the one being told it was in hand.
   */
  it("marks it the same way on the member's own list", async () => {
    const lapsed = await pendingOn(-3);

    const mine = await service.getOverrides(fullTimer);

    expect(mine.find((o) => o.id === lapsed.id)?.lapsed).toBe(true);
  });
});

describe("what a reviewer may do about it", () => {
  it("refuses to approve a request whose date has passed", async () => {
    const old = await pendingOn(-2);

    await expect(asAdmin(old.id, "approved")).rejects.toThrow(/already passed/);
  });

  it("refuses to decline one either", async () => {
    // Declining sends its own notification — "your request was declined" about
    // a day already worked is the same lie in the other direction.
    const old = await pendingOn(-2);

    await expect(asAdmin(old.id, "rejected")).rejects.toThrow(/already passed/);
  });

  it("refuses to dismiss a request that is still live", async () => {
    // Otherwise dismissal is a way to clear a real request from the queue
    // without answering it, and the member is never told.
    const soon = await pendingOn(4);

    await expect(asAdmin(soon.id, "dismissed")).rejects.toThrow(
      /must be approved or declined/
    );
  });

  it("dismisses a lapsed one, and records who did it", async () => {
    const old = await pendingOn(-2);

    await asAdmin(old.id, "dismissed");

    const row = await prisma.availabilityOverride.findUnique({
      where: { id: old.id },
    });
    expect(row?.status).toBe("dismissed");
    // The reviewer is recorded even though nothing was decided: "nobody
    // answered this and then somebody cleared it" is the fact worth keeping.
    expect(row?.reviewedById).toBe(tenant.admin.userId);
  });

  it("leaves the queue once dismissed", async () => {
    const old = await pendingOn(-2);
    await asAdmin(old.id, "dismissed");

    const { rows } = await service.getLeaveRegister(tenant.orgId, null, {
      view: "pending",
    });

    expect(rows.map((r) => r.id)).not.toContain(old.id);
  });

  /*
   * The assertion this file exists for.
   *
   * `pauseForAbsence` rather than a bare check: the notification is
   * fire-and-forget, so asserting immediately would pass even if one were being
   * sent, and the test would be one of the twelve in this project that cannot
   * fail.
   */
  it("tells the member nothing", async () => {
    const old = await pendingOn(-2);
    const member = await prisma.membership.findUnique({
      where: { id: fullTimer },
      select: { userId: true },
    });

    await asAdmin(old.id, "dismissed");

    await pauseForAbsence();
    const sent = await prisma.notification.count({
      where: { userId: member!.userId },
    });
    expect(sent).toBe(0);
  });
});

describe("clearing them all at once", () => {
  /*
   * The sweep goes through `reviewLeave` per row rather than one UPDATE, so
   * every guard still applies. These pin the two that would be easiest to lose:
   * it must not reach outside the caller's scope, and it must not become the
   * door through which a full-time manager signs off their own leave.
   */
  it("dismisses every lapsed request in scope and leaves live ones alone", async () => {
    const oldOne = await pendingOn(-4, "Old one");
    const oldTwo = await pendingOn(-2, "Old two");
    const live = await pendingOn(6, "Still coming");

    const result = await service.dismissLapsedLeave(
      tenant.orgId,
      tenant.admin.userId,
      null
    );

    expect(result).toEqual({ dismissed: 2, skipped: 0 });
    const rows = await prisma.availabilityOverride.findMany({
      where: { id: { in: [oldOne.id, oldTwo.id, live.id] } },
      select: { id: true, status: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(oldOne.id)).toBe("dismissed");
    expect(byId.get(oldTwo.id)).toBe("dismissed");
    expect(byId.get(live.id)).toBe("pending");
  });

  it("does not let a reviewer sweep away their own request", async () => {
    // Reachable because a MANAGER can be full-time. `reviewLeave` refuses it
    // one at a time; a bulk UPDATE would not have, which is the whole reason
    // this loops rather than issuing one statement.
    const membership = await prisma.membership.findUnique({
      where: { id: fullTimer },
      select: { userId: true },
    });
    const mine = await pendingOn(-3);

    const result = await service.dismissLapsedLeave(
      tenant.orgId,
      membership!.userId,
      null
    );

    expect(result).toEqual({ dismissed: 0, skipped: 1 });
    const row = await prisma.availabilityOverride.findUnique({
      where: { id: mine.id },
    });
    expect(row?.status).toBe("pending");
  });

  /*
   * The defect: the sweep read ONE page. A button reading "Dismiss all 60"
   * cleared fifty, reported fifty, and left ten behind with nothing said —
   * which is worse than not offering the button, because the reader believes
   * the queue is empty.
   *
   * 55 rows rather than 51, so the second batch is unambiguously a batch.
   */
  it("clears more than one page of them", async () => {
    const days = Array.from({ length: 55 }, (_, i) => -(i + 1));
    await prisma.availabilityOverride.createMany({
      data: days.map((d) => ({
        membershipId: fullTimer,
        date: overrideDateKey(todaySgtAt(12, d)),
        isAvailable: false,
        reason: "Away",
        status: "pending",
      })),
    });

    const result = await service.dismissLapsedLeave(
      tenant.orgId,
      tenant.admin.userId,
      null
    );

    expect(result).toEqual({ dismissed: 55, skipped: 0 });
    expect(
      await prisma.availabilityOverride.count({
        where: { membershipId: fullTimer, status: "pending" },
      })
    ).toBe(0);
  });

  /*
   * And it must stop. A refused row stays in the lapsed view, so "keep going
   * while rows remain" spins forever on a queue holding only requests this
   * reviewer may never dismiss. Without the progress check this test hangs
   * rather than failing, which is why it is worth having.
   */
  it("terminates when every remaining request must be refused", async () => {
    const membership = await prisma.membership.findUnique({
      where: { id: fullTimer },
      select: { userId: true },
    });
    await pendingOn(-2, "Mine one");
    await pendingOn(-3, "Mine two");

    const result = await service.dismissLapsedLeave(
      tenant.orgId,
      membership!.userId,
      null
    );

    expect(result).toEqual({ dismissed: 0, skipped: 2 });
  });

  it("tells the members nothing", async () => {
    await pendingOn(-4);
    await pendingOn(-2);
    const membership = await prisma.membership.findUnique({
      where: { id: fullTimer },
      select: { userId: true },
    });

    await service.dismissLapsedLeave(tenant.orgId, tenant.admin.userId, null);

    await pauseForAbsence();
    expect(
      await prisma.notification.count({ where: { userId: membership!.userId } })
    ).toBe(0);
  });
});

describe("the scheduled sweep", () => {
  /*
   * `submittedAt` is set explicitly rather than left to default, because that
   * is the clock the SLA half runs on and a fixture that lets it default is
   * asserting about the second the row was written.
   */
  function pendingSubmitted(dayOffset: number, submittedHoursAgo: number) {
    return prisma.availabilityOverride.create({
      data: {
        membershipId: fullTimer,
        date: overrideDateKey(todaySgtAt(12, dayOffset)),
        isAvailable: false,
        reason: "Away",
        status: "pending",
        submittedAt: new Date(Date.now() - submittedHoursAgo * 3_600_000),
      },
    });
  }

  const reviewers = () =>
    prisma.notification.count({
      where: { organizationId: tenant.orgId, type: "leave_reminder" },
    });

  it("chases a request that has sat past its SLA", async () => {
    // 200 days out, so only the SLA half can fire — the horizon is nowhere near.
    const old = await pendingSubmitted(200, 72);

    const result = await service.sweepPendingLeave(tenant.orgId);

    expect(result.reminded).toBe(1);
    const row = await prisma.availabilityOverride.findUnique({
      where: { id: old.id },
    });
    expect(row?.remindedAt).not.toBeNull();
    expect(await reviewers()).toBeGreaterThan(0);
  });

  it("leaves a fresh request for a distant date alone", async () => {
    await pendingSubmitted(200, 1);

    const result = await service.sweepPendingLeave(tenant.orgId);

    expect(result.reminded).toBe(0);
    expect(await reviewers()).toBe(0);
  });

  /*
   * The idempotence that matters. The cron runs on a schedule, so a sweep that
   * re-sent on every pass would be the loudest thing in the product within a
   * day — and the mark is a column precisely because the notification log
   * cannot answer this when an org has the type disabled.
   */
  it("does not chase the same request twice in a row", async () => {
    await pendingSubmitted(200, 72);

    await service.sweepPendingLeave(tenant.orgId);
    const second = await service.sweepPendingLeave(tenant.orgId);

    expect(second.reminded).toBe(0);
  });

  it("escalates once the reminder has gone stale", async () => {
    const old = await pendingSubmitted(200, 72);
    await prisma.availabilityOverride.update({
      where: { id: old.id },
      data: { remindedAt: new Date(Date.now() - 48 * 3_600_000) },
    });

    const result = await service.sweepPendingLeave(tenant.orgId);

    expect(result.escalated).toBe(1);
    const row = await prisma.availabilityOverride.findUnique({
      where: { id: old.id },
    });
    expect(row?.escalatedAt).not.toBeNull();
  });

  it("tells the member when their request has lapsed", async () => {
    await pendingOn(-3);
    const membership = await prisma.membership.findUnique({
      where: { id: fullTimer },
      select: { userId: true },
    });

    const result = await service.sweepPendingLeave(tenant.orgId);

    expect(result.lapseNotified).toBe(1);
    expect(
      await prisma.notification.count({
        where: { userId: membership!.userId, type: "leave_lapsed" },
      })
    ).toBe(1);
  });

  it("tells them once, not on every run", async () => {
    await pendingOn(-3);

    await service.sweepPendingLeave(tenant.orgId);
    const second = await service.sweepPendingLeave(tenant.orgId);

    expect(second.lapseNotified).toBe(0);
  });

  /*
   * Editing a declined request re-opens it, and the upsert clears every chase
   * mark alongside `reviewedById`. Without that, a request already chased once
   * is never chased again — made invisible to the sweep by the act of editing
   * it.
   */
  it("chases a re-submitted request again", async () => {
    const first = await pendingSubmitted(200, 72);
    await service.sweepPendingLeave(tenant.orgId);

    await prisma.availabilityOverride.update({
      where: { id: first.id },
      data: { status: "rejected", reviewedById: tenant.admin.userId },
    });
    // Re-submitting the same date goes through the upsert.
    await service.createOverride(fullTimer, {
      date: todaySgtAt(12, 200).toISOString(),
      isAvailable: false,
      reason: "Asking again",
    });

    const reopened = await prisma.availabilityOverride.findUnique({
      where: { id: first.id },
    });
    expect(reopened?.remindedAt).toBeNull();
    expect(reopened?.status).toBe("pending");
  });
});
