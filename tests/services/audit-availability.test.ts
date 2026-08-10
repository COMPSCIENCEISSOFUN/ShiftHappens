/**
 * A member changing their own availability leaves a trace.
 *
 * Availability decides who the engine will consider. The two events AROUND it
 * were already recorded — a manager waiving it, a manager asking for a refresh
 * — and the edit itself was not, so "why was this person eligible on Tuesday"
 * was answerable only where somebody had intervened, and a pattern quietly
 * changed to avoid a shift left no trace at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AvailabilityService } from "@/services/availability.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { eventuallyAtLeast, pauseForAbsence } from "../helpers/settle";

const availability = new AvailabilityService();

let tenant: Tenant;

const WEEK = [
  { dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isAvailable: true },
  { dayOfWeek: 2, startTime: "09:00", endTime: "17:00", isAvailable: false },
];

function entries(action: string) {
  return prisma.auditLog.findMany({
    where: { organizationId: tenant.orgId, action },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("audit-avail");
});

describe("a member setting their own pattern", () => {
  it("records one entry for the save, not one per day", async () => {
    await availability.setWeeklySchedule(tenant.staff.membershipId, WEEK);

    const rows = await eventuallyAtLeast(
      () => entries("availability.updated"),
      1
    );

    /*
     * ONE, over a two-day save. Logging inside the per-day writer would give
     * seven rows for an ordinary week and bury every other event in the log —
     * the same reason the ineligibility check runs once per save rather than
     * once per day.
     */
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(tenant.staff.userId);
    expect(rows[0].entityType).toBe("availability");
    expect(rows[0].entityId).toBe(tenant.staff.membershipId);
  });

  /**
   * The days are the point.
   *
   * "Availability changed" tells a reader that something happened; "Tuesday
   * became unavailable" tells them why somebody stopped being eligible for
   * Tuesday's shift, which is the question the entry exists to answer.
   */
  it("records which days changed and how", async () => {
    await availability.setWeeklySchedule(tenant.staff.membershipId, WEEK);

    const rows = await eventuallyAtLeast(
      () => entries("availability.updated"),
      1
    );
    const days = (rows[0].details as { days: { dayOfWeek: number; isAvailable: boolean }[] })
      .days;

    expect(days).toHaveLength(2);
    expect(days.find((d) => d.dayOfWeek === 2)?.isAvailable).toBe(false);
  });
});

describe("the employer-set path is a different act", () => {
  /**
   * `setContractedDaysForUser` already raises `CONTRACTED_DAYS_SET` and shares
   * the same underlying writer. Logging in the shared helper would have written
   * two entries for one save and described an admin's action as the member's
   * own — the same conflation `member.role_changed` carried until it was split.
   */
  it("does not also record it as the member's own change", async () => {
    await availability.setContractedDaysForUser(
      tenant.orgId,
      tenant.staff.userId,
      WEEK,
      tenant.admin.userId
    );

    await eventuallyAtLeast(() => entries("membership.contracted_days_set"), 1);
    expect(await entries("availability.updated")).toHaveLength(0);
  });
});

describe("a refusal writes nothing", () => {
  it("records no change when a full-time member is turned away", async () => {
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { employmentType: "full_time" },
    });

    await expect(
      availability.setWeeklySchedule(tenant.staff.membershipId, WEEK)
    ).rejects.toThrow("Contracted days are set by your organisation");

    // Absence, so a pause rather than polling — see helpers/settle.ts.
    await pauseForAbsence();
    expect(await entries("availability.updated")).toHaveLength(0);
  });
});
