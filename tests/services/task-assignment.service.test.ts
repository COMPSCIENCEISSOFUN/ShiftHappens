import { describe, it, expect, beforeEach } from "vitest";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { TaskRepository } from "@/repositories/task.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const assignmentService = new TaskAssignmentService();
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

async function createAssignment(status = "assigned") {
  return prisma.taskAssignment.create({
    data: {
      taskId,
      membershipId,
      assignedById: userId,
      status,
    },
  });
}

describe("TaskAssignmentService", () => {
  describe("clockIn", () => {
    it("clocks in to an assigned task and marks it in progress", async () => {
      const assignment = await createAssignment();

      const clocked = await assignmentService.clockIn(assignment.id, membershipId);

      expect(clocked.clockInTime).not.toBeNull();
      expect(clocked.status).toBe("in_progress");
    });

    it("throws if assignment is not assigned", async () => {
      const assignment = await createAssignment("clocked_out");

      await expect(
        assignmentService.clockIn(assignment.id, membershipId)
      ).rejects.toThrow("Can only clock in to assigned tasks");
    });

    it("throws if not the assigned member", async () => {
      const assignment = await createAssignment();
      const user2 = await userRepo.create({
        name: "Other",
        email: "other@example.com",
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

      await expect(
        assignmentService.clockIn(assignment.id, membership2.id)
      ).rejects.toThrow("Not authorized");
    });
  });

  describe("clockOut", () => {
    it("clocks out to the clocked_out status", async () => {
      const assignment = await createAssignment();
      await assignmentService.clockIn(assignment.id, membershipId);

      const clocked = await assignmentService.clockOut(assignment.id, membershipId);

      expect(clocked.clockOutTime).not.toBeNull();
      expect(clocked.status).toBe("clocked_out");
    });

    it("throws if not clocked in", async () => {
      const assignment = await createAssignment();

      await expect(
        assignmentService.clockOut(assignment.id, membershipId)
      ).rejects.toThrow("Must clock in before clocking out");
    });
  });

  describe("complete", () => {
    it("marks a clocked-out assignment as completed", async () => {
      const assignment = await createAssignment();
      await assignmentService.clockIn(assignment.id, membershipId);
      await assignmentService.clockOut(assignment.id, membershipId);

      const completed = await assignmentService.complete(assignment.id, membershipId);

      expect(completed.status).toBe("completed");
      await expect(prisma.task.findUniqueOrThrow({ where: { id: taskId } })).resolves.toMatchObject({ status: "completed" });
    });

    it("keeps a multi-staff task open until every assigned staff member has completed", async () => {
      await prisma.task.update({ where: { id: taskId }, data: { requiredHeadcount: 2 } });
      const otherUser = await userRepo.create({ name: "Second Staff", email: "second-completion@example.com", hashedPassword: "hash" });
      const otherMembership = await prisma.membership.create({ data: { userId: otherUser.id, organizationId: orgId, role: "staff", status: "active" } });
      const first = await createAssignment();
      const second = await prisma.taskAssignment.create({ data: { taskId, membershipId: otherMembership.id, assignedById: userId, status: "clocked_out", clockInTime: new Date(Date.now() - 3_600_000), clockOutTime: new Date() } });
      await assignmentService.clockIn(first.id, membershipId);
      await assignmentService.clockOut(first.id, membershipId);
      await assignmentService.complete(first.id, membershipId);
      await expect(prisma.task.findUniqueOrThrow({ where: { id: taskId } })).resolves.toMatchObject({ status: "open" });
      await assignmentService.complete(second.id, otherMembership.id);
      await expect(prisma.task.findUniqueOrThrow({ where: { id: taskId } })).resolves.toMatchObject({ status: "completed" });
    });

    it("throws if not clocked out yet", async () => {
      const assignment = await createAssignment();

      await expect(
        assignmentService.complete(assignment.id, membershipId)
      ).rejects.toThrow("Can only complete a task after clocking out");
    });
  });

  describe("requestWithdrawal", () => {
    it("records a withdrawal request with reason on an assigned task", async () => {
      const assignment = await createAssignment();

      const result = await assignmentService.requestWithdrawal(
        assignment.id,
        membershipId,
        "Family emergency"
      );

      expect(result.status).toBe("withdrawal_requested");
      expect(result.withdrawalReason).toBe("Family emergency");
      expect(result.withdrawalRequestedAt).toBeInstanceOf(Date);
      expect(result.withdrawalStatusBeforeRequest).toBe("assigned");
    });

    it("records a withdrawal request on an in-progress task", async () => {
      const assignment = await createAssignment();
      await assignmentService.clockIn(assignment.id, membershipId);

      const result = await assignmentService.requestWithdrawal(
        assignment.id,
        membershipId,
        "Feeling unwell"
      );

      expect(result.status).toBe("withdrawal_requested");
      expect(result.withdrawalStatusBeforeRequest).toBe("in_progress");
    });

    it("throws if the assignment is not active", async () => {
      const assignment = await createAssignment("completed");

      await expect(
        assignmentService.requestWithdrawal(assignment.id, membershipId, "reason")
      ).rejects.toThrow("Can only withdraw from an active task");
    });

    it("prevents duplicate unresolved withdrawal requests", async () => {
      const assignment = await createAssignment();
      await assignmentService.requestWithdrawal(
        assignment.id,
        membershipId,
        "First reason"
      );

      await expect(
        assignmentService.requestWithdrawal(assignment.id, membershipId, "Second reason")
      ).rejects.toThrow("Can only withdraw from an active task");
    });
  });

  describe("resolveWithdrawal", () => {
    it("approve marks withdrawn and preserves the assignment row", async () => {
      const assignment = await createAssignment();
      await assignmentService.requestWithdrawal(assignment.id, membershipId, "reason");

      const result = await assignmentService.resolveWithdrawal(
        assignment.id,
        "approve",
        userId,
        orgId
      );

      expect(result.status).toBe("withdrawn");
      expect(result.withdrawalDecision).toBe("approved");
      expect(result.withdrawalReviewedById).toBe(userId);
      expect(result.withdrawalReviewedAt).toBeInstanceOf(Date);

      const stillExists = await prisma.taskAssignment.findUnique({
        where: { id: assignment.id },
      });
      expect(stillExists).not.toBeNull();
      expect(stillExists!.status).toBe("withdrawn");
    });

    it("deny reverts the assignment to assigned", async () => {
      const assignment = await createAssignment();
      await assignmentService.requestWithdrawal(assignment.id, membershipId, "reason");

      const result = await assignmentService.resolveWithdrawal(
        assignment.id,
        "deny",
        userId,
        orgId
      );

      expect(result.status).toBe("assigned");
      expect(result.withdrawalDecision).toBe("denied");
      expect(result.withdrawalReviewedById).toBe(userId);
      expect(result.withdrawalReviewedAt).toBeInstanceOf(Date);
    });

    it("deny restores in_progress when request was made after clock-in", async () => {
      const assignment = await createAssignment();
      await assignmentService.clockIn(assignment.id, membershipId);
      await assignmentService.requestWithdrawal(assignment.id, membershipId, "reason");

      const result = await assignmentService.resolveWithdrawal(
        assignment.id,
        "deny",
        userId,
        orgId
      );

      expect(result.status).toBe("in_progress");
      expect(result.clockInTime).toBeInstanceOf(Date);
      expect(result.clockOutTime).toBeNull();
    });

    it("approve after clock-in closes the partial worked interval", async () => {
      const assignment = await createAssignment();
      await assignmentService.clockIn(assignment.id, membershipId);
      await assignmentService.requestWithdrawal(assignment.id, membershipId, "reason");

      const result = await assignmentService.resolveWithdrawal(
        assignment.id,
        "approve",
        userId,
        orgId
      );

      expect(result.status).toBe("withdrawn");
      expect(result.clockInTime).toBeInstanceOf(Date);
      expect(result.clockOutTime).toBeInstanceOf(Date);
    });
  });
});
