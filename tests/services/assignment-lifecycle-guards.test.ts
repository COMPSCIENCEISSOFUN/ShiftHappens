/**
 * Guards on the assignment lifecycle that the permission layer cannot express.
 *
 * Every case here is one where the caller legitimately HOLDS the permission and
 * still must be refused, because the refusal is about the row rather than the
 * person. A route check answers "may you resolve declines"; none of these
 * answers "may you resolve THIS one".
 *
 *   resolveDecline / resolveWithdrawal — not your own request
 *   assignStaff                        — not someone who already has a row
 *   assignStaff                        — not the same person twice in one call
 *   confirmSchedule                    — not past the task's headcount
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskService } from "@/services/task.service";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { sgt } from "../helpers/time";

const taskService = new TaskService();
const assignmentService = new TaskAssignmentService();
const autoSchedule = new AutoScheduleService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("lifecycle");
});

async function makeTask(headcount = 2) {
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

async function assignmentFor(
  taskId: string,
  membershipId: string,
  status: string
) {
  return prisma.taskAssignment.create({
    data: {
      taskId,
      membershipId,
      assignedById: tenant.admin.userId,
      status,
    },
  });
}

describe("a request for someone else's agreement", () => {
  /*
   * A full-time decline needs a manager because the shift is an obligation
   * somebody else has to release the member from. Managers are rosterable and
   * hold `tasks:assign` by default, so a full-time manager could request the
   * decline and approve it in two requests — the approval step collapsing
   * entirely for exactly the people most likely to be full-time.
   */
  it("cannot be answered by the person who made it — decline", async () => {
    const task = await makeTask();
    const assignment = await assignmentFor(
      task.id,
      tenant.manager.membershipId,
      "decline_requested"
    );

    await expect(
      assignmentService.resolveDecline(
        assignment.id,
        "approve",
        tenant.manager.userId,
        tenant.orgId
      )
    ).rejects.toThrow("your own decline request");
  });

  it("cannot be answered by the person who made it — withdrawal", async () => {
    const task = await makeTask();
    const assignment = await assignmentFor(
      task.id,
      tenant.manager.membershipId,
      "withdrawal_requested"
    );

    await expect(
      assignmentService.resolveWithdrawal(
        assignment.id,
        "approve",
        tenant.manager.userId,
        tenant.orgId
      )
    ).rejects.toThrow("your own withdrawal request");
  });

  // Denying is the same authority pointed the other way — a member who can
  // deny their own request can keep a shift a manager wanted to release.
  it("cannot be denied by the person who made it either", async () => {
    const task = await makeTask();
    const assignment = await assignmentFor(
      task.id,
      tenant.manager.membershipId,
      "decline_requested"
    );

    await expect(
      assignmentService.resolveDecline(
        assignment.id,
        "deny",
        tenant.manager.userId,
        tenant.orgId
      )
    ).rejects.toThrow("your own decline request");
  });

  it("is answered normally by a different manager", async () => {
    const task = await makeTask();
    const assignment = await assignmentFor(
      task.id,
      tenant.staff.membershipId,
      "decline_requested"
    );

    const result = await assignmentService.resolveDecline(
      assignment.id,
      "approve",
      tenant.manager.userId,
      tenant.orgId
    );
    expect(result.status).toBe("rejected");
  });
});

