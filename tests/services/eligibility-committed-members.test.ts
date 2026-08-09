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
import { pauseForAbsence } from "../helpers/settle";

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

describe("the manager is warned when an edit strands somebody", () => {
  it("reports an assigned member who no longer fits", async () => {
    const t = await task(tenant.departmentId);
    await assign(t.id, tenant.staff.membershipId);
    // Full-time, so an unwritten day reads as open and they fit the shift as
    // created. The notifier reports who this EDIT stranded, so a member who was
    // already ineligible would prove nothing.
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { employmentType: "full_time" },
    });

    await taskService.update(t.id, tenant.orgId, {
      requiredCertifications: ["Food Safety Level 2"],
    });

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
  /**
   * A member who FITS the shift as created, so an edit can strand them.
   *
   * This used to be the opposite — a casual with no availability, ineligible on
   * any shift, named `strandedAssignment`. That worked while the notifier
   * reported everyone currently ineligible, and stopped working the moment it
   * started reporting only people the EDIT stranded: a member who was already
   * ineligible before the change is not news about the change.
   *
   * Full-time, because an unwritten day reads as open for them, so they are
   * available for the shift `task()` creates without having to seed seven
   * availability rows per test.
   */
  async function fittingAssignment(departmentId: string | null = tenant.departmentId) {
    const t = await task(departmentId);
    await assign(t.id, tenant.staff.membershipId);
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { employmentType: "full_time" },
    });
    return t;
  }

  async function alertCount() {
    return prisma.notification.count({ where: { type: "staff_ineligible" } });
  }

  it("fires on a schedule change", async () => {
    const t = await fittingAssignment();
    // Stretched to 23 hours, well past the organisation's 8-hour working day.
    // The member fitted the shift as created and cannot fit this one, which is
    // exactly what the managers need telling about.
    const { start } = future(14);
    await taskService.update(t.id, tenant.orgId, {
      scheduledStart: start.toISOString(),
      scheduledEnd: new Date(start.getTime() + 23 * 3_600_000).toISOString(),
    });

    await vi.waitFor(async () => expect(await alertCount()).toBeGreaterThan(0));
  });

  /*
   * A department change runs the check and, as the engine stands, can never
   * find anybody newly stranded.
   *
   * The trigger was added on the reasoning that moving a task between
   * departments "swaps the work rules that apply". It does not:
   * `filterApplicableRules` matches a rule's `departmentId` against the
   * MEMBER's departments, not the task's, so moving the task changes which
   * rules apply to nobody. Nor does it change availability, certificates, hours
   * or conflicts — and the engine deliberately keeps evaluating members who are
   * already assigned, so the department filter does not drop them either.
   *
   * Kept as a trigger anyway: it costs one eligibility run on an uncommon edit,
   * and the day department-targeted rules key off the task instead, this is
   * already wired. Asserted as SILENCE rather than deleted, so that day shows
   * up here as a failing test rather than as a surprise.
   */
  it("runs on a department change and finds nobody newly stranded", async () => {
    const t = await fittingAssignment();

    await taskService.update(t.id, tenant.orgId, { departmentId: otherDept });

    await pauseForAbsence(300); // absence — see helpers/settle
    expect(await alertCount()).toBe(0);
  });

  it("fires when the required certifications change", async () => {
    // The third way to strand someone: demand a qualification they lack.
    const t = await fittingAssignment();

    await taskService.update(t.id, tenant.orgId, {
      requiredCertifications: ["Food Safety Level 2"],
    });

    await vi.waitFor(async () => expect(await alertCount()).toBeGreaterThan(0));
  });

  /*
   * The other half of the same rule, and the one that used to be missing: an
   * edit that changes eligibility but strands NOBODY NEW must also be silent.
   * Without this, "fires on a certifications change" passes just as well
   * against a notifier that alerts on every edit regardless.
   */
  it("stays quiet when the same person was already stranded", async () => {
    const t = await fittingAssignment();
    // Strand them first, and let that alert land.
    await taskService.update(t.id, tenant.orgId, {
      requiredCertifications: ["Food Safety Level 2"],
    });
    await vi.waitFor(async () => expect(await alertCount()).toBeGreaterThan(0));
    const afterFirst = await alertCount();

    // A second edit to the same requirement. They are no worse off than they
    // were a moment ago, so there is nothing to say.
    await taskService.update(t.id, tenant.orgId, {
      requiredCertifications: ["Food Safety Level 2", "First Aid"],
    });
    await pauseForAbsence(300);

    expect(await alertCount()).toBe(afterFirst);
  });

  it("stays quiet for an edit that cannot affect eligibility", async () => {
    // Renaming a shift changes nothing about who can work it. Alerting here
    // would train managers to ignore the notification.
    const t = await fittingAssignment();

    await taskService.update(t.id, tenant.orgId, { title: "Evening shift (busy)" });

    await pauseForAbsence(300); // absence — see helpers/settle
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

    await pauseForAbsence(300); // absence — see helpers/settle
    expect(await alertCount()).toBe(0);
  });

  it("stays quiet when the task is being cancelled", async () => {
    // The assignments are moot — warning that a cancelled shift's staff are
    // ineligible is noise about something nobody needs to act on.
    const t = await fittingAssignment();

    await taskService.update(t.id, tenant.orgId, { status: "cancelled" });

    await pauseForAbsence(300); // absence — see helpers/settle
    expect(await alertCount()).toBe(0);
  });
});
