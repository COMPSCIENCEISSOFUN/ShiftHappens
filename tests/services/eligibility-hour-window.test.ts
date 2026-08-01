/**
 * Reproduction for the impossible hour totals seen in production, e.g.
 *
 *   "Morgan Taylor has worked 168.0h of 6h — Service break interval (2800%)"
 *
 * A ROLLING 24-HOUR WINDOW CANNOT CONTAIN 168 HOURS OF WORK. 168 is exactly
 * seven days, so the figure is arithmetically impossible rather than merely
 * surprising, which makes it a calculation bug and not odd data.
 *
 * `sumHoursInWindow` selects assignments whose interval STARTS inside the
 * window, then adds the interval's ENTIRE duration. Two errors follow, in
 * opposite directions:
 *
 *   1. OVER-COUNT — a long shift starting inside the window contributes all of
 *      its hours, including the ones outside the window. This is what produces
 *      168h in a 24h window, and it makes break rules fire on people who have
 *      not breached them.
 *
 *   2. UNDER-COUNT — a shift that started BEFORE the window but is still
 *      running is skipped entirely and contributes nothing. Someone twelve
 *      hours into an overnight shift reads as zero hours worked, so a break
 *      rule that should fire does not.
 *
 * The second is the more dangerous of the two: a missed rest-break check is a
 * safety failure, where a false alarm is only noise.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EligibilityService } from "@/services/eligibility.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const eligibilityService = new EligibilityService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

const HOUR = 60 * 60 * 1000;

let orgId: string;
let userId: string;
let membershipId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Morgan Taylor",
    email: "morgan@example.com",
    hashedPassword: "hash",
  });
  userId = user.id;

  const org = await orgRepo.create({ name: "Acme", slug: "acme" }, user.id);
  orgId = org.id;

  const staff = await userRepo.create({
    name: "Staff",
    email: "staff@example.com",
    hashedPassword: "hash",
  });
  const membership = await prisma.membership.create({
    data: { userId: staff.id, organizationId: orgId, role: "staff", status: "active" },
  });
  membershipId = membership.id;
});

/** A committed assignment on a task with the given scheduled window. */
async function shift(startOffsetHours: number, durationHours: number) {
  const start = new Date(Date.now() + startOffsetHours * HOUR);
  const end = new Date(start.getTime() + durationHours * HOUR);
  const task = await prisma.task.create({
    data: {
      title: `Shift ${startOffsetHours}h+${durationHours}h`,
      organizationId: orgId,
      createdById: userId,
      scheduledStart: start,
      scheduledEnd: end,
    },
  });
  await prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId,
      assignedById: userId,
      status: "accepted",
    },
  });
  return task.id;
}

describe("getHoursInLast24h — a 24h window can only ever contain 24 hours", () => {
  it("does not report a week-long shift as 168 hours in the last 24", async () => {
    // The exact shape from the production alert: one shift spanning seven days,
    // beginning inside the rolling window.
    await shift(-2, 168);

    const hours = await eligibilityService.getHoursInLast24h(membershipId);

    expect(hours).toBeLessThanOrEqual(24);
  });

  it("counts only the part of a long shift that falls inside the window", async () => {
    // Started 2 hours ago, runs for 48. Only the 2 hours already elapsed are
    // "worked in the last 24 hours".
    await shift(-2, 48);

    const hours = await eligibilityService.getHoursInLast24h(membershipId);

    expect(hours).toBeCloseTo(2, 1);
  });

  it("counts an overnight shift already in progress", async () => {
    // Started 12 hours ago, ends in 2. Previously skipped entirely because it
    // began before the window opened — so twelve hours of work read as zero and
    // the rest-break rule never fired.
    await shift(-12, 14);

    const hours = await eligibilityService.getHoursInLast24h(membershipId);

    expect(hours).toBeCloseTo(12, 1);
  });

  it("counts a still-running shift that began before the window opened", async () => {
    // The dangerous under-count, stated on its own. Started 30 hours ago and
    // still running: previously skipped entirely because its start fell outside
    // the window, so someone well past a rest break read as zero hours worked
    // and the rule never fired. Only the last 24 hours of it count.
    await shift(-30, 40);

    const hours = await eligibilityService.getHoursInLast24h(membershipId);

    expect(hours).toBeCloseTo(24, 1);
  });

  it("ignores a shift that finished before the window opened", async () => {
    await shift(-40, 8);

    expect(await eligibilityService.getHoursInLast24h(membershipId)).toBe(0);
  });

  it("ignores a shift entirely in the future", async () => {
    // "Hours worked in the last 24h" must not count work not yet done.
    await shift(5, 8);

    expect(await eligibilityService.getHoursInLast24h(membershipId)).toBe(0);
  });

  it("sums several overlapping-window shifts without exceeding the window", async () => {
    await shift(-20, 8);
    await shift(-10, 6);
    await shift(-2, 48);

    const hours = await eligibilityService.getHoursInLast24h(membershipId);

    expect(hours).toBeGreaterThan(0);
    expect(hours).toBeLessThanOrEqual(24);
  });
});

describe("getHoursOnDate — clipped to the calendar day", () => {
  it("does not attribute a multi-day shift entirely to its first day", async () => {
    // A shift starting today and running for three days is not 72 hours of
    // work "today", and a daily cap should not be judged as though it were.
    const start = new Date();
    start.setHours(10, 0, 0, 0);
    const task = await prisma.task.create({
      data: {
        title: "Three day shift",
        organizationId: orgId,
        createdById: userId,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 72 * HOUR),
      },
    });
    await prisma.taskAssignment.create({
      data: { taskId: task.id, membershipId, assignedById: userId, status: "accepted" },
    });

    const hours = await eligibilityService.getHoursOnDate(membershipId, new Date());

    expect(hours).toBeLessThanOrEqual(24);
  });
});

describe("Actual clocked time is still preferred over the schedule", () => {
  it("uses clock in/out when both are recorded", async () => {
    const clockIn = new Date(Date.now() - 5 * HOUR);
    const clockOut = new Date(Date.now() - 1 * HOUR);
    const task = await prisma.task.create({
      data: {
        title: "Worked shift",
        organizationId: orgId,
        createdById: userId,
        // Schedule deliberately disagrees with reality — the clock wins.
        scheduledStart: new Date(Date.now() - 10 * HOUR),
        scheduledEnd: new Date(Date.now() + 10 * HOUR),
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId,
        assignedById: userId,
        status: "completed",
        clockInTime: clockIn,
        clockOutTime: clockOut,
      },
    });

    const hours = await eligibilityService.getHoursInLast24h(membershipId);

    expect(hours).toBeCloseTo(4, 1);
  });
});
