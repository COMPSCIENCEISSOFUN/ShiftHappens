/**
 * Tests for TaskAssignment Service (Control Layer)
 * Verifies accept, reject, clock in/out business logic
 * with status transition validation.
 */
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
/**
 * A second person, for the transitions that need one.
 *
 * `userId` here owns the only membership in the fixture, so it is both the
 * assignee and the actor — which `resolveWithdrawal` and `resolveDecline` now
 * refuse, because a request for someone else's agreement is not a request if
 * you can answer it yourself.
 */
let managerUserId: string;

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

  const manager = await userRepo.create({
    name: "Manager User",
    email: "manager@example.com",
    hashedPassword: "hash",
  });
  managerUserId = manager.id;
  await prisma.membership.create({
    data: {
      userId: manager.id,
      organizationId: orgId,
      role: "manager",
      status: "active",
    },
  });

  const task = await taskRepo.create({
    title: "Test task",
    organizationId: orgId,
    createdById: userId,
  });
  taskId = task.id;
});

async function createAssignment(status = "pending") {
  const assignment = await prisma.taskAssignment.create({
    data: {
      taskId,
      membershipId,
      assignedById: userId,
      status,
    },
  });
  return assignment;
}

describe("TaskAssignmentService", () => {
  describe("accept", () => {
    it("accepts a pending assignment", async () => {
      const assignment = await createAssignment();

      const accepted = await assignmentService.accept(assignment.id, membershipId);
      expect(accepted.status).toBe("accepted");
    });

    it("throws if assignment not found", async () => {
      await expect(
        assignmentService.accept("nonexistent", membershipId)
      ).rejects.toThrow("Assignment not found");
    });

    it("throws if not the assigned member", async () => {
      const assignment = await createAssignment();

      const user2 = await userRepo.create({
        name: "Other",
        email: "other@example.com",
        hashedPassword: "hash",
      });
      const membership2 = await prisma.membership.create({
        data: { userId: user2.id, organizationId: orgId, role: "staff", status: "active" },
      });

      await expect(
        assignmentService.accept(assignment.id, membership2.id)
      ).rejects.toThrow("Not authorized");
    });

    it("throws if not in pending status", async () => {
      const assignment = await createAssignment("accepted");

      await expect(
        assignmentService.accept(assignment.id, membershipId)
      ).rejects.toThrow("Can only accept pending assignments");
    });
  });

  describe("reject", () => {
    it("rejects a pending assignment with reason", async () => {
      const assignment = await createAssignment();

      const rejected = await assignmentService.reject(
        assignment.id,
        membershipId,
        "schedule_conflict",
        "Have class until 3pm"
      );
      expect(rejected.status).toBe("rejected");
      expect(rejected.rejectionReason).toBe("schedule_conflict");
      expect(rejected.rejectionNotes).toBe("Have class until 3pm");
    });

    it("throws if not in pending status", async () => {
      const assignment = await createAssignment("accepted");

      await expect(
        assignmentService.reject(assignment.id, membershipId, "personal_reasons")
      ).rejects.toThrow("Can only reject pending assignments");
    });
  });

  describe("clockIn", () => {
    it("clocks in to an accepted assignment", async () => {
      const assignment = await createAssignment("accepted");

      const clocked = await assignmentService.clockIn(assignment.id, membershipId);
      expect(clocked.clockInTime).not.toBeNull();
    });

    it("throws if not accepted", async () => {
      const assignment = await createAssignment("pending");

      await expect(
        assignmentService.clockIn(assignment.id, membershipId)
      ).rejects.toThrow("Can only clock in to accepted assignments");
    });

    it("throws if already clocked in", async () => {
      const assignment = await createAssignment("accepted");
      await assignmentService.clockIn(assignment.id, membershipId);

      await expect(
        assignmentService.clockIn(assignment.id, membershipId)
      ).rejects.toThrow("Already clocked in");
    });
  });

  describe("clockOut", () => {
    it("clocks out to the clocked_out status (not yet completed)", async () => {
      const assignment = await createAssignment("accepted");
      await assignmentService.clockIn(assignment.id, membershipId);

      const clocked = await assignmentService.clockOut(assignment.id, membershipId);
      expect(clocked.clockOutTime).not.toBeNull();
      expect(clocked.status).toBe("clocked_out");
    });

    it("throws if not clocked in", async () => {
      const assignment = await createAssignment("accepted");

      await expect(
        assignmentService.clockOut(assignment.id, membershipId)
      ).rejects.toThrow("Must clock in before clocking out");
    });

    it("throws if already clocked out", async () => {
      const assignment = await createAssignment("accepted");
      await assignmentService.clockIn(assignment.id, membershipId);
      await assignmentService.clockOut(assignment.id, membershipId);

      await expect(
        assignmentService.clockOut(assignment.id, membershipId)
      ).rejects.toThrow("Already clocked out");
    });
  });

  describe("complete", () => {
    it("marks a clocked-out assignment as completed", async () => {
      const assignment = await createAssignment("accepted");
      await assignmentService.clockIn(assignment.id, membershipId);
      await assignmentService.clockOut(assignment.id, membershipId);

      const completed = await assignmentService.complete(assignment.id, membershipId);
      expect(completed.status).toBe("completed");
    });

    it("throws if not clocked out yet", async () => {
      const assignment = await createAssignment("accepted");

      await expect(
        assignmentService.complete(assignment.id, membershipId)
      ).rejects.toThrow("Can only complete a task after clocking out");
    });
  });

  describe("requestWithdrawal", () => {
    it("records a withdrawal request with reason on an accepted assignment", async () => {
      const assignment = await createAssignment("accepted");

      const result = await assignmentService.requestWithdrawal(
        assignment.id,
        membershipId,
        "Family emergency"
      );
      expect(result.status).toBe("withdrawal_requested");
      expect(result.withdrawalReason).toBe("Family emergency");
    });

    it("throws if the assignment is not accepted", async () => {
      const assignment = await createAssignment("pending");

      await expect(
        assignmentService.requestWithdrawal(assignment.id, membershipId, "reason")
      ).rejects.toThrow("Can only withdraw from an accepted task");
    });
  });

  describe("resolveWithdrawal", () => {
    it("approve removes the assignment", async () => {
      const assignment = await createAssignment("accepted");
      await assignmentService.requestWithdrawal(assignment.id, membershipId, "reason");

      await assignmentService.resolveWithdrawal(assignment.id, "approve", managerUserId, orgId);

      const found = await prisma.taskAssignment.findUnique({
        where: { id: assignment.id },
      });
      expect(found).toBeNull();
    });

    it("deny reverts the assignment to accepted", async () => {
      const assignment = await createAssignment("accepted");
      await assignmentService.requestWithdrawal(assignment.id, membershipId, "reason");

      const result = await assignmentService.resolveWithdrawal(
        assignment.id,
        "deny",
        managerUserId,
        orgId
      );
      expect(result.status).toBe("accepted");
    });

    it("throws if there is no pending withdrawal request", async () => {
      const assignment = await createAssignment("accepted");

      await expect(
        assignmentService.resolveWithdrawal(assignment.id, "approve", managerUserId, orgId)
      ).rejects.toThrow("No pending withdrawal request");
    });
  });
});