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
      });

      expect(updated.title).toBe("New title");
      expect(updated.priority).toBe("urgent");
      expect(updated.status).toBe("in_progress");
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
          status: "accepted",
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
          status: "accepted",
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

    /*
     * The defect this closes. Cancelling a shift notifies everyone rostered
     * that they are no longer scheduled and deliberately LEAVES their
     * assignment rows accepted — a member's history reads "Cancelled" off the
     * task's status, and rewriting the assignment would take that away. This
     * query only ever looked at the assignment, so the member stayed blocked at
     * that hour by a shift that was not happening.
     */
    it("does not count a cancelled shift as a conflict", async () => {
      const membership = await prisma.membership.findFirst({ where: { organizationId: orgId } });

      const task = await taskRepo.create({
        title: "Called off",
        organizationId: orgId,
        createdById: userId,
        scheduledStart: new Date("2026-06-01T08:00:00Z"),
        scheduledEnd: new Date("2026-06-01T12:00:00Z"),
      });

      await prisma.taskAssignment.create({
        data: {
          taskId: task.id,
          membershipId: membership!.id,
          // Still accepted, exactly as cancelling leaves it.
          status: "accepted",
          assignedById: userId,
        },
      });

      // Blocking while the shift stands is the other half of the rule: without
      // this line the test would pass against a query that finds nothing at all.
      expect(
        await taskRepo.findConflictingTasks(
          membership!.id,
          new Date("2026-06-01T10:00:00Z"),
          new Date("2026-06-01T14:00:00Z")
        )
      ).toHaveLength(1);

      await prisma.task.update({
        where: { id: task.id },
        data: { status: "cancelled" },
      });

      expect(
        await taskRepo.findConflictingTasks(
          membership!.id,
          new Date("2026-06-01T10:00:00Z"),
          new Date("2026-06-01T14:00:00Z")
        )
      ).toHaveLength(0);
    });

    it("ignores rejected and completed assignments", async () => {
      const membership = await prisma.membership.findFirst({ where: { organizationId: orgId } });

      const task1 = await taskRepo.create({
        title: "Rejected shift",
        organizationId: orgId,
        createdById: userId,
        scheduledStart: new Date("2026-06-01T08:00:00Z"),
        scheduledEnd: new Date("2026-06-01T12:00:00Z"),
      });

      await prisma.taskAssignment.create({
        data: {
          taskId: task1.id,
          membershipId: membership!.id,
          status: "rejected",
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

  /*
   * The OTHER conflict query, and the reason it needs its own tests.
   *
   * `findConflictingTasks` answers "may I put this person here" on the assign
   * path. This one answers "what are they already on" for the eligibility
   * engine, which is what the assign panel prints beside a greyed-out name. Two
   * queries, one question, and they have drifted before: this one counted a
   * pending withdrawal and the other did not, so the panel and the write path
   * could disagree about the same member at the same moment.
   *
   * `excludeTaskId` is not optional here — the engine is always staffing some
   * shift, and that shift must not report itself as its own clash.
   */
  describe("findConflictingTaskTitles", () => {
    async function bookedMember() {
      const membership = await prisma.membership.findFirst({
        where: { organizationId: orgId },
      });

      const booked = await taskRepo.create({
        title: "Morning shift",
        organizationId: orgId,
        createdById: userId,
        scheduledStart: new Date("2026-06-01T08:00:00Z"),
        scheduledEnd: new Date("2026-06-01T12:00:00Z"),
      });
      await prisma.taskAssignment.create({
        data: {
          taskId: booked.id,
          membershipId: membership!.id,
          status: "accepted",
          assignedById: userId,
        },
      });

      // The shift the engine is staffing, which overlaps the one above.
      const staffing = await taskRepo.create({
        title: "Lunch service",
        organizationId: orgId,
        createdById: userId,
        scheduledStart: new Date("2026-06-01T10:00:00Z"),
        scheduledEnd: new Date("2026-06-01T14:00:00Z"),
      });

      return { membershipId: membership!.id, booked, staffing };
    }

    const clashes = (membershipId: string, staffingId: string) =>
      taskRepo.findConflictingTaskTitles(
        membershipId,
        new Date("2026-06-01T10:00:00Z"),
        new Date("2026-06-01T14:00:00Z"),
        staffingId
      );

    it("names the shift a member is already on", async () => {
      const { membershipId, staffing } = await bookedMember();

      expect(await clashes(membershipId, staffing.id)).toEqual([
        { title: "Morning shift" },
      ]);
    });

    /*
     * The fix, from the side a manager sees it. Cancelling notifies everyone
     * rostered that they are no longer scheduled and deliberately leaves their
     * assignment rows accepted — so a query reading the assignment alone went
     * on reporting the clash, and the panel greyed out a member who had just
     * been told they were free.
     */
    it("stops naming it once the shift is cancelled", async () => {
      const { membershipId, booked, staffing } = await bookedMember();

      await prisma.task.update({
        where: { id: booked.id },
        data: { status: "cancelled" },
      });

      expect(await clashes(membershipId, staffing.id)).toEqual([]);
    });

    /*
     * The two queries must answer alike, which is the property that broke last
     * time and the one a future condition added to only one of them would break
     * again. Asserted in both directions, so a query that always says "no
     * clash" cannot pass it.
     */
    it("agrees with findConflictingTasks, before and after cancelling", async () => {
      const { membershipId, booked, staffing } = await bookedMember();

      const both = async () => ({
        titles: (await clashes(membershipId, staffing.id)).length,
        tasks: (
          await taskRepo.findConflictingTasks(
            membershipId,
            new Date("2026-06-01T10:00:00Z"),
            new Date("2026-06-01T14:00:00Z"),
            staffing.id
          )
        ).length,
      });

      expect(await both()).toEqual({ titles: 1, tasks: 1 });

      await prisma.task.update({
        where: { id: booked.id },
        data: { status: "cancelled" },
      });

      expect(await both()).toEqual({ titles: 0, tasks: 0 });
    });
  });
});
