import { describe, it, expect, beforeEach } from "vitest";
import { TaskAssignmentRepository } from "@/repositories/task-assignment.repository";
import { TaskRepository } from "@/repositories/task.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const assignmentRepo = new TaskAssignmentRepository();
const taskRepo = new TaskRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let userId: string;
let membershipId: string;
let taskId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  userId = user.id;

  const org = await orgRepo.create(
    { name: "Acme Corp", slug: "acme-corp" },
    user.id
  );
  orgId = org.id;

  const membership = await prisma.membership.findFirst({
    where: { organizationId: orgId },
  });
  membershipId = membership!.id;

  const task = await taskRepo.create({
    title: "Test task",
    organizationId: orgId,
    createdById: userId,
  });
  taskId = task.id;
});

describe("TaskAssignmentRepository", () => {
  it("creates an active assignment by default", async () => {
    const assignment = await assignmentRepo.create({
      taskId,
      membershipId,
      assignedById: userId,
    });

    expect(assignment.status).toBe("assigned");
  });

  it("finds an assignment with task and user details", async () => {
    const created = await assignmentRepo.create({
      taskId,
      membershipId,
      assignedById: userId,
    });

    const found = await assignmentRepo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found!.task.title).toBe("Test task");
    expect(found!.membership.user).toBeDefined();
  });

  it("filters member assignments by canonical status", async () => {
    await assignmentRepo.create({ taskId, membershipId, assignedById: userId });
    const task2 = await taskRepo.create({
      title: "Task 2",
      organizationId: orgId,
      createdById: userId,
    });
    const second = await assignmentRepo.create({
      taskId: task2.id,
      membershipId,
      assignedById: userId,
    });
    await assignmentRepo.updateStatus(second.id, "in_progress");

    const assigned = await assignmentRepo.findByMembershipId(membershipId, "assigned");
    const inProgress = await assignmentRepo.findByMembershipId(
      membershipId,
      "in_progress"
    );

    expect(assigned).toHaveLength(1);
    expect(inProgress).toHaveLength(1);
  });

  it("moves clock-in to in_progress", async () => {
    const assignment = await assignmentRepo.create({
      taskId,
      membershipId,
      assignedById: userId,
    });

    const clocked = await assignmentRepo.clockIn(assignment.id);

    expect(clocked.clockInTime).toBeInstanceOf(Date);
    expect(clocked.status).toBe("in_progress");
  });

  it("moves clock-out to clocked_out", async () => {
    const assignment = await assignmentRepo.create({
      taskId,
      membershipId,
      assignedById: userId,
    });
    await assignmentRepo.clockIn(assignment.id);

    const clocked = await assignmentRepo.clockOut(assignment.id);

    expect(clocked.clockOutTime).toBeInstanceOf(Date);
    expect(clocked.status).toBe("clocked_out");
  });

  it("marks a clocked-out assignment as completed", async () => {
    const assignment = await assignmentRepo.create({
      taskId,
      membershipId,
      assignedById: userId,
    });
    await assignmentRepo.clockIn(assignment.id);
    await assignmentRepo.clockOut(assignment.id);

    const completed = await assignmentRepo.complete(assignment.id);

    expect(completed.status).toBe("completed");
  });

  it("counts only slot-occupying assignments for a task", async () => {
    const user2 = await userRepo.create({
      name: "Staff",
      email: "staff@example.com",
      hashedPassword: "hash",
    });
    const membership2 = await prisma.membership.create({
      data: {
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
        status: "active",
      },
    });

    await assignmentRepo.create({ taskId, membershipId, assignedById: userId });
    await assignmentRepo.create({
      taskId,
      membershipId: membership2.id,
      assignedById: userId,
      status: "cancelled",
    });

    const count = await assignmentRepo.countActiveByTaskId(taskId);

    expect(count).toBe(1);
  });
});
