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

const service = new AvailabilityService();
const repo = new AvailabilityRepository();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("avdel");
});

async function makeOverride(
  membershipId: string,
  isAvailable = false,
  date = new Date("2026-08-14T00:00:00.000Z")
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
      new Date("2026-08-14T00:00:00.000Z")
    );
    const second = await makeOverride(
      tenant.staff.membershipId,
      false,
      new Date("2026-08-21T00:00:00.000Z")
    );

    await service.deleteOverride(first.id);

    expect(await repo.getOverrideById(second.id)).not.toBeNull();
  });

  /*
   * The weekly pattern is what an override suspends, so removing the override
   * has to hand the date back to it rather than leave the member unavailable.
   */
  it("returns the date to the weekly schedule", async () => {
    // Friday 14 August 2026, available 09:00–17:00 by the weekly pattern.
    await prisma.availability.create({
      data: {
        membershipId: tenant.staff.membershipId,
        dayOfWeek: 5,
        startTime: "09:00",
        endTime: "17:00",
        isAvailable: true,
      },
    });
    const date = new Date("2026-08-14T10:00:00+08:00");

    const created = await makeOverride(
      tenant.staff.membershipId,
      false,
      new Date("2026-08-14T00:00:00.000Z")
    );
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

describe("the route is what enforces ownership", () => {
  /*
   * The security-relevant half. Overrides are personal, so there is no
   * permission to check — the question is whether the row belongs to the
   * caller's own membership. Answering 403 rather than 404 for somebody else's
   * would confirm it exists.
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
