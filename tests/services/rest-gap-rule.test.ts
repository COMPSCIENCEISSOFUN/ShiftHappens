/**
 * The `break_interval` work rule, which is a REST GAP between shifts.
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
let staffMembershipId: string;

beforeEach(async () => {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create({ name: "Acme", slug: "acme-rest" }, admin.id);
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
      // Full-time so the availability dimension stays out of the way.
      employmentType: "full_time",
    },
  });
  staffMembershipId = membership.id;

  await prisma.companySettings.create({
    data: { organizationId: org.id, workingDayHours: 100 },
  });
});

/**
 * Deliberately far in the future — July 2026, well past any test run.
 *
 * That distance is the test. Under the old implementation every shift here was
 * judged against the 24 hours before the test ran, which contains nothing, so
 * no arrangement of these fixtures could ever have produced a violation.
 */
function day(dayOffset: number, startHour: number, endHour: number) {
  const date = 15 + dayOffset;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: sgt(`2026-07-${pad(date)}T${pad(startHour)}:00`),
    end: sgt(`2026-07-${pad(date)}T${pad(endHour)}:00`),
  };
}

async function shift(
  title: string,
  when: { start: Date; end: Date },
  assign = true
) {
  const task = await prisma.task.create({
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
  if (assign) {
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: staffMembershipId,
        assignedById: adminUserId,
        status: "accepted",
      },
    });
  }
  return task;
}

/** "11 hours off after any shift of 8 hours or more." */
async function restRule(hoursThreshold = 8, breakHours = 11) {
  return prisma.workRule.create({
    data: {
      organizationId: orgId,
      name: "Daily rest",
      type: "break_interval",
      hoursThreshold,
      breakHours,
      isActive: true,
    },
  });
}

/**
 * The work-rules verdict for our staff member on a task.
 *
 * Through the public entry point rather than the private rule evaluator, so
 * these tests exercise the same path the assign screen does — rule loading,
 * targeting and all.
 */
async function check(taskId: string) {
  const results = await eligibilityService.checkEligibilityForTask(taskId, orgId);
  const mine = results.find((r) => r.membershipId === staffMembershipId);
  if (!mine) throw new Error("staff member missing from the eligibility result");
  return mine.checks.workRules;
}

describe("rest after a long shift", () => {
  it("refuses a shift starting too soon after one", async () => {
    await restRule();
    // Ends 22:00. Next starts 06:00 — eight hours' rest, two short of eleven.
    await shift("Late", day(0, 14, 22));
    const next = await shift("Early", day(1, 6, 14), false);

    const result = await check(next.id);

    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/rest/i);
  });

  it("allows the same shift once there is enough rest", async () => {
    await restRule();
    await shift("Late", day(0, 14, 22));
    // 09:00 the next day is eleven hours after 22:00.
    const next = await shift("Later start", day(1, 9, 17), false);

    expect((await check(next.id)).eligible).toBe(true);
  });

  /**
   * The other side of the same breach. A roster is not built strictly forwards:
   * a manager adding a late shift the evening before an early one is the same
   * problem, and checking only backwards would let it through depending on the
   * order the two were entered.
   */
  it("refuses a long shift ending too soon before an existing one", async () => {
    await restRule();
    await shift("Early tomorrow", day(1, 6, 14));
    const late = await shift("Late tonight", day(0, 14, 22), false);

    const result = await check(late.id);

    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/rest/i);
  });
});

describe("the threshold decides which shifts earn rest", () => {
  /**
   * A rule reading "eleven hours off after eight hours worked" should say
   * nothing about a two-hour shift. The threshold is measured against the
   * NEIGHBOUR, because it is the long shift that earns the rest.
   */
  it("ignores a neighbouring shift shorter than the threshold", async () => {
    await restRule(8, 11);
    await shift("Short", day(0, 20, 22)); // two hours
    const next = await shift("Early", day(1, 6, 14), false);

    expect((await check(next.id)).eligible).toBe(true);
  });

  it("applies once the neighbour reaches the threshold exactly", async () => {
    await restRule(8, 11);
    await shift("Exactly eight", day(0, 14, 22));
    const next = await shift("Early", day(1, 6, 14), false);

    expect((await check(next.id)).eligible).toBe(false);
  });

  // The gap comparison is strict: exactly the required rest is enough rest.
  it("allows a gap exactly equal to the required rest", async () => {
    await restRule(8, 8);
    await shift("Late", day(0, 14, 22));
    const next = await shift("Next", day(1, 6, 14), false);

    expect((await check(next.id)).eligible).toBe(true);
  });
});

