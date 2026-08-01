/**
 * Tests for Task Repository (Entity Layer)
 * Verifies task CRUD operations with org-scoped queries,
 * filtering, and scheduling conflict detection.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskRepository } from "@/repositories/task.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const taskRepo = new TaskRepository();
const orgRepo = new OrganizationRepository();
const deptRepo = new DepartmentRepository();
const userRepo = new UserRepository();

let orgId: string;
let deptId: string;
let userId: string;

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

  const dept = await deptRepo.create({
    name: "Kitchen",
    organizationId: orgId,
  });
  deptId = dept.id;
});

describe("TaskRepository", () => {
  describe("create", () => {
    it("creates a task", async () => {
      const task = await taskRepo.create({
        title: "Clean kitchen",
        description: "Deep clean all surfaces",
        location: "Main kitchen",
        instructions: "Use food-safe sanitizer.",
        organizationId: orgId,
        departmentId: deptId,
        requiredHeadcount: 2,
        priority: "high",
        createdById: userId,
      });

      expect(task.id).toBeDefined();
      expect(task.title).toBe("Clean kitchen");
      expect(task.requiredHeadcount).toBe(2);
      expect(task.priority).toBe("high");
      expect(task.status).toBe("open");
      expect(task.location).toBe("Main kitchen");
      expect(task.instructions).toBe("Use food-safe sanitizer.");
    });

    it("creates a task without department", async () => {
      const task = await taskRepo.create({
        title: "General meeting",
        organizationId: orgId,
        createdById: userId,
      });

      expect(task.departmentId).toBeNull();
    });

    it("creates a task with scheduling", async () => {
      const start = new Date("2026-06-01T08:00:00Z");
      const end = new Date("2026-06-01T10:00:00Z");

      const task = await taskRepo.create({
        title: "Morning prep",
        organizationId: orgId,
        createdById: userId,
        scheduledStart: start,
        scheduledEnd: end,
      });

      expect(task.scheduledStart).toEqual(start);
      expect(task.scheduledEnd).toEqual(end);
    });
  });

  describe("findById", () => {
    it("finds a task with assignments", async () => {
      const task = await taskRepo.create({
        title: "Clean kitchen",
        organizationId: orgId,
        createdById: userId,
      });

      const found = await taskRepo.findById(task.id);
      expect(found).not.toBeNull();
      expect(found!.title).toBe("Clean kitchen");
      expect(found!.assignments).toBeDefined();
    });

    it("returns null for non-existent ID", async () => {
      const found = await taskRepo.findById("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("findByOrganizationId", () => {
    it("returns all tasks for an org", async () => {
      await taskRepo.create({ title: "Task 1", organizationId: orgId, createdById: userId });
      await taskRepo.create({ title: "Task 2", organizationId: orgId, createdById: userId });
      await taskRepo.create({ title: "Task 3", organizationId: orgId, createdById: userId });

      const tasks = await taskRepo.findByOrganizationId(orgId);
      expect(tasks).toHaveLength(3);
    });

    it("filters by status", async () => {
      await taskRepo.create({ title: "Open task", organizationId: orgId, createdById: userId });
      const completed = await taskRepo.create({ title: "Done task", organizationId: orgId, createdById: userId });
      await prisma.task.update({ where: { id: completed.id }, data: { status: "completed" } });

      const tasks = await taskRepo.findByOrganizationId(orgId, { status: "open" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Open task");
    });

    it("filters by department", async () => {
      await taskRepo.create({ title: "Kitchen task", organizationId: orgId, departmentId: deptId, createdById: userId });
      await taskRepo.create({ title: "No dept task", organizationId: orgId, createdById: userId });

      const tasks = await taskRepo.findByOrganizationId(orgId, { departmentId: deptId });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Kitchen task");
    });

    it("filters by priority", async () => {
      await taskRepo.create({ title: "Urgent task", organizationId: orgId, createdById: userId, priority: "urgent" });
      await taskRepo.create({ title: "Low task", organizationId: orgId, createdById: userId, priority: "low" });

      const tasks = await taskRepo.findByOrganizationId(orgId, { priority: "urgent" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Urgent task");
    });

    it("does not return tasks from other orgs", async () => {
      const user2 = await userRepo.create({ name: "Other", email: "other@example.com", hashedPassword: "hash" });
      const org2 = await orgRepo.create({ name: "Other Corp", slug: "other-corp" }, user2.id);

      await taskRepo.create({ title: "Org 1 task", organizationId: orgId, createdById: userId });
      await taskRepo.create({ title: "Org 2 task", organizationId: org2.id, createdById: user2.id });

      const tasks = await taskRepo.findByOrganizationId(orgId);
      expect(tasks).toHaveLength(1);
    });
  });

  describe("findByDepartmentId", () => {
    it("returns tasks for a department", async () => {
      await taskRepo.create({ title: "Kitchen task", organizationId: orgId, departmentId: deptId, createdById: userId });
      await taskRepo.create({ title: "No dept", organizationId: orgId, createdById: userId });

      const tasks = await taskRepo.findByDepartmentId(deptId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Kitchen task");
    });
  });

  describe("update", () => {
    it("updates task fields", async () => {
      const task = await taskRepo.create({ title: "Old title", organizationId: orgId, createdById: userId });

      const updated = await taskRepo.update(task.id, {
        title: "New title",
        priority: "urgent",
        status: "in_progress",
        location: "Back room",
        instructions: "Check the inventory sheet.",
      });

      expect(updated.title).toBe("New title");
      expect(updated.priority).toBe("urgent");
      expect(updated.status).toBe("in_progress");
      expect(updated.location).toBe("Back room");
      expect(updated.instructions).toBe("Check the inventory sheet.");
    });
  });

  describe("delete", () => {
    it("deletes a task", async () => {
      const task = await taskRepo.create({ title: "Delete me", organizationId: orgId, createdById: userId });

      await taskRepo.delete(task.id);

      const found = await taskRepo.findById(task.id);
      expect(found).toBeNull();
    });
  });

  describe("findConflictingTasks", () => {
    it("finds tasks that overlap in time for a membership", async () => {
      const membership = await prisma.membership.findFirst({ where: { organizationId: orgId } });

      const task1 = await taskRepo.create({
        title: "Morning shift",
        organizationId: orgId,
        createdById: userId,
        scheduledStart: new Date("2026-06-01T08:00:00Z"),
        scheduledEnd: new Date("2026-06-01T12:00:00Z"),
      });

      await prisma.taskAssignment.create({
        data: {
          taskId: task1.id,
          membershipId: membership!.id,
          status: "assigned",
          assignedById: userId,
        },
      });

      const conflicts = await taskRepo.findConflictingTasks(
        membership!.id,
        new Date("2026-06-01T10:00:00Z"),
        new Date("2026-06-01T14:00:00Z")
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].title).toBe("Morning shift");
    });

    it("returns empty when no conflicts", async () => {
      const membership = await prisma.membership.findFirst({ where: { organizationId: orgId } });

      const task1 = await taskRepo.create({
        title: "Morning shift",
        organizationId: orgId,
        createdById: userId,
        scheduledStart: new Date("2026-06-01T08:00:00Z"),
        scheduledEnd: new Date("2026-06-01T12:00:00Z"),
      });

      await prisma.taskAssignment.create({
        data: {
          taskId: task1.id,
          membershipId: membership!.id,
          status: "assigned",
          assignedById: userId,
        },
      });

      const conflicts = await taskRepo.findConflictingTasks(
        membership!.id,
        new Date("2026-06-01T14:00:00Z"),
        new Date("2026-06-01T18:00:00Z")
      );

      expect(conflicts).toHaveLength(0);
    });

    it("ignores cancelled and completed assignments", async () => {
      const membership = await prisma.membership.findFirst({ where: { organizationId: orgId } });

      const task1 = await taskRepo.create({
        title: "Cancelled shift",
        organizationId: orgId,
        createdById: userId,
        scheduledStart: new Date("2026-06-01T08:00:00Z"),
        scheduledEnd: new Date("2026-06-01T12:00:00Z"),
      });

      await prisma.taskAssignment.create({
        data: {
          taskId: task1.id,
          membershipId: membership!.id,
          status: "cancelled",
          assignedById: userId,
        },
      });

      const conflicts = await taskRepo.findConflictingTasks(
        membership!.id,
        new Date("2026-06-01T10:00:00Z"),
        new Date("2026-06-01T14:00:00Z")
      );

      expect(conflicts).toHaveLength(0);
    });
  });
});
