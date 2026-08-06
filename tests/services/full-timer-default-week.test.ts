/**
 * A full-timer starts open, not fenced in.
 *
 * Two facts collide. `availableWithinDay` treats a day with no row as
 * unavailable — silence means no — and a full-time member can no longer write
 * their own pattern. Left alone, a new contracted member is unrostearable on all
 * seven days, and the symptom is the engine reporting no candidates rather than
 * anything naming the cause.
 *
 * Seeding Monday–Friday would have been the obvious fix and the wrong one: a
 * full-timer is the person who covers the gap a casual cannot, so fencing them
 * into weekdays fences in the only flexible people on the roster. They open
 * fully, and an admin narrows them on purpose.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { AvailabilityService } from "@/services/availability.service";
import { UserManagementService } from "@/services/user-management.service";
import { InvitationService } from "@/services/invitation.service";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new AvailabilityService();
const users = new UserManagementService();
const invitations = new InvitationService();
const availRepo = new AvailabilityRepository();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("openweek");
});

function byDay(rows: { dayOfWeek: number }[]) {
  return rows.map((r) => r.dayOfWeek).sort((a, b) => a - b);
}

describe("openUnsetDays", () => {
  it("opens all seven when the member has said nothing", async () => {
    await service.openUnsetDays(tenant.staff.membershipId);

    const week = await service.getWeeklySchedule(tenant.staff.membershipId);
    expect(byDay(week)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(week.every((d) => d.isAvailable)).toBe(true);
  });

  it("opens the whole day, not office hours", async () => {
    await service.openUnsetDays(tenant.staff.membershipId);

    const week = await service.getWeeklySchedule(tenant.staff.membershipId);
    expect(week[0]).toMatchObject({ startTime: "00:00", endTime: "23:59" });
  });

  /*
   * A window ending at 23:59 rather than 23:00 or 18:00 is what lets the
   * overnight split work: the first half of a 22:00–02:00 shift is checked
   * against END_OF_DAY, and a shorter window here would rule an open day out.
   */
  it("leaves an overnight shift rosterable", async () => {
    await service.openUnsetDays(tenant.staff.membershipId);

    const result = await availRepo.isAvailableAt(
      tenant.staff.membershipId,
      new Date("2026-08-14T00:00:00.000Z"),
      "22:00",
      "02:00"
    );
    expect(result.available).toBe(true);
  });

  it("does not touch a day the member already answered", async () => {
    await prisma.availability.create({
      data: {
        membershipId: tenant.staff.membershipId,
        dayOfWeek: 3,
        startTime: "09:00",
        endTime: "17:00",
        isAvailable: true,
      },
    });

    await service.openUnsetDays(tenant.staff.membershipId);

    const week = await service.getWeeklySchedule(tenant.staff.membershipId);
    const wednesday = week.find((d) => d.dayOfWeek === 3);
    expect(wednesday).toMatchObject({ startTime: "09:00", endTime: "17:00" });
  });

  /*
   * "Not Sundays" is an answer, not a gap. Overwriting it would use a change of
   * employment type to quietly discard something the member told us — and they
   * cannot say it again afterwards, because contracted members lose the self
   * path.
   */
  it("preserves a day the member marked unavailable", async () => {
    await prisma.availability.create({
      data: {
        membershipId: tenant.staff.membershipId,
        dayOfWeek: 0,
        startTime: "09:00",
        endTime: "17:00",
        isAvailable: false,
      },
    });

    await service.openUnsetDays(tenant.staff.membershipId);

    const week = await service.getWeeklySchedule(tenant.staff.membershipId);
    expect(week.find((d) => d.dayOfWeek === 0)?.isAvailable).toBe(false);
  });

  it("is safe to run twice", async () => {
    await service.openUnsetDays(tenant.staff.membershipId);
    const second = await service.openUnsetDays(tenant.staff.membershipId);

    expect(second).toHaveLength(0);
    const week = await service.getWeeklySchedule(tenant.staff.membershipId);
    expect(week).toHaveLength(7);
  });
});

describe("becoming full-time", () => {
  it("opens the week when an admin converts a casual", async () => {
    await users.updateMemberRole(
      tenant.staff.userId,
      tenant.orgId,
      { role: "staff", employmentType: "full_time" },
      tenant.admin.userId
    );

    const week = await service.getWeeklySchedule(tenant.staff.membershipId);
    expect(byDay(week)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("leaves a casual alone", async () => {
    await users.updateMemberRole(
      tenant.staff.userId,
      tenant.orgId,
      { role: "staff", employmentType: "casual" },
      tenant.admin.userId
    );

    const week = await service.getWeeklySchedule(tenant.staff.membershipId);
    expect(week).toHaveLength(0);
  });

  it("opens the week for a full-time invitation", async () => {
    const invitation = await prisma.invitationToken.create({
      data: {
        organizationId: tenant.orgId,
        email: "newft@openweek.test",
        role: "staff",
        employmentType: "full_time",
        token: "tok-ft",
        expires: new Date(Date.now() + 86_400_000),
        invitedById: tenant.admin.userId,
      },
    });

    const { user } = await invitations.acceptInvitation(invitation.token, {
      name: "New FT",
      password: "TestPass1!",
    });

    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: user.id, organizationId: tenant.orgId },
    });
    const week = await service.getWeeklySchedule(membership.id);
    expect(byDay(week)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("leaves a casual invitation with nothing set", async () => {
    const invitation = await prisma.invitationToken.create({
      data: {
        organizationId: tenant.orgId,
        email: "newcasual@openweek.test",
        role: "staff",
        employmentType: "casual",
        token: "tok-casual",
        expires: new Date(Date.now() + 86_400_000),
        invitedById: tenant.admin.userId,
      },
    });

    const { user } = await invitations.acceptInvitation(invitation.token, {
      name: "New Casual",
      password: "TestPass1!",
    });

    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: user.id, organizationId: tenant.orgId },
    });
    expect(await service.getWeeklySchedule(membership.id)).toHaveLength(0);
  });
});
