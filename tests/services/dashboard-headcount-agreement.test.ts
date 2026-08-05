/**
 * The dashboard and the reporting layer must count a shift the same way.
 *
 * `gatherDashboardData` counted with `assignments.length` on a repository call
 * that includes assignments at EVERY status — so a three-person shift everyone
 * had turned down counted as three. It was therefore neither unassigned nor
 * understaffed and vanished from the panel entirely, while `getUnderstaffedTasks`
 * — correctly migrated to the shared rule — reported it as needing three people.
 * Same data, same moment, two answers.
 *
 * That is the precise drift `src/lib/assignment-status.ts` was written to end,
 * surviving in the one consumer that had not been moved across. It matters more
 * here than on a screen: these figures go into the model's prompt, so a wrong
 * count does not merely display wrong, it becomes the premise of a
 * recommendation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { ReportingRepository } from "@/repositories/reporting.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { sgt } from "../helpers/time";

const aiDashboard = new AIDashboardService();
const reportingRepo = new ReportingRepository();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("headcount");
});

async function openTask(headcount: number) {
  return prisma.task.create({
    data: {
      title: "Evening service",
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      createdById: tenant.admin.userId,
      requiredHeadcount: headcount,
      status: "open",
      scheduledStart: sgt("2026-09-10T18:00"),
      scheduledEnd: sgt("2026-09-10T22:00"),
    },
  });
}

/** A membership that is not one of the fixture's three. */
async function extraMember(label: string) {
  const user = await prisma.user.create({
    data: {
      name: `Extra ${label}`,
      email: `extra-${label}-${Date.now()}-${Math.round(performance.now())}@example.com`,
      hashedPassword: "hash",
    },
  });
  return prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: tenant.orgId,
      role: "staff",
      status: "active",
      departmentMemberships: { create: { departmentId: tenant.departmentId } },
    },
  });
}

async function place(taskId: string, membershipId: string, status: string) {
  return prisma.taskAssignment.create({
    data: { taskId, membershipId, assignedById: tenant.admin.userId, status },
  });
}

/** How many people the REPORTING layer says the task still needs. */
async function reportingSaysNeeded(taskId: string) {
  const understaffed = await reportingRepo.getUnderstaffedTasks(tenant.orgId);
  const entry = understaffed.find((t) => t.id === taskId);
  return entry ? entry.requiredHeadcount - entry.assignedCount : 0;
}

describe("a shift everybody rejected", () => {
  it("is reported as fully unstaffed, not as fully staffed", async () => {
    const task = await openTask(3);
    await place(task.id, tenant.staff.membershipId, "rejected");
    await place(task.id, (await extraMember("a")).id, "rejected");
    await place(task.id, (await extraMember("b")).id, "rejected");

    expect(await reportingSaysNeeded(task.id)).toBe(3);

    // And the dashboard's own view agrees — it is counted as unassigned.
    const data = await aiDashboard.gatherDashboardData(tenant.orgId);
    expect(data.unassignedTasks).toBe(1);
    expect(data.understaffedTasks).toHaveLength(0);
  });

  it("does not report a task as understaffed when it is genuinely full", async () => {
    const task = await openTask(2);
    await place(task.id, tenant.staff.membershipId, "accepted");
    await place(task.id, (await extraMember("c")).id, "pending");

    const data = await aiDashboard.gatherDashboardData(tenant.orgId);
    expect(data.unassignedTasks).toBe(0);
    expect(data.understaffedTasks).toHaveLength(0);
  });
});

describe("a partially rejected shift", () => {
  it("reports the slots actually left, not the rows on the table", async () => {
    const task = await openTask(3);
    await place(task.id, tenant.staff.membershipId, "accepted");
    await place(task.id, (await extraMember("d")).id, "rejected");
    await place(task.id, (await extraMember("e")).id, "withdrawn");

    const data = await aiDashboard.gatherDashboardData(tenant.orgId);
    const entry = data.understaffedTasks.find((t) => t.taskId === task.id);

    expect(entry).toBeDefined();
    expect(entry!.assigned).toBe(1);
    expect(entry!.needed).toBe(2);
  });

  /*
   * A decision still waiting on a manager holds the seat. The member is
   * expected to turn up until it is resolved, so counting them out here would
   * send a manager looking for cover that is not needed.
   */
  it("counts a pending decline as still holding its slot", async () => {
    const task = await openTask(2);
    await place(task.id, tenant.staff.membershipId, "accepted");
    await place(task.id, (await extraMember("f")).id, "decline_requested");

    const data = await aiDashboard.gatherDashboardData(tenant.orgId);
    expect(data.understaffedTasks).toHaveLength(0);
  });

  it("counts a clocked-in shift as still holding its slot", async () => {
    const task = await openTask(1);
    await place(task.id, tenant.staff.membershipId, "clocked_out");

    const data = await aiDashboard.gatherDashboardData(tenant.orgId);
    expect(data.unassignedTasks).toBe(0);
    expect(data.understaffedTasks).toHaveLength(0);
  });
});

describe("the two layers agree", () => {
  /*
   * The property, rather than any one arrangement: whatever the mix of
   * statuses, the number the dashboard reports as still needed must equal the
   * number the reporting layer reports. They read the same table through
   * different repositories, and only the shared rule keeps them in step.
   */
  const MIXES: string[][] = [
    ["rejected", "rejected", "rejected"],
    ["accepted", "rejected", "withdrawn"],
    ["pending", "decline_requested", "rejected"],
    ["accepted", "accepted", "accepted"],
    ["withdrawal_requested", "rejected", "rejected"],
  ];

  for (const mix of MIXES) {
    it(`agrees for ${mix.join(" + ")}`, async () => {
      const task = await openTask(3);
      let i = 0;
      for (const status of mix) {
        const membership =
          i === 0
            ? { id: tenant.staff.membershipId }
            : await extraMember(`${mix.join("")}-${i}`);
        await place(task.id, membership.id, status);
        i++;
      }

      const data = await aiDashboard.gatherDashboardData(tenant.orgId);
      const dashboardNeeded =
        data.understaffedTasks.find((t) => t.taskId === task.id)?.needed ??
        (data.unassignedTasks > 0 ? 3 : 0);

      expect(dashboardNeeded).toBe(await reportingSaysNeeded(task.id));
    });
  }
});
