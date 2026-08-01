import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { NotificationRepository } from "@/repositories/notification.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { TaskService } from "@/services/task.service";
import { cleanDatabase } from "../helpers/cleanup";

const assignmentService = new TaskAssignmentService();
const taskService = new TaskService();
const notificationRepo = new NotificationRepository();
const organizationRepo = new OrganizationRepository();

let organizationId: string;
let adminUserId: string;

async function createUser(name: string, email: string) {
  return prisma.user.create({
    data: { name, email, hashedPassword: "hash", emailVerified: new Date() },
  });
}

async function createStaff(name: string) {
  const user = await createUser(name, `${name.toLowerCase()}@example.com`);
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId,
      role: "staff",
      status: "active",
    },
  });
  return { user, membership };
}

async function createTask(requiredHeadcount = 1) {
  return prisma.task.create({
    data: {
      title: "Replace kitchen shift",
      organizationId,
      requiredHeadcount,
      createdById: adminUserId,
    },
  });
}

async function assign(taskId: string, membershipId: string) {
  return prisma.taskAssignment.create({
    data: {
      taskId,
      membershipId,
      assignedById: adminUserId,
      status: "assigned",
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();

  const admin = await createUser("Admin", "admin@example.com");
  adminUserId = admin.id;
  const organization = await organizationRepo.create(
    { name: "Replacement Org", slug: "replacement-org" },
    admin.id
  );
  organizationId = organization.id;

  await prisma.companySettings.create({
    data: { organizationId, allocationMode: "auto" },
  });
});

describe("Phase 3 replacement allocation", () => {
  it("automatically assigns an eligible replacement after withdrawal approval", async () => {
    const departing = await createStaff("Departing");
    const replacement = await createStaff("Replacement");
    const task = await createTask();
    const original = await assign(task.id, departing.membership.id);

    await assignmentService.requestWithdrawal(
      original.id,
      departing.membership.id,
      "Family emergency"
    );
    await assignmentService.resolveWithdrawal(
      original.id,
      "approve",
      adminUserId,
      organizationId
    );

    const assignments = await prisma.taskAssignment.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
    });
    expect(assignments).toHaveLength(2);
    expect(assignments[0].status).toBe("withdrawn");
    expect(assignments[1]).toMatchObject({
      membershipId: replacement.membership.id,
      status: "assigned",
      assignedById: adminUserId,
    });
    expect(assignments[1].membershipId).not.toBe(departing.membership.id);
  });

  it("does not reselect the withdrawn worker or an existing active assignee", async () => {
    const departing = await createStaff("Departing");
    const alreadyAssigned = await createStaff("Current");
    const replacement = await createStaff("Available");
    const task = await createTask(2);
    const original = await assign(task.id, departing.membership.id);
    await assign(task.id, alreadyAssigned.membership.id);

    await assignmentService.requestWithdrawal(
      original.id,
      departing.membership.id,
      "Cannot continue"
    );
    await assignmentService.resolveWithdrawal(
      original.id,
      "approve",
      adminUserId,
      organizationId
    );

    const active = await prisma.taskAssignment.findMany({
      where: { taskId: task.id, status: "assigned" },
    });
    expect(active.map((item) => item.membershipId).sort()).toEqual(
      [alreadyAssigned.membership.id, replacement.membership.id].sort()
    );
  });

  it("keeps authoritative partial coverage and alerts the manager when no candidate exists", async () => {
    const departing = await createStaff("OnlyStaff");
    const task = await createTask();
    const original = await assign(task.id, departing.membership.id);

    await assignmentService.requestWithdrawal(
      original.id,
      departing.membership.id,
      "Cannot attend"
    );
    await assignmentService.resolveWithdrawal(
      original.id,
      "approve",
      adminUserId,
      organizationId
    );

    const activeCount = await prisma.taskAssignment.count({
      where: { taskId: task.id, status: "assigned" },
    });
    const notifications = await notificationRepo.findByUserId(
      adminUserId,
      organizationId
    );

    expect(activeCount).toBe(0);
    expect(
      notifications.some(
        (item) => item.title === "Replacement needed - no eligible staff"
      )
    ).toBe(true);
  });

  it("assigns available replacements and alerts for any remaining headcount gap", async () => {
    const departing = await createStaff("Departing");
    const current = await createStaff("Current");
    const onlyReplacement = await createStaff("OnlyReplacement");
    const task = await createTask(3);
    const original = await assign(task.id, departing.membership.id);
    await assign(task.id, current.membership.id);

    await assignmentService.requestWithdrawal(
      original.id,
      departing.membership.id,
      "Cannot continue"
    );
    await assignmentService.resolveWithdrawal(
      original.id,
      "approve",
      adminUserId,
      organizationId
    );

    const active = await prisma.taskAssignment.findMany({
      where: { taskId: task.id, status: "assigned" },
    });
    const notifications = await notificationRepo.findByUserId(
      adminUserId,
      organizationId
    );

    expect(active.map((item) => item.membershipId).sort()).toEqual(
      [current.membership.id, onlyReplacement.membership.id].sort()
    );
    expect(active).toHaveLength(2);
    expect(
      notifications.some(
        (item) =>
          item.title === "Replacement needed - no eligible staff" &&
          item.message.includes("still needs 1 staff")
      )
    ).toBe(true);
  });

  it("automatically replaces a staff member removed by a manager", async () => {
    const removed = await createStaff("Removed");
    const replacement = await createStaff("Ready");
    const task = await createTask();
    const original = await assign(task.id, removed.membership.id);

    await taskService.cancelAssignment(original.id, organizationId, adminUserId);

    const active = await prisma.taskAssignment.findMany({
      where: { taskId: task.id, status: "assigned" },
    });
    expect(active).toHaveLength(1);
    expect(active[0].membershipId).toBe(replacement.membership.id);
  });

  it("still allows a manager to fill an unresolved gap manually", async () => {
    const departing = await createStaff("Departing");
    const task = await createTask();
    const original = await assign(task.id, departing.membership.id);

    await assignmentService.requestWithdrawal(
      original.id,
      departing.membership.id,
      "Cannot attend"
    );
    await assignmentService.resolveWithdrawal(
      original.id,
      "approve",
      adminUserId,
      organizationId
    );

    const manualReplacement = await createStaff("Manual");
    const created = await taskService.assignStaff(
      task.id,
      organizationId,
      [manualReplacement.membership.id],
      adminUserId
    );

    expect(created).toHaveLength(1);
    expect(created[0].membershipId).toBe(manualReplacement.membership.id);
  });
});
