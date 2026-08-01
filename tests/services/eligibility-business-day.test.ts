/**
 * Daily and weekly caps, judged against BUSINESS days rather than calendar days.
 *
 * Two defects are pinned here, and they are opposites — which is why the old
 * behaviour looked plausible for so long.
 *
 *   1. OVER-COUNT. The candidate task's WHOLE duration was added to a total
 *      that had already been clipped to the day. A 20:00–02:00 shift charged
 *      all six hours to the day it began; a three-day task charged all 72
 *      against a DAILY cap. People were refused shifts for hours they would
 *      work tomorrow.
 *
 *   2. UNDER-CHECK. Only the window containing the task's START was examined,
 *      so hours spilling into the next day were never tested against that day's
 *      cap at all. Genuine overloading of tomorrow went unnoticed. This is the
 *      more dangerous of the two: a refused shift is an argument, an unnoticed
 *      breach is a tired person on a shift they should not be on.
 *
 * On top of both, `CompanySettings.operatingHoursStart` is now the boundary
 * between one day and the next. A restaurant's Friday ends when the kitchen
 * closes at 2am, not at midnight; judged against midnight, a single overnight
 * shift is split across two days and neither total matches what anybody who
 * worked it would say.
 *
 * Members are full-time so the availability dimension always passes, isolating
 * the hour arithmetic. Fixtures are stated in Singapore wall-clock time so the
 * suite gives the same answer under TZ=Asia/Singapore and TZ=UTC.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EligibilityService } from "@/services/eligibility.service";
import { TaskRepository } from "@/repositories/task.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { sgt } from "../helpers/time";

const eligibilityService = new EligibilityService();
const taskRepo = new TaskRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let adminUserId: string;
let staffMembershipId: string;

/** 2026-06-15 is a Monday; 06-21 is the Sunday that closes that week. */
const MON = "2026-06-15";
const TUE = "2026-06-16";
const THU = "2026-06-18";
const SUN = "2026-06-21";
const NEXT_MON = "2026-06-22";

beforeEach(async () => {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create({ name: "Acme Corp", slug: "acme-corp" }, admin.id);
  orgId = org.id;

  const staff = await userRepo.create({
    name: "Staff User",
    email: "staff@example.com",
    hashedPassword: "hash",
  });
  const membership = await prisma.membership.create({
    data: {
      userId: staff.id,
      organizationId: org.id,
      role: "staff",
      status: "active",
      employmentType: "full_time",
    },
  });
  staffMembershipId = membership.id;
});

/**
 * Company settings with an explicit day boundary. Default 0 = midnight, which
 * is the behaviour every organisation had before the boundary was configurable.
 */
async function settingsWithDayStart(dayStartHour: number) {
  await prisma.companySettings.create({
    data: {
      organizationId: orgId,
      // High enough that the rolling break rule never interferes with the cap
      // being tested.
      breakRuleHoursWorked: 100,
      operatingHoursStart: dayStartHour,
      operatingHoursEnd: dayStartHour,
    },
  });
}

async function dailyRule(maxHours: number) {
  await prisma.workRule.create({
    data: {
      organizationId: orgId,
      name: "Daily cap",
      type: "max_hours_daily",
      maxHours,
      isActive: true,
    },
  });
}

async function weeklyRule(maxHours: number) {
  await prisma.workRule.create({
    data: {
      organizationId: orgId,
      name: "Weekly cap",
      type: "max_hours_weekly",
      maxHours,
      isActive: true,
    },
  });
}

/** A task the staff member is already committed to. */
async function committed(startIso: string, endIso: string) {
  const task = await taskRepo.create({
    title: `Committed ${startIso}`,
    organizationId: orgId,
    createdById: adminUserId,
    scheduledStart: sgt(startIso),
    scheduledEnd: sgt(endIso),
  });
  await prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: staffMembershipId,
      assignedById: adminUserId,
      status: "accepted",
    },
  });
  return task;
}

/** A candidate task the staff member is NOT yet assigned to. */
async function candidate(startIso: string, endIso: string) {
  return taskRepo.create({
    title: "Candidate shift",
    organizationId: orgId,
    createdById: adminUserId,
    scheduledStart: sgt(startIso),
    scheduledEnd: sgt(endIso),
  });
}

async function workRulesCheck(taskId: string) {
  const results = await eligibilityService.checkEligibilityForTask(taskId, orgId);
  return results.find((r) => r.membershipId === staffMembershipId)!.checks.workRules;
}

