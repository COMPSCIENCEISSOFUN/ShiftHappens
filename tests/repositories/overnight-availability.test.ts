/**
 * Shifts that cross midnight.
 *
 * ## The bug
 *
 * Availability windows and shift times are "HH:mm" STRINGS, compared lexically.
 * An overnight shift ends at a smaller string than it starts, so
 *
 *     startTime < schedule.startTime   "22:00" < "09:00"   false
 *     endTime   > schedule.endTime     "02:00" > "17:00"   false
 *
 * neither branch fired and the member came back AVAILABLE — for any window, on
 * any day, regardless of what they had declared. For a venue that closes after
 * midnight this is the closing shift, not an exotic case.
 *
 * ## The fix, and what it costs
 *
 * A shift ending before it starts occupies two calendar days, so it is split
 * and each half checked against that day's own override and window. That is the
 * truthful reading of the data — and it makes people INELIGIBLE who were
 * previously (wrongly) eligible, because somebody free until 23:00 on Saturday
 * has said nothing at all about Sunday morning.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const repo = new AvailabilityRepository();

/** Saturday 8 August 2026, in Singapore time. */
const SATURDAY = new Date("2026-08-08T20:00:00+08:00");

let tenant: Tenant;
let member: string;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("overnight");
  member = tenant.staff.membershipId;
});

/** dayOfWeek: 6 = Saturday, 0 = Sunday. */
async function available(dayOfWeek: number, startTime: string, endTime: string) {
  await prisma.availability.create({
    data: { membershipId: member, dayOfWeek, startTime, endTime, isAvailable: true },
  });
}

const check = (startTime: string, endTime: string) =>
  repo.isAvailableAt(member, SATURDAY, startTime, endTime);

describe("the shift that used to slip through", () => {
  it("refuses a 22:00–02:00 shift from someone available 09:00–17:00", async () => {
    await available(6, "09:00", "17:00");

    const result = await check("22:00", "02:00");
    expect(result.available).toBe(false);
  });

  // The regression test in its plainest form: before the fix this returned
  // available for EVERY window, so the assertion is that the window is now
  // consulted at all.
  it("consults the window rather than waving the shift through", async () => {
    await available(6, "09:00", "17:00");
    await available(0, "00:00", "06:00");

    // Still refused: Saturday 22:00 is outside 09:00–17:00, even though the
    // Sunday half would pass on its own.
    expect((await check("22:00", "02:00")).available).toBe(false);
  });
});

describe("both halves have to hold", () => {
  it("accepts when the member covers the evening and the morning after", async () => {
    await available(6, "18:00", "23:59");
    await available(0, "00:00", "06:00");

    expect((await check("22:00", "02:00")).available).toBe(true);
  });

  /*
   * The half that is easy to forget. Somebody free until 23:59 on Saturday has
   * said nothing about Sunday — and before the fix they were rostered into it
   * silently.
   */
  it("refuses when the member has no availability after midnight", async () => {
    await available(6, "18:00", "23:59");

    const result = await check("22:00", "02:00");
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/After midnight/);
  });

  it("refuses when the evening half falls outside the window", async () => {
    await available(6, "18:00", "21:00");
    await available(0, "00:00", "06:00");

    expect((await check("22:00", "02:00")).available).toBe(false);
  });

  /*
   * "23:59" is the end of the day, not "24:00". A window's end comes from an
   * `<input type="time">` and can never exceed 23:59, so comparing the first
   * half against "24:00" would fail exactly the person who declared themselves
   * free right up to midnight.
   */
  it("treats a window ending 23:59 as covering the run to midnight", async () => {
    await available(6, "22:00", "23:59");
    await available(0, "00:00", "02:00");

    expect((await check("22:00", "02:00")).available).toBe(true);
  });
});

describe("the day after is a real day", () => {
  // An override on the Sunday has to be found, or booking a day off could be
  // walked around by starting the shift the previous evening.
  it("honours an approved override on the second day", async () => {
    await available(6, "18:00", "23:59");
    await available(0, "00:00", "06:00");
    await repo.createOverride({
      membershipId: member,
      date: new Date("2026-08-09T00:00:00.000Z"), // the Sunday
      isAvailable: false,
      reason: "Family commitment",
      status: "approved",
    });

    const result = await check("22:00", "02:00");
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/After midnight/);
  });

  it("ignores a pending one, like everywhere else", async () => {
    await available(6, "18:00", "23:59");
    await available(0, "00:00", "06:00");
    await repo.createOverride({
      membershipId: member,
      date: new Date("2026-08-09T00:00:00.000Z"),
      isAvailable: false,
      reason: "Requested, not yet approved",
      status: "pending",
    });

    expect((await check("22:00", "02:00")).available).toBe(true);
  });

  it("says which half failed", async () => {
    await available(6, "18:00", "23:59");

    // "Available 09:00–17:00 only" against a shift starting at 22:00 reads as
    // nonsense until you know it is describing Sunday.
    expect((await check("22:00", "02:00")).reason).toContain("After midnight");
  });
});

describe("ordinary shifts are untouched", () => {
  it("still accepts one inside the window", async () => {
    await available(6, "09:00", "17:00");
    expect((await check("10:00", "14:00")).available).toBe(true);
  });

  it("still refuses one outside it", async () => {
    await available(6, "09:00", "17:00");
    expect((await check("18:00", "20:00")).available).toBe(false);
  });

  it("still refuses when no availability is set for the day", async () => {
    const result = await check("10:00", "14:00");
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/No availability set/);
  });
});
