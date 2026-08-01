/**
 * Tests for TaskAssignment Repository (Entity Layer)
 * Verifies assignment CRUD, status transitions,
 * and clock in/out operations.
 */
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
  describe("create", () => {
    it("creates an assignment", async () => {
      const assignment = await assignmentRepo.create({
        taskId,
        membershipId,
        assignedById: userId,
      });

      expect(assignment.id).toBeDefined();
      expect(assignment.taskId).toBe(taskId);
      expect(assignment.membershipId).toBe(membershipId);
      expect(assignment.status).toBe("pending");
    });
  });

  describe("findById", () => {
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

    it("returns null for non-existent ID", async () => {
      const found = await assignmentRepo.findById("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("findByTaskId", () => {
    it("returns all assignments for a task", async () => {
      const user2 = await userRepo.create({
        name: "Staff",
        email: "staff@example.com",
        hashedPassword: "hash",
      });
      const membership2 = await prisma.membership.create({
        data: { userId: user2.id, organizationId: orgId, role: "staff", status: "active" },
      });

      await assignmentRepo.create({ taskId, membershipId, assignedById: userId });
      await assignmentRepo.create({ taskId, membershipId: membership2.id, assignedById: userId });

      const assignments = await assignmentRepo.findByTaskId(taskId);
      expect(assignments).toHaveLength(2);
    });
  });

  describe("findByMembershipId", () => {
    it("returns all assignments for a member", async () => {
      const task2 = await taskRepo.create({
        title: "Task 2",
        organizationId: orgId,
        createdById: userId,
      });

      await assignmentRepo.create({ taskId, membershipId, assignedById: userId });
      await assignmentRepo.create({ taskId: task2.id, membershipId, assignedById: userId });

      const assignments = await assignmentRepo.findByMembershipId(membershipId);
      expect(assignments).toHaveLength(2);
    });

    it("filters by status", async () => {
      await assignmentRepo.create({ taskId, membershipId, assignedById: userId });
      const task2 = await taskRepo.create({ title: "Task 2", organizationId: orgId, createdById: userId });
      const a2 = await assignmentRepo.create({ taskId: task2.id, membershipId, assignedById: userId });
      await assignmentRepo.updateStatus(a2.id, "accepted");

      const pending = await assignmentRepo.findByMembershipId(membershipId, "pending");
      expect(pending).toHaveLength(1);

      const accepted = await assignmentRepo.findByMembershipId(membershipId, "accepted");
      expect(accepted).toHaveLength(1);
    });
  });

  describe("updateStatus", () => {
    it("accepts an assignment", async () => {
      const assignment = await assignmentRepo.create({ taskId, membershipId, assignedById: userId });

      const updated = await assignmentRepo.updateStatus(assignment.id, "accepted");
      expect(updated.status).toBe("accepted");
    });

    it("rejects an assignment with reason", async () => {
      const assignment = await assignmentRepo.create({ taskId, membershipId, assignedById: userId });

      const updated = await assignmentRepo.reject(assignment.id, "schedule_conflict", "Have class until 3pm");
      expect(updated.status).toBe("rejected");
      expect(updated.rejectionReason).toBe("schedule_conflict");
      expect(updated.rejectionNotes).toBe("Have class until 3pm");
    });
  });

  describe("clockIn", () => {
    it("sets clock in time", async () => {
      const assignment = await assignmentRepo.create({ taskId, membershipId, assignedById: userId });
      await assignmentRepo.updateStatus(assignment.id, "accepted");

      const clocked = await assignmentRepo.clockIn(assignment.id);
      expect(clocked.clockInTime).not.toBeNull();
      expect(clocked.clockInTime).toBeInstanceOf(Date);
    });
  });

  describe("clockOut", () => {
    it("sets clock out time", async () => {
      const assignment = await assignmentRepo.create({ taskId, membershipId, assignedById: userId });
      await assignmentRepo.updateStatus(assignment.id, "accepted");
      await assignmentRepo.clockIn(assignment.id);

      const clocked = await assignmentRepo.clockOut(assignment.id);
      expect(clocked.clockOutTime).not.toBeNull();
      expect(clocked.status).toBe("clocked_out");
    });
  });

  describe("complete", () => {
    it("marks a clocked-out assignment as completed", async () => {
      const assignment = await assignmentRepo.create({ taskId, membershipId, assignedById: userId });
      await assignmentRepo.updateStatus(assignment.id, "accepted");
      await assignmentRepo.clockIn(assignment.id);
      await assignmentRepo.clockOut(assignment.id);

      const completed = await assignmentRepo.complete(assignment.id);
      expect(completed.status).toBe("completed");
    });
  });

  describe("countByTaskId", () => {
    it("counts active assignments for a task", async () => {
      const user2 = await userRepo.create({ name: "Staff", email: "staff@example.com", hashedPassword: "hash" });
      const membership2 = await prisma.membership.create({
        data: { userId: user2.id, organizationId: orgId, role: "staff", status: "active" },
      });

      await assignmentRepo.create({ taskId, membershipId, assignedById: userId });
      const a2 = await assignmentRepo.create({ taskId, membershipId: membership2.id, assignedById: userId });
      await assignmentRepo.reject(a2.id, "personal_reasons");

      const count = await assignmentRepo.countActiveByTaskId(taskId);
      expect(count).toBe(1);
    });
  });
});
/**
 * Department `color` must be present in EVERY task-department select.
 *
 * The project's own standing rule, and these two methods were the only selects
 * in the codebase that omitted it — every other task-department select in
 * `task.repository.ts` and `reporting.repository.ts` includes it. Latent rather
 * than visible today, because the My Tasks page happens to render the name
 * only; the moment anything shows a department chip from either of these it
 * renders colourless beside the same department shown correctly elsewhere.
 */
describe("TaskAssignmentRepository — department colour is selected", () => {
  /** A task inside a coloured department — the shared fixture task has none. */
  async function colouredTask() {
    const dept = await prisma.department.create({
      data: { name: "Kitchen", organizationId: orgId, color: "#EF4444" },
    });
    const task = await taskRepo.create({
      title: "Coloured task",
      organizationId: orgId,
      departmentId: dept.id,
      createdById: userId,
    });
    return task.id;
  }

  it("findById returns the department colour", async () => {
    const id = await colouredTask();
    const assignment = await assignmentRepo.create({
      taskId: id,
      membershipId,
      assignedById: userId,
      status: "pending",
    });

    const found = await assignmentRepo.findById(assignment.id);

    expect(found!.task.department).not.toBeNull();
    expect(found!.task.department!.color).toBe("#EF4444");
  });

  it("findByMembershipId returns the department colour", async () => {
    const id = await colouredTask();
    await assignmentRepo.create({
      taskId: id,
      membershipId,
      assignedById: userId,
      status: "pending",
    });

    const rows = await assignmentRepo.findByMembershipId(membershipId);

    const row = rows.find((r) => r.task.id === id);
    expect(row!.task.department!.color).toBe("#EF4444");
  });

  it("still handles a task with no department", async () => {
    // The fixture task is department-less; selecting an extra column must not
    // change how that case behaves.
    const assignment = await assignmentRepo.create({
      taskId,
      membershipId,
      assignedById: userId,
      status: "pending",
    });

    const found = await assignmentRepo.findById(assignment.id);

    expect(found!.task.department).toBeNull();
  });
});