describe("Daily cap — the candidate task is clipped to each day", () => {
  it("does not charge an overnight shift's whole length to the day it starts", async () => {
    await settingsWithDayStart(0);
    await dailyRule(5);

    // 20:00 Monday to 02:00 Tuesday: six hours, but only four of them are
    // Monday's and two are Tuesday's. Neither day breaches a 5h cap. The old
    // code added all six to Monday and refused the shift.
    const task = await candidate(`${MON}T20:00`, `${TUE}T02:00`);

    expect((await workRulesCheck(task.id)).eligible).toBe(true);
  });

  it("quotes the hours for the day, not the task's whole length", async () => {
    await settingsWithDayStart(0);
    await dailyRule(10);

    // A three-day task. Monday's share is 14 hours (10:00 to midnight), which
    // does breach a 10h cap — but the message must say 14, not 72, or nobody
    // can reconcile it with the roster.
    const task = await candidate(`${MON}T10:00`, `${THU}T10:00`);

    const check = await workRulesCheck(task.id);
    expect(check.eligible).toBe(false);
    expect(check.reason).toContain("14.0h");
    expect(check.reason).not.toContain("72.0h");
  });

  it("still blocks a single-day shift that genuinely breaches the cap", async () => {
    // The clipping must not become a way to slip past the rule.
    await settingsWithDayStart(0);
    await dailyRule(8);
    await committed(`${MON}T09:00`, `${MON}T17:00`); // 8h

    const task = await candidate(`${MON}T18:00`, `${MON}T21:00`); // +3h = 11

    expect((await workRulesCheck(task.id)).eligible).toBe(false);
  });
});

describe("Daily cap — every day the task touches is checked", () => {
  it("blocks on the SECOND day when that is the day being overloaded", async () => {
    await settingsWithDayStart(0);
    await dailyRule(8);
    // Tuesday is already full.
    await committed(`${TUE}T09:00`, `${TUE}T17:00`); // 8h

    // Monday 22:00 to Tuesday 04:00. Monday takes 2h and is fine; Tuesday takes
    // 4h on top of 8 already committed. The old code only ever looked at
    // Monday, so this passed and Tuesday quietly went to 12 hours.
    const task = await candidate(`${MON}T22:00`, `${TUE}T04:00`);

    const check = await workRulesCheck(task.id);
    expect(check.eligible).toBe(false);
    expect(check.reason).toContain(TUE);
  });

  it("names the day it objects to", async () => {
    await settingsWithDayStart(0);
    await dailyRule(8);
    await committed(`${TUE}T09:00`, `${TUE}T17:00`);

    const task = await candidate(`${MON}T22:00`, `${TUE}T04:00`);

    // Without a date the message is unactionable when a task spans days: "would
    // total 12h that day" leaves the reader to work out which day.
    expect((await workRulesCheck(task.id)).reason).toMatch(/12\.0h on 2026-06-16/);
  });

  it("allows a spanning task when neither day breaches the cap", async () => {
    await settingsWithDayStart(0);
    await dailyRule(8);
    await committed(`${TUE}T09:00`, `${TUE}T13:00`); // 4h

    const task = await candidate(`${MON}T22:00`, `${TUE}T04:00`); // Mon 2h, Tue 4h → 8

    expect((await workRulesCheck(task.id)).eligible).toBe(true);
  });
});

describe("The day boundary is the organisation's, not midnight", () => {
  it("counts a late shift against the day it belongs to operationally", async () => {
    // Boundary at 06:00: Monday's business day runs 06:00 Mon → 06:00 Tue, so
    // an overnight shift is ONE day's work rather than two half-days.
    await settingsWithDayStart(6);
    await dailyRule(10);
    await committed(`${MON}T09:00`, `${MON}T17:00`); // 8h, Monday

    // 22:00 Mon → 02:00 Tue. All four hours are still Monday's business day →
    // 12h, over the cap.
    const task = await candidate(`${MON}T22:00`, `${TUE}T02:00`);

    expect((await workRulesCheck(task.id)).eligible).toBe(false);
  });

  it("allows the identical shift when the boundary is midnight", async () => {
    // The contrast that proves the previous test is the SETTING and not a
    // coincidence. Same shifts, same cap, boundary moved: Monday takes 8 + 2 =
    // 10 (at the cap, not over) and Tuesday takes 2.
    await settingsWithDayStart(0);
    await dailyRule(10);
    await committed(`${MON}T09:00`, `${MON}T17:00`);

    const task = await candidate(`${MON}T22:00`, `${TUE}T02:00`);

    expect((await workRulesCheck(task.id)).eligible).toBe(true);
  });
});

