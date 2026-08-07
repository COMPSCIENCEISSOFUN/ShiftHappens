/**
 * Two documented limitations, now removed.
 *
 * **A window could not cross midnight.** `setDayAvailability` refused
 * `startTime >= endTime`, so a genuine night worker could not declare
 * 22:00–06:00 — they had to split it across two days themselves and hope both
 * halves were read together. Only the SHIFT could wrap, which for a venue
 * closing after midnight is precisely the closing shift.
 *
 * **Overrides for past dates were accepted.** `isAvailableAt` is only ever
 * asked about a shift being scheduled, so an override for last Tuesday was read
 * by nothing — and the form reported success, which is the worst of both: no
 * effect, and no way to tell that from an effect.
 *
 * Deliberately NOT fixed here, and still documented: several windows per day.
 * That is a schema change plus eight call sites that each assume
 * `find(w => w.dayOfWeek === day)` returns THE window, and it is separable from
 * the two above.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { PUT as setOwnSchedule } from "@/app/api/organizations/[orgId]/availability/route";
import { asUser } from "../helpers/session";
import { ctx, jsonReq } from "../helpers/route";

import { AvailabilityService } from "@/services/availability.service";
import {
  AvailabilityRepository,
  overrideDateKey,
} from "@/repositories/availability.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new AvailabilityService();
const repo = new AvailabilityRepository();

let tenant: Tenant;
let member: string;

/** A Friday well clear of today, at 10:00 Singapore. */
const FRIDAY = new Date("2026-09-11T02:00:00.000Z");
const FRIDAY_DOW = 5;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("limits");
  member = tenant.staff.membershipId;
});

async function declare(startTime: string, endTime: string, dayOfWeek = FRIDAY_DOW) {
  return service.setDayAvailability(member, {
    dayOfWeek,
    startTime,
    endTime,
    isAvailable: true,
  });
}

describe("declaring a window that runs past midnight", () => {
  it("is accepted", async () => {
    const saved = await declare("22:00", "06:00");
    expect(saved.startTime).toBe("22:00");
    expect(saved.endTime).toBe("06:00");
  });

  /*
   * A window of no length is still refused, which is why the check was narrowed
   * rather than deleted. 09:00–09:00 is what an empty form or a mis-clicked
   * picker produces, and it would read as "available" for a period nobody can
   * be rostered in.
   */
  it("but a window of no length is not", async () => {
    await expect(declare("09:00", "09:00")).rejects.toThrow(
      /cannot be the same/
    );
  });

  it("covers a shift inside its evening half", async () => {
    await declare("22:00", "06:00");
    const check = await repo.isAvailableAt(member, FRIDAY, "22:30", "23:30");
    expect(check.available).toBe(true);
  });

  it("covers a shift inside its morning half", async () => {
    await declare("22:00", "06:00");
    const check = await repo.isAvailableAt(member, FRIDAY, "01:00", "05:00");
    expect(check.available).toBe(true);
  });

  /*
   * The case the whole limitation was about: a closing shift that crosses
   * midnight, against a window that also crosses midnight. Both halves have to
   * land, and the shift's second half is checked against the NEXT day — so the
   * declaration has to exist there too.
   */
  it("covers a shift that crosses midnight with it", async () => {
    await declare("22:00", "06:00", FRIDAY_DOW);
    await declare("22:00", "06:00", (FRIDAY_DOW + 1) % 7);

    const check = await repo.isAvailableAt(member, FRIDAY, "23:00", "02:00");
    expect(check.available).toBe(true);
  });

  // The window still means something — it is not "available for anything".
  it("refuses a shift in the middle of their night off", async () => {
    await declare("22:00", "06:00");
    const check = await repo.isAvailableAt(member, FRIDAY, "12:00", "16:00");
    expect(check.available).toBe(false);
  });

  it("leaves an ordinary daytime window behaving exactly as before", async () => {
    await declare("09:00", "17:00");

    expect((await repo.isAvailableAt(member, FRIDAY, "10:00", "16:00")).available).toBe(
      true
    );
    expect((await repo.isAvailableAt(member, FRIDAY, "08:00", "10:00")).available).toBe(
      false
    );
    expect((await repo.isAvailableAt(member, FRIDAY, "16:00", "18:00")).available).toBe(
      false
    );
  });
});

describe("overrides for dates that have passed", () => {
  function daysFromNow(days: number) {
    return overrideDateKey(new Date(Date.now() + days * 86_400_000)).toISOString();
  }

  it("are refused", async () => {
    await expect(
      service.createOverride(member, { date: daysFromNow(-1), isAvailable: false })
    ).rejects.toThrow(/already passed/);
  });

  it("write nothing when refused", async () => {
    await service
      .createOverride(member, { date: daysFromNow(-1), isAvailable: false })
      .catch(() => {});

    expect(
      await prisma.availabilityOverride.count({ where: { membershipId: member } })
    ).toBe(0);
  });

  /*
   * Today is not past. Somebody calling in unwell this morning is the most
   * likely use of this form, and an off-by-one that refused it would be worse
   * than the limitation being fixed.
   */
  it("but today is accepted", async () => {
    const created = await service.createOverride(member, {
      date: daysFromNow(0),
      isAvailable: false,
      reason: "Unwell",
    });
    expect(created.id).toBeTruthy();
  });

  it("and tomorrow is accepted", async () => {
    const created = await service.createOverride(member, {
      date: daysFromNow(1),
      isAvailable: false,
    });
    expect(created.id).toBeTruthy();
  });

  /*
   * Compared on the ORGANISATION's calendar day. Without `overrideDateKey` on
   * both sides, a request made early in the morning in Singapore would be
   * refused as yesterday's on a UTC host — the same class of bug the override
   * key was introduced to fix on the read side.
   */
  it("is judged on the organisation's day, not the server's", async () => {
    const todayHere = overrideDateKey(new Date());
    const created = await service.createOverride(member, {
      date: todayHere.toISOString(),
      isAvailable: false,
    });
    expect(overrideDateKey(created.date).getTime()).toBe(todayHere.getTime());
  });
});

/*
 * The routes, not just the service.
 *
 * Both of these mapped the refusal to a 400 by testing
 * `error.message.includes("End time")`. Narrowing the check changed the wording,
 * and both would have started returning 500 for a form mistake a user makes by
 * leaving a time picker alone — which is why the message is now a shared
 * constant. Asserted here because a service test cannot see a status code.
 */
describe("through the endpoint", () => {
  it("accepts a window past midnight with a 200", async () => {
    asUser(tenant.staff.userId);
    const res = await setOwnSchedule(
      jsonReq("PUT", {
        schedule: [
          { dayOfWeek: 1, startTime: "22:00", endTime: "06:00", isAvailable: true },
        ],
      }),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(200);
  });

  it("refuses a window of no length with a 400, not a 500", async () => {
    asUser(tenant.staff.userId);
    const res = await setOwnSchedule(
      jsonReq("PUT", {
        schedule: [
          { dayOfWeek: 1, startTime: "09:00", endTime: "09:00", isAvailable: true },
        ],
      }),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(400);
  });
});
