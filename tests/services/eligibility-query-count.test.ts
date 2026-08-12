/**
 * Query-count guard for the eligibility engine.
 *
 * `getHoursInLast24h`, `getHoursOnDate` and `getHoursInWeek` are three
 * different windows over the SAME per-member assignment list, and each one used
 * to load that list itself. A member subject to a break rule, a daily cap and a
 * weekly cap therefore cost three identical queries — multiplied by every
 * member of the organisation, sequentially, on a path that runs
 * fire-and-forget after every reschedule.
 *
 * The fix is a per-evaluation cache passed down as a parameter. The reason it
 * is a parameter rather than a field is worth stating: `EligibilityService` is
 * held as a long-lived field by `TaskService` and others, so instance state
 * would be shared by every request that instance ever handles — stale hour
 * totals, and two interleaved requests reading each other's data.
 *
 * These tests assert the QUERY COUNT, not the timing. Timing is flaky and
 * proves nothing on a fast machine; the count is the actual property. The last
 * two tests are the ones that matter most — they pin the correctness the
 * optimisation must not cost.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EligibilityService } from "@/services/eligibility.service";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { TaskService } from "@/services/task.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { declareOpenWeek } from "../helpers/fixtures";
import { todaySgtAt } from "../helpers/time";

const eligibilityService = new EligibilityService();
const taskService = new TaskService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let adminUserId: string;
let deptId: string;
const staffMembershipIds: string[] = [];

/** Counts calls to the one query the hour helpers share. */
function countCommittedLoads() {
  return vi.spyOn(
    TaskAssignmentRepository.prototype,
    "findCommittedWithSchedule"
  );
}

beforeEach(async () => {
  await cleanDatabase();
  vi.restoreAllMocks();
  staffMembershipIds.length = 0;

  const admin = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create({ name: "Acme", slug: "acme" }, admin.id);
  orgId = org.id;

  await prisma.companySettings.create({
    data: { organizationId: orgId, workingDayHours: 8 },
  });

  const dept = await prisma.department.create({
    data: { name: "Kitchen", organizationId: orgId, color: "#EF4444" },
  });
  deptId = dept.id;

  // Three staff, all in the department, so all three are evaluated.
  for (let i = 0; i < 3; i++) {
    const user = await userRepo.create({
      name: `Staff ${i}`,
      email: `staff${i}@example.com`,
      hashedPassword: "hash",
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId: orgId, role: "staff", status: "active" },
    });
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: deptId },
    });
    staffMembershipIds.push(membership.id);
  }

  await declareOpenWeek(...staffMembershipIds);

  // A daily and a weekly cap alongside the company break rule, so all three
  // hour windows are exercised for every member.
  await prisma.workRule.create({
    data: {
      organizationId: orgId,
      name: "Daily cap",
      type: "max_hours_daily",
      maxHours: 10,
      isActive: true,
    },
  });
  await prisma.workRule.create({
    data: {
      organizationId: orgId,
      name: "Weekly cap",
      type: "max_hours_weekly",
      maxHours: 40,
      isActive: true,
    },
  });
});

async function scheduledTask() {
  return taskService.create(
    {
      title: "Evening shift",
      departmentId: deptId,
      scheduledStart: todaySgtAt(17, 1).toISOString(),
      scheduledEnd: todaySgtAt(21, 1).toISOString(),
    },
    orgId,
    adminUserId
  );
}

describe("checkEligibilityForTask — query count", () => {
  it("loads each member's assignments once, not once per hour window", async () => {
    const task = await scheduledTask();
    const spy = countCommittedLoads();

    await eligibilityService.checkEligibilityForTask(task.id, orgId);

    // Three members, three hour windows each. Before the cache that was nine
    // loads; it should now be one per member.
    expect(spy).toHaveBeenCalledTimes(staffMembershipIds.length);
  });

  it("scales linearly with members, not with members × rules", async () => {
    // The property that actually matters. Adding a third rule must not add a
    // third query per member.
    await prisma.workRule.create({
      data: {
        organizationId: orgId,
        name: "Break rule",
        type: "break_interval",
        hoursThreshold: 6,
        breakHours: 1,
        isActive: true,
      },
    });
    const task = await scheduledTask();
    const spy = countCommittedLoads();

    await eligibilityService.checkEligibilityForTask(task.id, orgId);

    expect(spy).toHaveBeenCalledTimes(staffMembershipIds.length);
  });
});