describe("Weekly cap — clipped to the business week", () => {
  it("does not charge a week-straddling shift entirely to the first week", async () => {
    await settingsWithDayStart(0);
    await weeklyRule(46);

    // 40 hours already committed Monday to Friday.
    for (const day of ["15", "16", "17", "18", "19"]) {
      await committed(`2026-06-${day}T09:00`, `2026-06-${day}T17:00`);
    }

    // Sunday 20:00 → Monday 04:00: four hours close the week, four open the
    // next. The old code added all eight to the first week (48 > 46) and
    // refused it.
    const task = await candidate(`${SUN}T20:00`, `${NEXT_MON}T04:00`);

    expect((await workRulesCheck(task.id)).eligible).toBe(true);
  });

  it("still blocks when the first week genuinely breaches the cap", async () => {
    await settingsWithDayStart(0);
    await weeklyRule(42);

    for (const day of ["15", "16", "17", "18", "19"]) {
      await committed(`2026-06-${day}T09:00`, `2026-06-${day}T17:00`); // 40h
    }

    const task = await candidate(`${SUN}T20:00`, `${NEXT_MON}T04:00`); // +4h = 44

    expect((await workRulesCheck(task.id)).eligible).toBe(false);
  });
});

describe("getHoursOnDate — attribution follows the boundary", () => {
  beforeEach(async () => {
    // A shift in the small hours of Monday: 02:00 to 06:00.
    await committed(`${MON}T02:00`, `${MON}T06:00`);
  });

  it("attributes small-hours work to Monday when the day starts at midnight", async () => {
    const hours = await eligibilityService.getHoursOnDate(
      staffMembershipId,
      sgt(`${MON}T12:00`),
      undefined,
      undefined,
      0
    );
    expect(hours).toBe(4);
  });

  it("attributes the same work to SUNDAY when the day starts at 06:00", async () => {
    // The point of the whole exercise: 2am Monday is Sunday night's work.
    const hours = await eligibilityService.getHoursOnDate(
      staffMembershipId,
      sgt(`2026-06-14T12:00`),
      undefined,
      undefined,
      6
    );
    expect(hours).toBe(4);
  });

  it("leaves Monday empty under a 06:00 boundary", async () => {
    const hours = await eligibilityService.getHoursOnDate(
      staffMembershipId,
      sgt(`${MON}T12:00`),
      undefined,
      undefined,
      6
    );
    expect(hours).toBe(0);
  });

  it("defaults to midnight when no boundary is supplied", async () => {
    // Every pre-existing caller relies on this: the parameter was added without
    // changing anybody's behaviour.
    const explicit = await eligibilityService.getHoursOnDate(
      staffMembershipId,
      sgt(`${MON}T12:00`),
      undefined,
      undefined,
      0
    );
    const defaulted = await eligibilityService.getHoursOnDate(
      staffMembershipId,
      sgt(`${MON}T12:00`)
    );
    expect(defaulted).toBe(explicit);
  });
});

describe("getHoursInWeek — the week is built from business days", () => {
  it("files the small hours of Monday into the week that is ending", async () => {
    // 02:00 on Monday 22nd belongs to Sunday 21st's business day under a 06:00
    // boundary, and therefore to the week Mon 15 – Sun 21. Reading the weekday
    // off the raw instant would file it under the new week, and those hours
    // would escape both weeks' caps.
    await committed(`${NEXT_MON}T02:00`, `${NEXT_MON}T06:00`);

    const closingWeek = await eligibilityService.getHoursInWeek(
      staffMembershipId,
      sgt(`2026-06-17T12:00`), // a Wednesday in the closing week
      undefined,
      undefined,
      6
    );

    expect(closingWeek).toBe(4);
  });

  it("puts the same hours in the NEW week under a midnight boundary", async () => {
    await committed(`${NEXT_MON}T02:00`, `${NEXT_MON}T06:00`);

    const closingWeek = await eligibilityService.getHoursInWeek(
      staffMembershipId,
      sgt(`2026-06-17T12:00`),
      undefined,
      undefined,
      0
    );

    expect(closingWeek).toBe(0);
  });
});
