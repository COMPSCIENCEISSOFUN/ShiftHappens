/**
 * Tests for the "committed hours" behaviour of the Eligibility engine.
 *
 * Hour limits (max_hours_daily / max_hours_weekly) must count not just hours
 * already CLOCKED, but also hours a member is already COMMITTED to via
 * pending/accepted/withdrawal_requested assignments on scheduled tasks.
 * Otherwise a manager could stack many future shifts on one person without
 * ever tripping the cap. Rejected/withdrawn assignments must NOT count, and
 * the task being evaluated must not be counted against itself.
 *
 * Members are full-time so the availability dimension always passes, isolating
 * the work-rule hour math.
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
      employmentType: "full_time", // skip availability
    },
  });
  staffMembershipId = membership.id;

  await prisma.companySettings.create({
    data: { organizationId: org.id, breakRuleHoursWorked: 100 }, // don't trip the break rule
  });
});

/**
 * Local-time datetime helper for a fixed Monday (2026-06-15) in the same week.
 * Uses local time (not UTC) to match the engine's local calendar-day windows
 * (getHoursOnDate/getHoursInWeek use setHours), so tests are timezone-stable.
 */
function at(dayOffset: number, startHour: number, endHour: number) {
  // Singapore wall-clock, stated explicitly. The local `new Date(y, m, d, h)`
  // constructor used here before made these fixtures mean different instants
  // depending on the machine's timezone, so on a UTC runner an 08:00-16:00
  // shift became 16:00-24:00 SGT and the "same day" tasks straddled midnight.
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = pad(15 + dayOffset);
  return {
    start: sgt(`2026-06-${day}T${pad(startHour)}:00`),
    end: sgt(`2026-06-${day}T${pad(endHour)}:00`),
  };
}

/** Creates a scheduled task and assigns the staff member with the given status. */
async function scheduledAssignment(
  startHour: number,
  endHour: number,
  status: string,
  dayOffset = 0
) {
  const { start, end } = at(dayOffset, startHour, endHour);
  const task = await taskRepo.create({
    title: `Shift ${startHour}-${endHour}`,
    organizationId: orgId,
    createdById: adminUserId,
    scheduledStart: start,
    scheduledEnd: end,
  });
  await prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: staffMembershipId,
      assignedById: adminUserId,
      status,
    },
  });
  return task;
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

function staffResult(results: Awaited<ReturnType<EligibilityService["checkEligibilityForTask"]>>) {
  return results.find((r) => r.membershipId === staffMembershipId)!;
}

/** A new task the staff member is NOT yet assigned to. */
async function newTask(startHour: number, endHour: number, dayOffset = 0) {
  const { start, end } = at(dayOffset, startHour, endHour);
  return taskRepo.create({
    title: `New shift ${startHour}-${endHour}`,
    organizationId: orgId,
    createdById: adminUserId,
    scheduledStart: start,
    scheduledEnd: end,
  });
}

describe("EligibilityService — committed hours count toward caps", () => {
  it("blocks when an ACCEPTED future shift plus the new task exceed the daily cap", async () => {
    await dailyRule(8);
    // Already committed 8h that day (accepted, not clocked).
    await scheduledAssignment(8, 16, "accepted");
    // New 3h task same day → 8 + 3 = 11 > 8.
    const task = await newTask(18, 21);

    const staff = staffResult(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.workRules.eligible).toBe(false);
    expect(staff.eligible).toBe(false);
  });

  it("blocks when a PENDING future shift plus the new task exceed the daily cap", async () => {
    await dailyRule(8);
    await scheduledAssignment(8, 16, "pending");
    const task = await newTask(18, 21);

    const staff = staffResult(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.workRules.eligible).toBe(false);
  });

  it("allows when committed hours plus the new task stay within the daily cap", async () => {
    await dailyRule(12);
    await scheduledAssignment(8, 16, "accepted"); // 8h
    const task = await newTask(18, 21); // +3h = 11 <= 12

    const staff = staffResult(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.workRules.eligible).toBe(true);
  });

  it("does not count a REJECTED assignment toward the cap", async () => {
    await dailyRule(8);
    await scheduledAssignment(8, 16, "rejected"); // declined — should not count
    const task = await newTask(18, 21); // 0 + 3 = 3 <= 8

    const staff = staffResult(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.workRules.eligible).toBe(true);
  });

  it("does not double-count the task being evaluated against itself", async () => {
    await dailyRule(8);
    // Staff is ALREADY assigned to the 8h task we then re-check (e.g. reschedule).
    const task = await scheduledAssignment(8, 16, "accepted"); // exactly 8h

    const staff = staffResult(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    // Only this task's 8h counts (via +taskDuration), not 8h committed + 8h again.
    expect(staff.checks.workRules.eligible).toBe(true);
  });

  it("blocks when committed shifts across the week plus the new task exceed the weekly cap", async () => {
    await weeklyRule(20);
    await scheduledAssignment(8, 18, "accepted", 0); // Mon 10h
    await scheduledAssignment(8, 18, "accepted", 1); // Tue 10h  → 20h committed
    const task = await newTask(9, 12, 2); // Wed +3h = 23 > 20

    const staff = staffResult(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.workRules.eligible).toBe(false);
  });
});