describe("what the rule stays out of", () => {
  /**
   * A negative gap is a double-booking, which the scheduling-conflict check
   * already refuses with a message naming the clash. Reporting it here as
   * "-3.0h rest" would be a second, worse explanation of the same problem.
   */
  it("says nothing about an overlapping shift", async () => {
    await restRule();
    await shift("Overlapping", day(0, 12, 20));
    const clash = await shift("Also then", day(0, 16, 23), false);

    expect((await check(clash.id)).eligible).toBe(true);
  });

  /**
   * Mutation testing showed this one is belt-and-braces: with `breakHours`
   * null the required gap computes to zero and no arrangement of shifts
   * breaches it, so deleting the guard changes nothing. It stays because a
   * half-configured rule silently meaning "no rest required" is worth being
   * explicit about — and because validation only demands both fields on the
   * paths that go through the service, not on a row written directly.
   */
  it("says nothing when the rule has no break length set", async () => {
    await prisma.workRule.create({
      data: {
        organizationId: orgId,
        name: "Half a rule",
        type: "break_interval",
        hoursThreshold: 8,
        breakHours: null,
        isActive: true,
      },
    });
    await shift("Late", day(0, 14, 22));
    const next = await shift("Early", day(1, 6, 14), false);

    expect((await check(next.id)).eligible).toBe(true);
  });

  it("says nothing about an unscheduled shift", async () => {
    await restRule();
    await shift("Late", day(0, 14, 22));
    const undated = await prisma.task.create({
      data: {
        title: "No times",
        organizationId: orgId,
        createdById: adminUserId,
        requiredHeadcount: 1,
        status: "open",
      },
    });

    expect((await check(undated.id)).eligible).toBe(true);
  });

  it("ignores a paused rule", async () => {
    await prisma.workRule.create({
      data: {
        organizationId: orgId,
        name: "Paused rest",
        type: "break_interval",
        hoursThreshold: 8,
        breakHours: 11,
        isActive: false,
      },
    });
    await shift("Late", day(0, 14, 22));
    const next = await shift("Early", day(1, 6, 14), false);

    expect((await check(next.id)).eligible).toBe(true);
  });

  // Someone who turned the shift down is not resting from it.
  it("ignores a shift the member rejected", async () => {
    await restRule();
    const late = await shift("Late", day(0, 14, 22), false);
    await prisma.taskAssignment.create({
      data: {
        taskId: late.id,
        membershipId: staffMembershipId,
        assignedById: adminUserId,
        status: "rejected",
      },
    });
    const next = await shift("Early", day(1, 6, 14), false);

    expect((await check(next.id)).eligible).toBe(true);
  });

  /**
   * The shift being judged is already assigned when eligibility is re-checked
   * after a reschedule. Without the exclusion it would be its own neighbour and
   * refuse itself.
   */
  it("does not measure a shift against itself", async () => {
    await restRule();
    const only = await shift("The only shift", day(0, 14, 22));

    expect((await check(only.id)).eligible).toBe(true);
  });
});

describe("the refusal explains itself", () => {
  it("names the rest available, the shift that caused it, and the rule", async () => {
    await restRule(8, 11);
    await shift("Late", day(0, 14, 22));
    const next = await shift("Early", day(1, 6, 14), false);

    const reason = (await check(next.id)).reason ?? "";

    expect(reason).toContain("8.0h rest");   // what they would get
    expect(reason).toContain("8.0h shift");  // the shift that earned the rest
    expect(reason).toContain("Daily rest");  // the rule's own name
    expect(reason).toContain("11h");         // what the rule requires
  });
});
