/**
 * The rest-gap rule must give the same answer whichever shift was created first.
 *
 * The two-sided check was written for exactly this: a manager does not build a
 * roster strictly forwards, so a rule that only looks backwards can be walked
 * around by entering the pair in the other order. Checking both sides removed
 * that — but the THRESHOLD was still applied to the neighbour on both sides,
 * and the threshold is what decides whether the rule engages at all.
 *
 * Under "11h rest after 8h worked", one pair of shifts:
 *
 *     Mon 08:00–18:00 (10h)   ·   2h gap   ·   Mon 20:00–22:00 (2h)
 *
 * The rest is earned by the FIRST of the two, because that is the one that was
 * worked. Gating on the neighbour asks the wrong shift's length whenever the
 * proposed shift comes first, so the pair was refused one way round and allowed
 * the other — the very order-dependence the two-sided check exists to remove.
 *
 * These tests assert the pair, not the direction: same two shifts, both
 * insertion orders, same verdict.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EligibilityService } from "@/services/eligibility.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { sgt } from "../helpers/time";

const eligibilityService = new EligibilityService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let adminUserId: string;
let membershipId: string;

beforeEach(async () => {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create({ name: "Acme", slug: "acme-order" }, admin.id);
  orgId = org.id;

  const staff = await userRepo.create({
    name: "Staff",
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
  membershipId = membership.id;

  // Both hour dimensions out of the way; this file is about the rest gap alone.
  await prisma.companySettings.create({
    data: { organizationId: org.id, workingDayHours: 100 },
  });
  await prisma.workRule.create({
    data: {
      organizationId: org.id,
      name: "Daily rest",
      type: "break_interval",
      hoursThreshold: 8,
      breakHours: 11,
      isActive: true,
    },
  });
});

function at(dayOffset: number, startHour: number, endHour: number) {
  const date = String(15 + dayOffset).padStart(2, "0");
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: sgt(`2026-07-${date}T${pad(startHour)}:00`),
    end: sgt(`2026-07-${date}T${pad(endHour)}:00`),
  };
}

async function makeTask(title: string, when: { start: Date; end: Date }) {
  return prisma.task.create({
    data: {
      title,
      organizationId: orgId,
      createdById: adminUserId,
      requiredHeadcount: 1,
      status: "open",
      scheduledStart: when.start,
      scheduledEnd: when.end,
    },
  });
}

async function assignTo(taskId: string) {
  await prisma.taskAssignment.create({
    data: {
      taskId,
      membershipId,
      assignedById: adminUserId,
      status: "accepted",
    },
  });
}

async function workRulesVerdict(taskId: string) {
  const results = await eligibilityService.checkEligibilityForTask(taskId, orgId);
  const mine = results.find((r) => r.membershipId === membershipId);
  if (!mine) throw new Error("member missing from eligibility result");
  return mine.checks.workRules;
}

/**
 * Judges one shift against another that is already committed.
 *
 * `existing` is created and assigned; `proposed` is created and left open, then
 * evaluated. Swapping which is which is the whole experiment.
 */
async function judge(
  existing: { start: Date; end: Date },
  proposed: { start: Date; end: Date }
) {
  const committed = await makeTask("existing", existing);
  await assignTo(committed.id);
  const candidate = await makeTask("proposed", proposed);
  return workRulesVerdict(candidate.id);
}

const LONG = at(0, 8, 18); // 10h — over the 8h threshold
const SHORT = at(0, 20, 22); // 2h — under it, two hours after LONG ends

describe("a long shift followed too soon by a short one", () => {
  it("is refused when the long one already exists", async () => {
    const result = await judge(LONG, SHORT);
    expect(result.eligible).toBe(false);
  });

  /*
   * The regression. Same two shifts, entered the other way round. The
   * neighbour is now the 2h shift, which is under the threshold — so gating on
   * the neighbour skipped the pair entirely and let the 10h shift through.
   */
  it("is refused when the short one already exists", async () => {
    const result = await judge(SHORT, LONG);
    expect(result.eligible).toBe(false);
  });
});

describe("two short shifts are left alone in both directions", () => {
  // Neither earns rest, so the rule must stay silent. Without this the fix
  // could have been "always check both lengths", which would refuse pairs the
  // rule was never meant to reach.
  const EARLY_SHORT = at(0, 8, 10);
  const LATE_SHORT = at(0, 11, 13);

  it("allows the later one", async () => {
    expect((await judge(EARLY_SHORT, LATE_SHORT)).eligible).toBe(true);
  });

  it("allows the earlier one", async () => {
    expect((await judge(LATE_SHORT, EARLY_SHORT)).eligible).toBe(true);
  });
});