describe("assigning someone who already has a row on the task", () => {
  /*
   * `TaskAssignment` is unique on (taskId, membershipId) and rejecting does not
   * delete the row — it sets `status: "rejected"`. So the slot reads as free,
   * the eligibility engine still lists the member, the UI offers them, and
   * `create` threw a raw P2002 that the route had no branch for: "Internal
   * server error" for re-offering a shift to whoever turned it down.
   */
  it("is refused by name rather than by constraint violation", async () => {
    const task = await makeTask();
    await assignmentFor(task.id, tenant.staff.membershipId, "rejected");

    await expect(
      taskService.assignStaff(
        task.id,
        tenant.orgId,
        [tenant.staff.membershipId],
        tenant.admin.userId
      )
    ).rejects.toThrow(/already has a record on this task/);
  });

  it("applies to an accepted row too, not only a released one", async () => {
    const task = await makeTask();
    await assignmentFor(task.id, tenant.staff.membershipId, "accepted");

    await expect(
      taskService.assignStaff(
        task.id,
        tenant.orgId,
        [tenant.staff.membershipId],
        tenant.admin.userId
      )
    ).rejects.toThrow(/already has a record on this task/);
  });

  /*
   * `membershipIds` is a bare `z.array(z.string())`, so ["m1","m1"] is a
   * well-formed request. It used to charge two against the headcount, create
   * one row and fail on the second — a 500 over a task that was half-assigned.
   */
  it("counts a repeated id once rather than half-failing", async () => {
    const task = await makeTask(1);

    await taskService.assignStaff(
      task.id,
      tenant.orgId,
      [tenant.staff.membershipId, tenant.staff.membershipId],
      tenant.admin.userId
    );

    const rows = await prisma.taskAssignment.findMany({
      where: { taskId: task.id },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("confirming an auto-schedule draft", () => {
  /*
   * The one write path that never went through `assignStaff`, and therefore
   * the one place over-assignment was reachable. The draft comes back from the
   * client, so a stale one — generated before someone else filled the shift —
   * wrote as many rows as it carried.
   */
  it("stops at the task's headcount however many rows the draft carries", async () => {
    const task = await makeTask(1);
    const extra = await prisma.membership.create({
      data: {
        userId: (
          await prisma.user.create({
            data: {
              name: "Extra",
              email: `extra-${Date.now()}@example.com`,
              hashedPassword: "hash",
            },
          })
        ).id,
        organizationId: tenant.orgId,
        role: "staff",
        status: "active",
      },
    });

    const result = await autoSchedule.confirmSchedule(
      tenant.orgId,
      [
        {
          taskId: task.id,
          taskTitle: task.title,
          membershipId: tenant.staff.membershipId,
          staffName: "Staff",
          reasoning: "",
        },
        {
          taskId: task.id,
          taskTitle: task.title,
          membershipId: extra.id,
          staffName: "Extra",
          reasoning: "",
        },
      ],
      tenant.admin.userId
    );

    expect(result.created).toBe(1);
    expect(result.overCapacity).toBe(1);

    const rows = await prisma.taskAssignment.findMany({
      where: { taskId: task.id },
    });
    expect(rows).toHaveLength(1);
  });

  // Seeded from what is on the task NOW, not from zero — otherwise a draft
  // generated before a manual assignment would spend the slot twice.
  it("accounts for assignments made since the draft was generated", async () => {
    const task = await makeTask(1);
    await assignmentFor(task.id, tenant.manager.membershipId, "accepted");

    const result = await autoSchedule.confirmSchedule(
      tenant.orgId,
      [
        {
          taskId: task.id,
          taskTitle: task.title,
          membershipId: tenant.staff.membershipId,
          staffName: "Staff",
          reasoning: "",
        },
      ],
      tenant.admin.userId
    );

    expect(result.created).toBe(0);
    expect(result.overCapacity).toBe(1);
  });

  it("writes one row when a draft names the same pair twice", async () => {
    const task = await makeTask(2);
    const row = {
      taskId: task.id,
      taskTitle: task.title,
      membershipId: tenant.staff.membershipId,
      staffName: "Staff",
      reasoning: "",
    };

    const result = await autoSchedule.confirmSchedule(
      tenant.orgId,
      [row, row],
      tenant.admin.userId
    );

    expect(result.created).toBe(1);
    const rows = await prisma.taskAssignment.findMany({
      where: { taskId: task.id },
    });
    expect(rows).toHaveLength(1);
  });
});
