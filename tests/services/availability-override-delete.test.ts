/**
 * Removing a date override.
 *
 * `AvailabilityService.deleteOverride` and its repository method were both
 * written — with a docblock explaining that removing an "I CAN work the 14th"
 * override NARROWS availability and so has to run the ineligibility check — and
 * nothing could reach them. There was no route. A member could add an override
 * and never take it back, including one added by mistake.
 *
 * Third instance of the same pattern in this codebase after `candidateEffect`
 * and `mondayOf`: logic written, tested, and left with no caller.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { DELETE as deleteOverride } from "@/app/api/organizations/[orgId]/availability/overrides/[overrideId]/route";
import { asUser } from "../helpers/session";
import { ctx, req } from "../helpers/route";
import { AvailabilityService } from "@/services/availability.service";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import {
  dayOfWeekInTimeZone,
  localDateInTimeZone,
  startOfDayInTimeZone,
} from "@/lib/timezone";

const service = new AvailabilityService();
const repo = new AvailabilityRepository();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("avdel");
});

/**
 * A date the lapse rule will still accept whenever this runs.
 *
 * `createOverride` refuses a date that has already passed, and reads the real
 * clock to decide. A fixed date therefore passes until the calendar reaches
 * it and fails every run afterwards. This file used 14 August 2026 and went
 * red at midnight on the 15th, having been green an hour earlier.
 */
function upcoming(weeksAhead = 1): Date {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + weeksAhead * 7);
  return new Date(`${localDateInTimeZone(day)}T00:00:00.000Z`);
}

async function makeOverride(
  membershipId: string,
  isAvailable = false,
  date = upcoming()
) {
  return service.createOverride(membershipId, {
    date: date.toISOString(),
    isAvailable,
    reason: "Medical appointment",
  });
}

describe("deleting an override", () => {
  it("removes it", async () => {
    const created = await makeOverride(tenant.staff.membershipId);

    await service.deleteOverride(created.id);

    expect(await repo.getOverrideById(created.id)).toBeNull();
  });

  it("leaves the member's other overrides alone", async () => {
    const first = await makeOverride(
      tenant.staff.membershipId,
      false,
      upcoming(1)
    );
    const second = await makeOverride(
      tenant.staff.membershipId,
      false,
      upcoming(2)
    );

    await service.deleteOverride(first.id);

    expect(await repo.getOverrideById(second.id)).not.toBeNull();
  });

  /*
   * The weekly pattern is what an override suspends, so removing the override
   * has to hand the date back to it rather than leave the member unavailable.
   */
  it("returns the date to the weekly schedule", async () => {
    // Available 09:00 to 17:00 on that weekday by the weekly pattern. The day
    // is read off the chosen date so the two cannot disagree.
    const target = upcoming();
    await prisma.availability.create({
      data: {
        membershipId: tenant.staff.membershipId,
        dayOfWeek: dayOfWeekInTimeZone(target),
        startTime: "09:00",
        endTime: "17:00",
        isAvailable: true,
      },
    });
    const date = new Date(
      startOfDayInTimeZone(target).getTime() + 10 * 60 * 60 * 1000
    );

    const created = await makeOverride(tenant.staff.membershipId, false, target);
    const blocked = await repo.isAvailableAt(
      tenant.staff.membershipId,
      date,
      "10:00",
      "14:00"
    );
    expect(blocked.available).toBe(false);

    await service.deleteOverride(created.id);

    const restored = await repo.isAvailableAt(
      tenant.staff.membershipId,
      date,
      "10:00",
      "14:00"
    );
    expect(restored.available).toBe(true);
  });

  /*
   * The service does NOT tolerate a missing id — Prisma raises and it
   * propagates. That is deliberate rather than an oversight: the route checks
   * existence and ownership first and answers 404, so by the time the service
   * is reached the row is known to exist and to belong to the caller. Asserted
   * here so the division of labour is recorded; if the service ever grows a
   * caller that has not checked, this is the test that says so.
   */
  it("assumes its caller has checked the row exists", async () => {
    const created = await makeOverride(tenant.staff.membershipId);
    await service.deleteOverride(created.id);

    await expect(service.deleteOverride(created.id)).rejects.toThrow();
  });
});

describe("the endpoint carries ownership through", () => {
  /*
   * The security-relevant half. Overrides are personal, so there is no
   * permission to check — the question is whether the row belongs to the
   * caller's own membership. Answering 403 rather than 404 for somebody else's
   * would confirm it exists.
   *
   * The check itself now lives in the SERVICE; the route used to read the
   * repository to do it, which put Boundary in touch with Entity. What these
   * assert is that the route resolves the caller's membership and hands it
   * over — a route that forgot the argument would let anyone delete anyone's.
   */
  it("refuses another member's override, and does not delete it", async () => {
    const victim = await makeOverride(tenant.manager.membershipId);

    asUser(tenant.staff.userId);
    const res = await deleteOverride(req("DELETE"), ctx({
      orgId: tenant.orgId,
      overrideId: victim.id,
    }));

    expect(res.status).toBe(404);
    expect(await repo.getOverrideById(victim.id)).not.toBeNull();
  });

  it("deletes the caller's own", async () => {
    const mine = await makeOverride(tenant.staff.membershipId);

    asUser(tenant.staff.userId);
    const res = await deleteOverride(req("DELETE"), ctx({
      orgId: tenant.orgId,
      overrideId: mine.id,
    }));

    expect(res.status).toBe(200);
    expect(await repo.getOverrideById(mine.id)).toBeNull();
  });
});

/*
 * Ownership moved out of the route, which used to read the repository to prove
 * it. Asserted here because that is where the rule lives now.
 */
describe("whose override may be deleted", () => {
  it("refuses one belonging to somebody else", async () => {
    const created = await service.createOverride(tenant.staff.membershipId, {
      date: upcoming(3).toISOString(),
      isAvailable: false,
    });

    await expect(
      service.deleteOverride(created.id, tenant.manager.membershipId)
    ).rejects.toThrow("Override not found");
  });

  it("leaves it in place when it refuses", async () => {
    const created = await service.createOverride(tenant.staff.membershipId, {
      date: upcoming(4).toISOString(),
      isAvailable: false,
    });

    await service
      .deleteOverride(created.id, tenant.manager.membershipId)
      .catch(() => {});

    expect(
      await prisma.availabilityOverride.findUnique({ where: { id: created.id } })
    ).not.toBeNull();
  });

  it("allows the owner", async () => {
    const created = await service.createOverride(tenant.staff.membershipId, {
      date: upcoming(5).toISOString(),
      isAvailable: false,
    });

    await service.deleteOverride(created.id, tenant.staff.membershipId);
    expect(
      await prisma.availabilityOverride.findUnique({ where: { id: created.id } })
    ).toBeNull();
  });

  // A named owner asserts the row is theirs; nothing there is a failed
  // assertion, not a no-op to swallow.
  it("throws rather than shrugging when the row is gone", async () => {
    await expect(
      service.deleteOverride("does-not-exist", tenant.staff.membershipId)
    ).rejects.toThrow("Override not found");
  });
});