describe("the refusal names the shift a manager has to move", () => {
  /*
   * The message ran one phrasing through an inverted ternary, so a shift that
   * PRECEDED the gap was described as coming after it. Both fixtures below use
   * different lengths for the two shifts, because with equal lengths the wrong
   * number is indistinguishable from the right one — which is why the original
   * assertion did not catch it.
   */
  it("names the preceding shift's length when the clash is behind", async () => {
    const result = await judge(at(0, 8, 18), at(0, 20, 21));
    expect(result.reason).toContain("10.0h");
    expect(result.reason).toMatch(/since a/i);
  });

  it("names the proposed shift's length when the clash is ahead", async () => {
    const result = await judge(at(0, 20, 21), at(0, 8, 18));
    expect(result.reason).toContain("10.0h");
    expect(result.reason).toMatch(/after this/i);
  });
});

describe("the company break rule measures the load the shift creates", () => {
  /*
   * Two faults, and correcting the first exposed the second.
   *
   * The window was anchored to `new Date()` — so a shift three weeks out was
   * judged on what the member worked the day before the manager clicked. And
   * the check never looked at the proposed shift at all: it compared PRIOR
   * hours against the cap, at-or-over, so an ordinary same-shift-every-day
   * roster was refused. It now asks whether the shift pushes a 24-hour window
   * over the cap, which is how the daily and weekly caps already work.
   *
   * These fixtures are in July 2026 and the cap is 8h, so under the old anchor
   * every window is empty and none of them could fire.
   */
  beforeEach(async () => {
    await prisma.companySettings.update({
      where: { organizationId: orgId },
      data: { workingDayHours: 8 },
    });
    // Rest gap out of the way — this block is about the hours dimension.
    await prisma.workRule.deleteMany({ where: { organizationId: orgId } });
  });

  async function hoursVerdict(taskId: string) {
    const results = await eligibilityService.checkEligibilityForTask(taskId, orgId);
    const mine = results.find((r) => r.membershipId === membershipId);
    if (!mine) throw new Error("member missing from eligibility result");
    return mine.checks.hoursLimit;
  }

  /** Judges `proposed` with `existing` already committed. */
  async function judgeHours(
    existing: { start: Date; end: Date },
    proposed: { start: Date; end: Date }
  ) {
    const committed = await makeTask("existing", existing);
    await assignTo(committed.id);
    const candidate = await makeTask("proposed", proposed);
    return hoursVerdict(candidate.id);
  }

  // The roster that was wrongly refused: the same shift two days running.
  // A day apart, so no 24-hour window holds more than eight hours.
  it("allows the same 8h shift on consecutive days", async () => {
    const result = await judgeHours(at(0, 9, 17), at(1, 9, 17));
    expect(result.eligible).toBe(true);
  });

  it("refuses a second shift that genuinely overloads the window", async () => {
    // 8h ending 17:00, then 6h from 21:00 — fourteen hours inside one day.
    const result = await judgeHours(at(0, 9, 17), at(0, 21, 23));
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/24h/);
  });

  it("refuses an early start that overlaps the previous day's window", async () => {
    // 8h Mon 09:00–17:00, then 4h Tue 08:00–12:00. The window from Mon 12:00
    // holds five of Monday's hours plus all four of Tuesday's.
    const result = await judgeHours(at(0, 9, 17), at(1, 8, 12));
    expect(result.eligible).toBe(false);
  });

  /*
   * The window has to be checked on BOTH sides. A short shift proposed the
   * evening before a long one sees nothing behind it — only an end-anchored
   * window would pass it, while it genuinely puts ten hours into the day that
   * follows.
   */
  it("refuses a shift that overloads the window ahead of it", async () => {
    const result = await judgeHours(at(1, 9, 17), at(0, 22, 24));
    expect(result.eligible).toBe(false);
  });

  it("ignores work far outside any window the shift touches", async () => {
    const result = await judgeHours(at(0, 9, 17), at(5, 9, 17));
    expect(result.eligible).toBe(true);
  });

  // At the cap is not over it — the daily and weekly caps both read `>`, and
  // three hour rules disagreeing on the boundary is how one comes to be wrong.
  it("allows a shift that lands exactly on the cap", async () => {
    const result = await judgeHours(at(0, 9, 13), at(0, 14, 18));
    expect(result.eligible).toBe(true);
  });
});
