/**
 * Asking a member to review their own availability.
 *
 * The dashboard used to recommend "Update Alex's availability" and link to a
 * page that shows the manager THEIR OWN schedule — an action nobody could
 * take, attached to a claim the data does not support. This is the honest
 * replacement: the question goes to the person who owns the constraint.
 *
 * What these tests pin is mostly what it must NOT do — assert the availability
 * is wrong, change anything, or reach across tenants.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AvailabilityService } from "@/services/availability.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const availability = new AvailabilityService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("avreq");
});

describe("requestAvailabilityReview", () => {
  it("notifies the member, naming who asked", async () => {
    await availability.requestAvailabilityReview(
      tenant.orgId,
      tenant.staff.userId,
      "Sarah Chen",
      tenant.manager.userId
    );

    const notes = await prisma.notification.findMany({
      where: { userId: tenant.staff.userId, type: "availability_review_requested" },
    });

    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain("Sarah Chen");
  });

  // The whole point of the rewrite. Repeated declines citing schedule
  // conflicts do not establish that a stored schedule is stale — the person
  // may simply be busy — so the message asks rather than accuses.
  it("does not claim the availability is wrong", async () => {
    await availability.requestAvailabilityReview(
      tenant.orgId,
      tenant.staff.userId,
      "Sarah Chen"
    );

    const note = await prisma.notification.findFirstOrThrow({
      where: { userId: tenant.staff.userId },
    });

    expect(`${note.title} ${note.message}`).not.toMatch(
      /out of date|incorrect|wrong|stale/i
    );
  });

  it("changes no availability record", async () => {
    await prisma.availability.create({
      data: {
        membershipId: tenant.staff.membershipId,
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "17:00",
        isAvailable: true,
      },
    });

    await availability.requestAvailabilityReview(
      tenant.orgId,
      tenant.staff.userId,
      "Sarah Chen"
    );

    const rows = await prisma.availability.findMany({
      where: { membershipId: tenant.staff.membershipId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].startTime).toBe("09:00");
    expect(rows[0].isAvailable).toBe(true);
  });

  it("records who asked", async () => {
    await availability.requestAvailabilityReview(
      tenant.orgId,
      tenant.staff.userId,
      "Sarah Chen",
      tenant.manager.userId
    );

    const logs = await prisma.auditLog.findMany({
      where: { action: "membership.availability_review_requested" },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(tenant.manager.userId);
  });

  // The user id arrives in a URL, so belonging to this organisation has to be
  // proved rather than assumed.
  it("refuses a member of another organisation", async () => {
    const other = await createTenant("avreq-other");

    await expect(
      availability.requestAvailabilityReview(
        tenant.orgId,
        other.staff.userId,
        "Sarah Chen"
      )
    ).rejects.toThrow("Member not found");

    const leaked = await prisma.notification.count({
      where: { userId: other.staff.userId },
    });
    expect(leaked).toBe(0);
  });

  it("refuses a user who is in no organisation at all", async () => {
    const outsider = await prisma.user.findUniqueOrThrow({
      where: { email: tenant.outsider.email },
    });

    await expect(
      availability.requestAvailabilityReview(tenant.orgId, outsider.id, "Sarah Chen")
    ).rejects.toThrow("Member not found");
  });
});