describe("The cache does not leak between evaluations", () => {
  it("re-queries on a second evaluation rather than reusing stale data", async () => {
    // The reason the cache is a parameter and not a field. If it lived on the
    // service, this second call would reuse the first call's data — and the
    // service is a long-lived field on TaskService, so "the next call" means
    // "a different request, possibly minutes later".
    const task = await scheduledTask();
    await eligibilityService.checkEligibilityForTask(task.id, orgId);

    const spy = countCommittedLoads();
    await eligibilityService.checkEligibilityForTask(task.id, orgId);

    expect(spy).toHaveBeenCalledTimes(staffMembershipIds.length);
  });

  it("sees hours committed since the previous evaluation", async () => {
    // Correctness, stated as behaviour rather than as a query count: a shift
    // booked between two checks must be visible to the second one.
    const task = await scheduledTask();
    const before = await eligibilityService.getHoursInWeek(
      staffMembershipIds[0],
      todaySgtAt(17, 1)
    );

    const other = await taskService.create(
      {
        title: "Another shift",
        departmentId: deptId,
        scheduledStart: todaySgtAt(9, 1).toISOString(),
        scheduledEnd: todaySgtAt(13, 1).toISOString(),
      },
      orgId,
      adminUserId
    );
    await taskService.assignStaff(other.id, orgId, [staffMembershipIds[0]], adminUserId);

    const after = await eligibilityService.getHoursInWeek(
      staffMembershipIds[0],
      todaySgtAt(17, 1)
    );

    expect(after).toBeGreaterThan(before);
    expect(task.id).toBeTruthy();
  });
});

describe("Hour totals are unchanged by the cache", () => {
  it("returns the same totals whether or not a cache is supplied", async () => {
    // The optimisation must be invisible in the results. Same member, same
    // instant, cached and uncached.
    const other = await taskService.create(
      {
        title: "Morning shift",
        departmentId: deptId,
        scheduledStart: todaySgtAt(9, 1).toISOString(),
        scheduledEnd: todaySgtAt(13, 1).toISOString(),
      },
      orgId,
      adminUserId
    );
    await taskService.assignStaff(other.id, orgId, [staffMembershipIds[0]], adminUserId);

    const date = todaySgtAt(9, 1);
    const uncached = await eligibilityService.getHoursOnDate(staffMembershipIds[0], date);

    const cache = new Map();
    const cachedFirst = await eligibilityService.getHoursOnDate(
      staffMembershipIds[0],
      date,
      undefined,
      cache as never
    );
    const cachedAgain = await eligibilityService.getHoursOnDate(
      staffMembershipIds[0],
      date,
      undefined,
      cache as never
    );

    expect(cachedFirst).toBe(uncached);
    expect(cachedAgain).toBe(uncached);
  });

  it("keeps different exclusions apart in the same cache", async () => {
    // The cache key includes excludeTaskId. If it did not, excluding the task
    // under evaluation would leak into a total that should include it — the
    // task would stop counting against itself in one place and start in
    // another, silently.
    const shift = await taskService.create(
      {
        title: "Counted shift",
        departmentId: deptId,
        scheduledStart: todaySgtAt(9, 1).toISOString(),
        scheduledEnd: todaySgtAt(13, 1).toISOString(),
      },
      orgId,
      adminUserId
    );
    await taskService.assignStaff(shift.id, orgId, [staffMembershipIds[0]], adminUserId);

    const cache = new Map();
    const date = todaySgtAt(9, 1);

    const including = await eligibilityService.getHoursOnDate(
      staffMembershipIds[0],
      date,
      undefined,
      cache as never
    );
    const excluding = await eligibilityService.getHoursOnDate(
      staffMembershipIds[0],
      date,
      shift.id,
      cache as never
    );

    expect(including).toBeGreaterThan(0);
    expect(excluding).toBe(0);
  });
});
