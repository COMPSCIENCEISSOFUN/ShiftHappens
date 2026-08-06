/**
 * Who decides which days a full-time member works.
 *
 * Leave requests already made a full-timer's ABSENCE a request rather than a
 * declaration — and that gate was worth nothing on its own, because the weekly
 * pattern behind it was still self-service. A contracted member who wanted
 * Wednesday off never had to ask: they could untick Wednesday, save, and be off
 * every Wednesday from then on with nobody told.
 *
 * So the pattern moved to the employer. The two assertions that matter are that
 * a full-timer is refused their own pattern, and that the refusal lives in the
 * service rather than the screen — the read-only UI is a courtesy, and a
 * hand-written PUT has to hit the same wall.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { PUT as setContractedDays } from "@/app/api/organizations/[orgId]/members/[userId]/contracted-days/route";
import { PUT as setOwnSchedule } from "@/app/api/organizations/[orgId]/availability/route";
import { asUser } from "../helpers/session";
import { ctx, jsonReq, bodyOf } from "../helpers/route";
import { AvailabilityService } from "@/services/availability.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new AvailabilityService();

/** Monday and Wednesday, 09:00–17:00; everything else off. */
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  startTime: "09:00",
  endTime: "17:00",
  isAvailable: dayOfWeek === 1 || dayOfWeek === 3,
}));

let tenant: Tenant;
let fullTimer: { userId: string; membershipId: string };

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("contracted");

  const user = await prisma.user.create({
    data: { name: "Full Timer", email: "ft@contracted.test", hashedPassword: "h" },
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
  fullTimer = { userId: user.id, membershipId: membership.id };
});

function workingDays(rows: { dayOfWeek: number; isAvailable: boolean }[]) {
  return rows.filter((r) => r.isAvailable).map((r) => r.dayOfWeek).sort();
}

describe("a member setting their own pattern", () => {
  it("refuses a full-time member", async () => {
    await expect(
      service.setWeeklySchedule(fullTimer.membershipId, WEEK)
    ).rejects.toThrow("Contracted days are set by your organisation");
  });

  it("writes nothing when it refuses", async () => {
    await service.setWeeklySchedule(fullTimer.membershipId, WEEK).catch(() => {});
    const rows = await prisma.availability.findMany({
      where: { membershipId: fullTimer.membershipId },
    });
    expect(rows).toHaveLength(0);
  });

  it("still allows a casual member — their availability is theirs to give", async () => {
    await service.setWeeklySchedule(tenant.staff.membershipId, WEEK);
    const rows = await service.getWeeklySchedule(tenant.staff.membershipId);
    expect(workingDays(rows)).toEqual([1, 3]);
  });

  /*
   * The screen renders read-only for a full-timer, which stops the honest
   * caller and nobody else. This is the assertion that the lock is real.
   */
  it("refuses over HTTP with 403, not a 500", async () => {
    asUser(fullTimer.userId);

    const res = await setOwnSchedule(
      jsonReq("PUT", { schedule: WEEK }),
      ctx({ orgId: tenant.orgId })
    );

    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({
      error: "Contracted days are set by your organisation",
    });
  });
});

describe("an admin setting somebody else's", () => {
  it("writes the pattern", async () => {
    await service.setContractedDaysForUser(
      tenant.orgId,
      fullTimer.userId,
      WEEK,
      tenant.admin.userId,
      null
    );
    const rows = await service.getWeeklySchedule(fullTimer.membershipId);
    expect(workingDays(rows)).toEqual([1, 3]);
  });

  it("records who did it", async () => {
    await service.setContractedDaysForUser(
      tenant.orgId,
      fullTimer.userId,
      WEEK,
      tenant.admin.userId,
      null
    );

    // Fire-and-forget, so the write may land after the call returns.
    await vi.waitFor(async () => {
      const entry = await prisma.auditLog.findFirst({
        where: { action: "membership.contracted_days_set" },
      });
      expect(entry).toMatchObject({
        userId: tenant.admin.userId,
        entityId: fullTimer.membershipId,
      });
    });
  });

  it("rejects a user who is not in the organisation", async () => {
    await expect(
      service.setContractedDaysForUser(tenant.orgId, tenant.outsider.userId, WEEK)
    ).rejects.toThrow("Member not found");
  });

  /*
   * Reported as "not found" rather than "forbidden" on purpose — the same
   * convention seniority uses. A scoped caller must not be able to learn who
   * exists in departments they cannot see.
   */
  it("hides a member outside the caller's departments", async () => {
    const other = await prisma.department.create({
      data: { name: "Other", organizationId: tenant.orgId },
    });

    await expect(
      service.setContractedDaysForUser(
        tenant.orgId,
        fullTimer.userId,
        WEEK,
        tenant.admin.userId,
        [other.id]
      )
    ).rejects.toThrow("Member not found");
  });

  it("allows a scoped caller inside their own departments", async () => {
    await service.setContractedDaysForUser(
      tenant.orgId,
      fullTimer.userId,
      WEEK,
      tenant.manager.userId,
      [tenant.departmentId]
    );
    const rows = await service.getWeeklySchedule(fullTimer.membershipId);
    expect(workingDays(rows)).toEqual([1, 3]);
  });
});

describe("the endpoint", () => {
  async function put(actorUserId: string, targetUserId: string) {
    asUser(actorUserId);
    return setContractedDays(
      jsonReq("PUT", { schedule: WEEK }),
      ctx({ orgId: tenant.orgId, userId: targetUserId })
    );
  }

  it("lets an admin through", async () => {
    const res = await put(tenant.admin.userId, fullTimer.userId);
    expect(res.status).toBe(200);
  });

  /*
   * The permission is left out of the manager grant deliberately: seniority is
   * a rostering judgement and managers hold it, but what days somebody is
   * employed to work is a term of their employment.
   */
  it("refuses a manager", async () => {
    const res = await put(tenant.manager.userId, fullTimer.userId);
    expect(res.status).toBe(403);
  });

  it("refuses the member themselves", async () => {
    const res = await put(fullTimer.userId, fullTimer.userId);
    expect(res.status).toBe(403);
  });

  it("404s for somebody outside the organisation", async () => {
    const res = await put(tenant.admin.userId, tenant.outsider.userId);
    expect(res.status).toBe(404);
  });

  it("400s on a day that runs backwards", async () => {
    asUser(tenant.admin.userId);
    const res = await setContractedDays(
      jsonReq("PUT", {
        schedule: [
          { dayOfWeek: 1, startTime: "17:00", endTime: "09:00", isAvailable: true },
        ],
      }),
      ctx({ orgId: tenant.orgId, userId: fullTimer.userId })
    );
    expect(res.status).toBe(400);
  });
});
