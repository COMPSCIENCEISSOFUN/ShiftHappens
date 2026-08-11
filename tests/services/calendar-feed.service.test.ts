/**
 * The calendar feed, and everything the missing session has to be replaced by.
 *
 * This is the only route in the product with no authenticated user: calendar
 * clients poll a URL and send nothing else, so the token IS the credential.
 * Every refusal `requirePermission` would normally provide has to be asked for
 * here instead, and these are those refusals.
 *
 * The other half is what a refusal RETURNS. A client handed a 403 shows its
 * owner nothing — their shifts stop appearing, which reads as an empty rota
 * rather than a plan change — so all but one refusal is a valid calendar
 * carrying an explanation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { CalendarFeedService } from "@/services/calendar-feed.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { todaySgtAt } from "../helpers/time";

const service = new CalendarFeedService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("calendar-feed");
});

async function shiftFor(membershipId: string, dayOffset: number, status: string) {
  const task = await prisma.task.create({
    data: {
      title: "Morning prep",
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      status: "open",
      requiredHeadcount: 1,
      scheduledStart: todaySgtAt(10, dayOffset),
      scheduledEnd: todaySgtAt(14, dayOffset),
    },
  });
  return prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId,
      status,
      assignedById: tenant.admin.userId,
    },
  });
}

const tokenFor = async () =>
  (await service.getFeedToken(tenant.staff.membershipId)).token;

describe("the token", () => {
  it("is created on first ask and stable afterwards", async () => {
    const first = await service.getFeedToken(tenant.staff.membershipId);
    const again = await service.getFeedToken(tenant.staff.membershipId);

    expect(first.token).toBe(again.token);
    // Long enough that guessing is not an attack.
    expect(first.token.length).toBeGreaterThan(30);
  });

  /*
   * Regenerating IS revocation — there is no other mechanism, because the URL
   * is the credential and the holder cannot be asked to prove anything else.
   */
  it("stops resolving once regenerated", async () => {
    const old = await tokenFor();
    await service.regenerate(tenant.staff.membershipId);

    expect(await service.feedFor(old)).toBeNull();
  });

  it("gives two memberships two different feeds", async () => {
    // Somebody in two organisations must be able to revoke one without
    // touching the other, which is why the row hangs off the membership.
    const mine = await tokenFor();
    const theirs = (await service.getFeedToken(tenant.manager.membershipId))
      .token;

    expect(mine).not.toBe(theirs);
  });

  it("resolves nothing for a token that was never issued", async () => {
    expect(await service.feedFor("not-a-real-token")).toBeNull();
  });
});

describe("what the feed contains", () => {
  it("carries an accepted shift as a confirmed event", async () => {
    await shiftFor(tenant.staff.membershipId, 3, "accepted");

    const ics = await service.feedFor(await tokenFor());

    expect(ics).toContain("Morning prep");
    expect(ics).toContain("STATUS:CONFIRMED");
  });

  /*
   * A pending assignment is an OFFER. Showing it as an ordinary event would
   * have somebody turn up to a shift they never accepted; hiding it would lose
   * the one they forgot to answer. Tentative is the state the format has for
   * exactly this.
   */
  it("carries an unanswered offer as tentative", async () => {
    await shiftFor(tenant.staff.membershipId, 3, "pending");

    const ics = await service.feedFor(await tokenFor());

    expect(ics).toContain("STATUS:TENTATIVE");
  });

  it("leaves out a shift the person gave back", async () => {
    await shiftFor(tenant.staff.membershipId, 3, "rejected");

    const ics = await service.feedFor(await tokenFor());

    // `occupiesSlot`, the same predicate the headcount uses. A rejected shift
    // in somebody's calendar is an instruction to turn up to work they declined.
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("carries nobody else's shifts", async () => {
    await shiftFor(tenant.manager.membershipId, 3, "accepted");

    const ics = await service.feedFor(await tokenFor());

    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("is a valid empty calendar for somebody with no shifts", async () => {
    const ics = await service.feedFor(await tokenFor());

    // Not an error and not an empty body: a client given either reports the
    // URL as broken, and a new starter has no shifts by definition.
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("drops a shift far outside the window", async () => {
    await shiftFor(tenant.staff.membershipId, 400, "accepted");

    const ics = await service.feedFor(await tokenFor());

    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});

describe("refusals that still have to look like a calendar", () => {
  /*
   * The plan is checked on every POLL, not when somebody subscribes. The client
   * holds the URL indefinitely and sends no session, so a downgrade must be
   * able to stop a feed already sitting in a phone — nothing checked at
   * subscribe time can do that.
   */
  it("explains itself when the organisation cannot use the feature", async () => {
    const token = await tokenFor();
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { subscriptionTier: "free" },
    });

    const ics = await service.feedFor(token);

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("not available on this plan");
    expect(ics).not.toContain("Morning prep");
  });

  /*
   * A suspension has to reach the feed, or it is the one read that carries on
   * leaving the building after the organisation has been stopped — no session,
   * no audit entry, and nobody aware it is still delivering.
   */
  it("pauses when the organisation is suspended", async () => {
    await shiftFor(tenant.staff.membershipId, 3, "accepted");
    const token = await tokenFor();
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { status: "suspended" },
    });

    const ics = await service.feedFor(token);

    expect(ics).toContain("paused");
    expect(ics).not.toContain("Morning prep");
  });

  /*
   * And says nothing about the plan while doing it. A suspended organisation's
   * billing state is nobody's business but theirs, so "not currently active" is
   * the true statement that gives away least.
   */
  it("does not mention billing when suspended", async () => {
    const token = await tokenFor();
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { status: "suspended", subscriptionTier: "free" },
    });

    const ics = await service.feedFor(token);

    expect(ics).toContain("paused");
    expect(ics).not.toContain("not available on this plan");
  });

  it("says access has ended for a deactivated member", async () => {
    await shiftFor(tenant.staff.membershipId, 3, "accepted");
    const token = await tokenFor();
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { status: "inactive" },
    });

    const ics = await service.feedFor(token);

    expect(ics).toContain("has ended");
    // And their shifts are gone, which is the point of the check.
    expect(ics).not.toContain("Morning prep");
  });

  /*
   * Deactivation is checked BEFORE the plan. Somebody who has left keeps the
   * URL in their phone, and "your access has ended" is both true and more
   * useful to them than anything about their former employer's billing.
   */
  it("prefers the access message when both apply", async () => {
    const token = await tokenFor();
    await prisma.organization.update({
      where: { id: tenant.orgId },
      data: { subscriptionTier: "free" },
    });
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { status: "inactive" },
    });

    const ics = await service.feedFor(token);

    expect(ics).toContain("has ended");
    expect(ics).not.toContain("not available on this plan");
  });
});
