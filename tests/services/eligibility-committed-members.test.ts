/**
 * Assignments must never stop being checked.
 *
 * `checkEligibilityForTask` answers two questions with one candidate list:
 * "who could go on this shift?" and "is the person already on it still fine?".
 * The department filter is right for the first and fatal to the second — it
 * excluded anyone outside the task's department, including people already
 * assigned, so their assignment became permanently exempt from every check.
 *
 * The route in is ordinary: move a task from one department to another and
 * everyone assigned stays put while becoming invisible. The check that runs on
 * exactly that update then reports all clear.
 *
 * These tests pin both halves — assigned members are always evaluated, and
 * widening the candidate list does not turn them into suggestions.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EligibilityService } from "@/services/eligibility.service";
import { AllocationService } from "@/services/allocation.service";
import { TaskService } from "@/services/task.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const eligibility = new EligibilityService();
const allocation = new AllocationService();
const taskService = new TaskService();

let tenant: Tenant;
/** A department the staff fixture does NOT belong to. */
let otherDept: string;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("commit");
  const dept = await prisma.department.create({
    data: { name: "Front of house", organizationId: tenant.orgId, color: "#3B82F6" },
  });
  otherDept = dept.id;
});

function future(daysAhead = 7) {
  const start = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  start.setUTCHours(1, 0, 0, 0);
  return { start, end: new Date(start.getTime() + 8 * 60 * 60 * 1000) };
}

async function task(departmentId: string | null, headcount = 2) {
  const { start, end } = future();
  return prisma.task.create({
    data: {
      title: "Evening shift",
      organizationId: tenant.orgId,
      departmentId,
      createdById: tenant.admin.userId,
      scheduledStart: start,
      scheduledEnd: end,
      requiredHeadcount: headcount,
    },
  });
}

async function assign(taskId: string, membershipId: string, status = "accepted") {
  return prisma.taskAssignment.create({
    data: { taskId, membershipId, assignedById: tenant.admin.userId, status },
  });
}

/* ------------------------------------------------------------------ */

describe("assigned members are always evaluated", () => {
  it("includes someone assigned from outside the task's department", async () => {
    // The core of it. tenant.staff is in tenant.departmentId; the task is not.
    const t = await task(otherDept);
    await assign(t.id, tenant.staff.membershipId);

    const result = await eligibility.checkEligibilityForTask(t.id, tenant.orgId);

    expect(result.map((e) => e.membershipId)).toContain(tenant.staff.membershipId);
  });

  it("survives the task being moved to another department", async () => {
    // The realistic route in: create in Kitchen, assign, then move the shift.
    const t = await task(tenant.departmentId);
    await assign(t.id, tenant.staff.membershipId);

    await taskService.update(t.id, tenant.orgId, { departmentId: otherDept });

    const result = await eligibility.checkEligibilityForTask(t.id, tenant.orgId);
    expect(result.map((e) => e.membershipId)).toContain(tenant.staff.membershipId);
  });

  it("still reports a real problem for that member", async () => {
    // Being present is not enough — the checks have to actually run on them.
    const t = await task(otherDept);
    await assign(t.id, tenant.staff.membershipId);

    // Casual staff with no availability recorded fail the availability check.
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { employmentType: "casual" },
    });

    const result = await eligibility.checkEligibilityForTask(t.id, tenant.orgId);
    const own = result.find((e) => e.membershipId === tenant.staff.membershipId);

    expect(own?.eligible).toBe(false);
    expect(own?.checks.availability.eligible).toBe(false);
  });

  it("does not include someone who rejected the shift", async () => {
    // They are not on it, so there is nothing left to validate.
    const t = await task(otherDept);
    await assign(t.id, tenant.staff.membershipId, "rejected");

    const result = await eligibility.checkEligibilityForTask(t.id, tenant.orgId);
    expect(result.map((e) => e.membershipId)).not.toContain(tenant.staff.membershipId);
  });

  it("includes someone with a pending withdrawal, who still holds the slot", async () => {
    const t = await task(otherDept);
    await assign(t.id, tenant.staff.membershipId, "withdrawal_requested");

    const result = await eligibility.checkEligibilityForTask(t.id, tenant.orgId);
    expect(result.map((e) => e.membershipId)).toContain(tenant.staff.membershipId);
  });

  it("does not widen the list for a department-less task", async () => {
    // Those already consider everyone, so there is nothing to add.
    const t = await task(null);
    const result = await eligibility.checkEligibilityForTask(t.id, tenant.orgId);

    const ids = result.map((e) => e.membershipId).sort();
    expect(ids).toEqual(
      [tenant.manager.membershipId, tenant.staff.membershipId].sort()
    );
  });

  it("leaves the ordinary candidate list unchanged", async () => {
    // The guard against over-correcting. With nobody assigned, a departmental
    // task must still consider only that department.
    const t = await task(tenant.departmentId);
    const result = await eligibility.checkEligibilityForTask(t.id, tenant.orgId);

    const ids = result.map((e) => e.membershipId).sort();
    expect(ids).toEqual(
      [tenant.manager.membershipId, tenant.staff.membershipId].sort()
    );
  });

  it("never resurrects a deactivated member", async () => {
    // Widening the candidate set must not reach past the active-member filter.
    const t = await task(otherDept);
    await assign(t.id, tenant.inactive.membershipId);

    const result = await eligibility.checkEligibilityForTask(t.id, tenant.orgId);
    expect(result.map((e) => e.membershipId)).not.toContain(
      tenant.inactive.membershipId
    );
  });
});

/* ------------------------------------------------------------------ */

describe("the manager is warned after a department change", () => {
  it("reports an assigned member who no longer fits", async () => {
    // Before the fix this was the worst case: the check ran on exactly this
    // update, found nobody to look at, and said nothing.
    const t = await task(tenant.departmentId);
    await assign(t.id, tenant.staff.membershipId);
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { employmentType: "casual" },
    });

    await taskService.update(t.id, tenant.orgId, { departmentId: otherDept });

    // Fire-and-forget, so give the notification a moment to land.
    await vi.waitFor(async () => {
      const sent = await prisma.notification.findMany({
        where: { type: "staff_ineligible" },
      });
      expect(sent.length).toBeGreaterThan(0);
    });
  });
});

/* ------------------------------------------------------------------ */

describe("widening does not leak into suggestions", () => {
  it("does not re-suggest someone already on the shift", async () => {
    // Eligibility now includes assigned members so they can be VALIDATED.
    // Proposing them again is a different thing, and `assignStaff` would fail
    // on the unique constraint over (taskId, membershipId) if it happened.
    const t = await task(tenant.departmentId);
    await assign(t.id, tenant.staff.membershipId);

    const suggestions = await allocation.getSuggestions(t.id, tenant.orgId);

    expect(suggestions.map((s) => s.membershipId)).not.toContain(
      tenant.staff.membershipId
    );
  });

  it("does not suggest someone with a pending offer either", async () => {
    // Pending was not excluded before — only rejected was — so the same person
    // could be offered the same shift twice.
    const t = await task(tenant.departmentId);
    await assign(t.id, tenant.staff.membershipId, "pending");

    const suggestions = await allocation.getSuggestions(t.id, tenant.orgId);
    expect(suggestions.map((s) => s.membershipId)).not.toContain(
      tenant.staff.membershipId
    );
  });

  it("still suggests everyone who is genuinely free", async () => {
    // The fixture's staff member is casual, so availability is a hard
    // constraint and they need a schedule before they can be eligible at all.
    for (let day = 0; day < 7; day++) {
      await prisma.availability.create({
        data: {
          membershipId: tenant.staff.membershipId,
          dayOfWeek: day,
          startTime: "00:00",
          endTime: "23:59",
          isAvailable: true,
        },
      });
    }
    const t = await task(tenant.departmentId);

    const suggestions = await allocation.getSuggestions(t.id, tenant.orgId);
    expect(suggestions.map((s) => s.membershipId)).toContain(
      tenant.staff.membershipId
    );
  });

  it("does not suggest a cross-department member who is merely assigned", async () => {
    // They appear in eligibility for validation only. Offering them as a fresh
    // candidate for a department they are not in would be the leak.
    const t = await task(otherDept);
    await assign(t.id, tenant.staff.membershipId);

    const suggestions = await allocation.getSuggestions(t.id, tenant.orgId);
    expect(suggestions.map((s) => s.membershipId)).not.toContain(
      tenant.staff.membershipId
    );
  });
});

/* ------------------------------------------------------------------ */

describe("which edits trigger the managers' check", () => {
  /** Assigns a casual member with no availability — ineligible on any shift. */
  async function strandedAssignment(departmentId: string | null = tenant.departmentId) {
    const t = await task(departmentId);
    await assign(t.id, tenant.staff.membershipId);
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { employmentType: "casual" },
    });
    return t;
  }

  async function alertCount() {
    return prisma.notification.count({ where: { type: "staff_ineligible" } });
  }

  it("fires on a schedule change", async () => {
    const t = await strandedAssignment();
    const { start, end } = future(14);

    await taskService.update(t.id, tenant.orgId, {
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
    });

    await vi.waitFor(async () => expect(await alertCount()).toBeGreaterThan(0));
  });

  it("fires on a department change", async () => {
    // Was silent before: the trigger hung off the schedule alone, so moving a
    // task between departments — which swaps the work rules that apply — went
    // unchecked.
    const t = await strandedAssignment();

    await taskService.update(t.id, tenant.orgId, { departmentId: otherDept });

    await vi.waitFor(async () => expect(await alertCount()).toBeGreaterThan(0));
  });

  it("fires when the required certifications change", async () => {
    // The third way to strand someone: demand a qualification they lack.
    const t = await strandedAssignment();

    await taskService.update(t.id, tenant.orgId, {
      requiredCertifications: ["Food Safety Level 2"],
    });

    await vi.waitFor(async () => expect(await alertCount()).toBeGreaterThan(0));
  });

  it("stays quiet for an edit that cannot affect eligibility", async () => {
    // Renaming a shift changes nothing about who can work it. Alerting here
    // would train managers to ignore the notification.
    const t = await strandedAssignment();

    await taskService.update(t.id, tenant.orgId, { title: "Evening shift (busy)" });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await alertCount()).toBe(0);
  });

  it("treats a reordered certification list as no change", async () => {
    // Order carries no meaning, so a reorder is the same requirement.
    const t = await task(tenant.departmentId);
    await prisma.task.update({
      where: { id: t.id },
      data: { requiredCertifications: ["First Aid", "Food Safety"] },
    });
    await assign(t.id, tenant.staff.membershipId);
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { employmentType: "casual" },
    });

    await taskService.update(t.id, tenant.orgId, {
      requiredCertifications: ["Food Safety", "First Aid"],
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await alertCount()).toBe(0);
  });

  it("stays quiet when the task is being cancelled", async () => {
    // The assignments are moot — warning that a cancelled shift's staff are
    // ineligible is noise about something nobody needs to act on.
    const t = await strandedAssignment();

    await taskService.update(t.id, tenant.orgId, { status: "cancelled" });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await alertCount()).toBe(0);
  });
});
