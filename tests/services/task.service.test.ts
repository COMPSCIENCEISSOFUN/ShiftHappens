/**
 * Tests for Task Service (Control Layer)
 * Verifies task CRUD business logic including
 * scheduling validation and assignment management.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskService } from "@/services/task.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { UserRepository } from "@/repositories/user.repository";
import { NOTIFICATION_TYPES } from "@/services/notification.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { declareOpenWeek } from "../helpers/fixtures";
import { eventuallyAtLeast, pauseForAbsence } from "../helpers/settle";

const taskService = new TaskService();
const orgRepo = new OrganizationRepository();
const deptRepo = new DepartmentRepository();
const userRepo = new UserRepository();

let orgId: string;
let deptId: string;
let userId: string;
let membershipId: string;
let staffUserId: string;
let staffMembershipId: string;

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

  // Ensure require_acceptance mode for assignment tests
  await prisma.companySettings.create({
    data: {
      organizationId: orgId,
      taskAcceptanceMode: "require_acceptance",
    },
  });

  const dept = await deptRepo.create({
    name: "Kitchen",
    organizationId: orgId,
  });
  deptId = dept.id;

  const membership = await prisma.membership.findFirst({
    where: { organizationId: orgId },
  });
  membershipId = membership!.id;

  // Create a staff member for assignment tests
  const staffUser = await userRepo.create({
    name: "Staff User",
    email: "staff@example.com",
    hashedPassword: "hash",
  });
  staffUserId = staffUser.id;

  const staffMembership = await prisma.membership.create({
    data: {
      userId: staffUser.id,
      organizationId: orgId,
      role: "staff",
      status: "active",
    },
  });
  staffMembershipId = staffMembership.id;
  await declareOpenWeek(staffMembershipId);
});

describe("TaskService", () => {
  describe("create", () => {
    it("creates a task", async () => {
      const task = await taskService.create(
        {
          title: "Clean kitchen",
          description: "Deep clean",
          departmentId: deptId,
          priority: "high",
          requiredHeadcount: 2,
        },
        orgId,
        userId
      );

      expect(task.title).toBe("Clean kitchen");
      expect(task.priority).toBe("high");
      expect(task.status).toBe("open");
    });

    it("throws if scheduledEnd is before scheduledStart", async () => {
      await expect(
        taskService.create(
          {
            title: "Bad schedule",
            scheduledStart: "2026-06-01T12:00:00.000Z",
            scheduledEnd: "2026-06-01T08:00:00.000Z",
          },
          orgId,
          userId
        )
      ).rejects.toThrow("End time must be after start time");
    });

    it("persists requiredCertifications", async () => {
      const task = await taskService.create(
        { title: "Cert task", requiredCertifications: ["Food Safety", "RSA Certification"] },
        orgId,
        userId
      );

      const found = await taskService.getById(task.id, orgId);
      expect(found!.requiredCertifications).toEqual(["Food Safety", "RSA Certification"]);
    });

    it("defaults requiredCertifications to an empty array", async () => {
      const task = await taskService.create({ title: "No cert task" }, orgId, userId);

      const found = await taskService.getById(task.id, orgId);
      expect(found!.requiredCertifications).toEqual([]);
    });
  });

  describe("getByOrganization", () => {
    it("returns all tasks for an org", async () => {
      await taskService.create({ title: "Task 1" }, orgId, userId);
      await taskService.create({ title: "Task 2" }, orgId, userId);

      const tasks = await taskService.getByOrganization(orgId);
      expect(tasks).toHaveLength(2);
    });

    it("filters by status", async () => {
      await taskService.create({ title: "Open task" }, orgId, userId);
      const task2 = await taskService.create({ title: "Done task" }, orgId, userId);
      await taskService.update(task2.id, orgId, { status: "completed" });

      const tasks = await taskService.getByOrganization(orgId, { status: "open" });
      expect(tasks).toHaveLength(1);
    });
  });

  describe("getById", () => {
    it("returns a task", async () => {
      const created = await taskService.create({ title: "Test" }, orgId, userId);
      const found = await taskService.getById(created.id, orgId);
      expect(found).not.toBeNull();
      expect(found!.title).toBe("Test");
    });
  });

  describe("update", () => {
    it("updates task fields", async () => {
      const task = await taskService.create({ title: "Old" }, orgId, userId);
      const updated = await taskService.update(task.id, orgId, {
        title: "New",
        priority: "urgent",
      });

      expect(updated.title).toBe("New");
      expect(updated.priority).toBe("urgent");
    });

    it("clears scheduled times when set to empty", async () => {
      const task = await taskService.create(
        {
          title: "Scheduled task",
          scheduledStart: "2026-06-01T08:00:00.000Z",
          scheduledEnd: "2026-06-01T12:00:00.000Z",
        },
        orgId,
        userId
      );

      expect(task.scheduledStart).not.toBeNull();

      const updated = await taskService.update(task.id, orgId, {
        scheduledStart: "",
        scheduledEnd: "",
      });

      expect(updated.scheduledStart).toBeNull();
      expect(updated.scheduledEnd).toBeNull();
    });

    it("throws if only start time is provided without end time", async () => {
      const task = await taskService.create(
        { title: "Test" },
        orgId,
        userId
      );

      await expect(
        taskService.update(task.id, orgId, {
          scheduledStart: "2026-06-01T08:00:00.000Z",
        })
      ).rejects.toThrow("Must provide both start and end time, or clear both");
    });

    it("throws if only end time is provided without start time", async () => {
      const task = await taskService.create(
        { title: "Test" },
        orgId,
        userId
      );

      await expect(
        taskService.update(task.id, orgId, {
          scheduledEnd: "2026-06-01T12:00:00.000Z",
        })
      ).rejects.toThrow("Must provide both start and end time, or clear both");
    });

    it("throws if end time equals start time", async () => {
      const task = await taskService.create(
        { title: "Test" },
        orgId,
        userId
      );

      await expect(
        taskService.update(task.id, orgId, {
          scheduledStart: "2026-06-01T08:00:00.000Z",
          scheduledEnd: "2026-06-01T08:00:00.000Z",
        })
      ).rejects.toThrow("End time must be after start time");
    });

    it("throws if clearing start time but task has end time", async () => {
      const task = await taskService.create(
        {
          title: "Scheduled",
          scheduledStart: "2026-06-01T08:00:00.000Z",
          scheduledEnd: "2026-06-01T12:00:00.000Z",
        },
        orgId,
        userId
      );

      await expect(
        taskService.update(task.id, orgId, {
          scheduledStart: "",
        })
      ).rejects.toThrow("Must provide both start and end time, or clear both");
    });

    it("throws if clearing end time but task has start time", async () => {
      const task = await taskService.create(
        {
          title: "Scheduled",
          scheduledStart: "2026-06-01T08:00:00.000Z",
          scheduledEnd: "2026-06-01T12:00:00.000Z",
        },
        orgId,
        userId
      );

      await expect(
        taskService.update(task.id, orgId, {
          scheduledEnd: "",
        })
      ).rejects.toThrow("Must provide both start and end time, or clear both");
    });

    it("throws if task not found", async () => {
      await expect(
        taskService.update("nonexistent", orgId, { title: "X" })
      ).rejects.toThrow("Task not found");
    });

    it("updates requiredCertifications", async () => {
      const task = await taskService.create(
        { title: "Cert task", requiredCertifications: ["Food Safety"] },
        orgId,
        userId
      );

      await taskService.update(task.id, orgId, {
        requiredCertifications: ["RSA Certification"],
      });

      const found = await taskService.getById(task.id, orgId);
      expect(found!.requiredCertifications).toEqual(["RSA Certification"]);
    });
  });

  describe("delete", () => {
    it("deletes a task", async () => {
      const task = await taskService.create({ title: "Delete me" }, orgId, userId);
      await taskService.delete(task.id, orgId);

      const found = await taskService.getById(task.id, orgId);
      expect(found).toBeNull();
    });

    it("throws if task not found", async () => {
      await expect(
        taskService.delete("nonexistent", orgId)
      ).rejects.toThrow("Task not found");
    });
  });

  describe("assignStaff", () => {
    it("assigns a member to a task", async () => {
      const task = await taskService.create({ title: "Test" }, orgId, userId);

      const assignments = await taskService.assignStaff(
        task.id,
        orgId,
        [staffMembershipId],
        userId
      );

      expect(assignments).toHaveLength(1);
      expect(assignments[0].membershipId).toBe(staffMembershipId);
      expect(assignments[0].status).toBe("pending");
    });

    it("auto-accepts assignments when taskAcceptanceMode is auto_accept", async () => {
      // Update settings to auto_accept
      await prisma.companySettings.updateMany({
        where: { organizationId: orgId },
        data: { taskAcceptanceMode: "auto_accept" },
      });

      const task = await taskService.create({ title: "Auto test" }, orgId, userId);

      const assignments = await taskService.assignStaff(
        task.id,
        orgId,
        [staffMembershipId],
        userId
      );

      expect(assignments).toHaveLength(1);
      expect(assignments[0].status).toBe("accepted");
    });

    it("throws if exceeding required headcount", async () => {
      const task = await taskService.create(
        { title: "Solo task", requiredHeadcount: 1 },
        orgId,
        userId
      );

      await taskService.assignStaff(task.id, orgId, [staffMembershipId], userId);

      const user2 = await userRepo.create({
        name: "Staff 2",
        email: "staff2@example.com",
        hashedPassword: "hash",
      });
      const membership2 = await prisma.membership.create({
        data: { userId: user2.id, organizationId: orgId, role: "staff", status: "active" },
      });

      await expect(
        taskService.assignStaff(task.id, orgId, [membership2.id], userId)
      ).rejects.toThrow("exceeds required headcount");
    });

    it("detects scheduling conflicts", async () => {
      const task1 = await taskService.create(
        {
          title: "Morning shift",
          scheduledStart: "2026-06-01T08:00:00.000Z",
          scheduledEnd: "2026-06-01T12:00:00.000Z",
        },
        orgId,
        userId
      );
      await taskService.assignStaff(task1.id, orgId, [staffMembershipId], userId);
      await prisma.taskAssignment.updateMany({
        where: { taskId: task1.id },
        data: { status: "accepted" },
      });

      const task2 = await taskService.create(
        {
          title: "Overlapping shift",
          scheduledStart: "2026-06-01T10:00:00.000Z",
          scheduledEnd: "2026-06-01T14:00:00.000Z",
        },
        orgId,
        userId
      );

      await expect(
        taskService.assignStaff(task2.id, orgId, [staffMembershipId], userId)
      ).rejects.toThrow("scheduling conflict");
    });

    it("allows assignment through a scheduling conflict when overridden", async () => {
      const task1 = await taskService.create(
        {
          title: "Morning shift",
          scheduledStart: "2026-06-01T08:00:00.000Z",
          scheduledEnd: "2026-06-01T12:00:00.000Z",
        },
        orgId,
        userId
      );
      await taskService.assignStaff(task1.id, orgId, [staffMembershipId], userId);
      await prisma.taskAssignment.updateMany({
        where: { taskId: task1.id },
        data: { status: "accepted" },
      });

      const task2 = await taskService.create(
        {
          title: "Overlapping shift",
          scheduledStart: "2026-06-01T10:00:00.000Z",
          scheduledEnd: "2026-06-01T14:00:00.000Z",
        },
        orgId,
        userId
      );

      // Manager documents an override for the conflict, then assignment succeeds.
      await prisma.eligibilityOverride.create({
        data: {
          taskId: task2.id,
          membershipId: staffMembershipId,
          overriddenById: userId,
          reason: "Short-staffed",
          ruleOverridden: "all",
        },
      });

      const assignments = await taskService.assignStaff(
        task2.id,
        orgId,
        [staffMembershipId],
        userId
      );
      expect(assignments).toHaveLength(1);
    });
  });

  describe("assignStaffValidation", () => {
    it("throws if assigning a company admin", async () => {
      const task = await taskService.create({ title: "Test" }, orgId, userId);

      await expect(
        taskService.assignStaff(task.id, orgId, [membershipId], userId)
      ).rejects.toThrow("Company Admins cannot be assigned to tasks");
    });
  });

  describe("cancelAssignment", () => {
    it("cancels a pending assignment", async () => {
      const task = await taskService.create({ title: "Test" }, orgId, userId);
      const assignments = await taskService.assignStaff(task.id, orgId, [staffMembershipId], userId);

      await taskService.cancelAssignment(assignments[0].id, orgId);

      const staffTasks = await taskService.getStaffTasks(staffMembershipId);
      expect(staffTasks).toHaveLength(0);
    });

    it("throws if assignment is completed", async () => {
      const task = await taskService.create({ title: "Test" }, orgId, userId);
      const assignments = await taskService.assignStaff(task.id, orgId, [staffMembershipId], userId);

      await prisma.taskAssignment.update({
        where: { id: assignments[0].id },
        data: { status: "completed" },
      });

      await expect(
        taskService.cancelAssignment(assignments[0].id, orgId)
      ).rejects.toThrow("Cannot cancel a completed assignment");
    });
  });

  describe("getTasksByDepartment", () => {
    it("returns tasks for a department", async () => {
      await taskService.create({ title: "Kitchen task", departmentId: deptId }, orgId, userId);
      await taskService.create({ title: "No dept task" }, orgId, userId);

      const tasks = await taskService.getTasksByDepartment(deptId);
      expect(tasks).toHaveLength(1);
    });
  });

  describe("getStaffTasks", () => {
    it("returns tasks assigned to a member", async () => {
      const task = await taskService.create({ title: "My task" }, orgId, userId);
      await taskService.assignStaff(task.id, orgId, [staffMembershipId], userId);

      const assignments = await taskService.getStaffTasks(staffMembershipId);
      expect(assignments).toHaveLength(1);
      expect(assignments[0].task.title).toBe("My task");
    });
  });

  describe("assignment notifications", () => {
    it("notifies staff when they are assigned", async () => {
      const task = await taskService.create({ title: "Night shift" }, orgId, userId);
      await taskService.assignStaff(task.id, orgId, [staffMembershipId], userId);

      const notes = await waitForNotifications(
        staffUserId,
        NOTIFICATION_TYPES.TASK_ASSIGNED
      );
      expect(notes).toHaveLength(1);
    });

    it("notifies staff when they are unassigned", async () => {
      const task = await taskService.create({ title: "Night shift" }, orgId, userId);
      const [assignment] = await taskService.assignStaff(
        task.id,
        orgId,
        [staffMembershipId],
        userId
      );

      await taskService.cancelAssignment(assignment.id, orgId, userId);

      const notes = await waitForNotifications(
        staffUserId,
        NOTIFICATION_TYPES.TASK_UNASSIGNED
      );
      expect(notes).toHaveLength(1);
    });

    it("notifies assigned staff when the task is deleted", async () => {
      const task = await taskService.create({ title: "Night shift" }, orgId, userId);
      await taskService.assignStaff(task.id, orgId, [staffMembershipId], userId);

      await taskService.delete(task.id, orgId);

      const notes = await waitForNotifications(
        staffUserId,
        NOTIFICATION_TYPES.TASK_CANCELLED
      );
      expect(notes).toHaveLength(1);
    });

    it("notifies assigned staff when the task is rescheduled", async () => {
      const task = await taskService.create(
        {
          title: "Night shift",
          scheduledStart: "2026-06-01T08:00:00.000Z",
          scheduledEnd: "2026-06-01T12:00:00.000Z",
        },
        orgId,
        userId
      );
      await taskService.assignStaff(task.id, orgId, [staffMembershipId], userId);

      await taskService.update(task.id, orgId, {
        scheduledStart: "2026-06-02T08:00:00.000Z",
        scheduledEnd: "2026-06-02T12:00:00.000Z",
      });

      const notes = await waitForNotifications(
        staffUserId,
        NOTIFICATION_TYPES.TASK_RESCHEDULED
      );
      expect(notes).toHaveLength(1);
    });

    it("suppresses assignment notifications when the org disables them", async () => {
      await prisma.companySettings.update({
        where: { organizationId: orgId },
        data: {
          notificationPreferences: JSON.stringify({ taskAssignment: false }),
        },
      });

      const task = await taskService.create({ title: "Night shift" }, orgId, userId);
      await taskService.assignStaff(task.id, orgId, [staffMembershipId], userId);

      // Absence cannot be polled for: the pause has to be long enough that
      // the notification WOULD have landed. See helpers/settle.
      await pauseForAbsence(300);
      const notes = await prisma.notification.findMany({
        where: { userId: staffUserId, type: NOTIFICATION_TYPES.TASK_ASSIGNED },
      });
      expect(notes).toHaveLength(0);
    });
  });
});

/**
 * Kept as a named wrapper because the call sites read better for it, but the
 * waiting now lives in helpers/settle.
 *
 * This function had the right idea and the right docblock, and stayed
 * file-local while nine other test files went on sleeping a fixed number of
 * milliseconds — one of which failed on a laptop for it. Reasoning that is
 * correct in one file and unavailable everywhere else is the same defect this
 * codebase keeps finding in its own source.
 */
async function waitForNotifications(userId: string, type: string) {
  return eventuallyAtLeast(() =>
    prisma.notification.findMany({ where: { userId, type } })
  );
}
/**
 * update() computes newStart/newEnd by falling back to the task's stored
 * schedule whenever the caller omits those keys — that is what a partial update
 * means — and then validates against them. It then wrote
 * `input.scheduledStart ? … : null` to the database, discarding that work and
 * nulling BOTH columns on any PATCH that did not resend the schedule.
 *
 * The UI does exactly that: the status dropdown PATCHes { status } alone. So
 * clicking "start" on a scheduled shift silently erased its time, removing it
 * from the calendar, from conflict checks, and from auto-scheduling — with no
 * error and nothing in the logs.
 */
describe("TaskService.update — partial updates preserve the schedule", () => {
  const START = "2026-08-03T01:00:00.000Z";
  const END = "2026-08-03T09:00:00.000Z";

  async function scheduledTask() {
    return taskService.create(
      { title: "Morning shift", scheduledStart: START, scheduledEnd: END },
      orgId,
      userId
    );
  }

  it("keeps the schedule when only the status changes", async () => {
    const task = await scheduledTask();

    const updated = await taskService.update(task.id, orgId, { status: "in_progress" });

    expect(updated.scheduledStart?.toISOString()).toBe(START);
    expect(updated.scheduledEnd?.toISOString()).toBe(END);
    expect(updated.status).toBe("in_progress");
  });

  it("keeps the schedule when only the title changes", async () => {
    const task = await scheduledTask();

    const updated = await taskService.update(task.id, orgId, { title: "Renamed" });

    expect(updated.scheduledStart?.toISOString()).toBe(START);
    expect(updated.scheduledEnd?.toISOString()).toBe(END);
  });

  it("persists the preservation — a re-read still shows the schedule", async () => {
    // The round trip matters: the returned object could be right while the row
    // is wrong. This is the assertion the original bug would have needed.
    const task = await scheduledTask();
    await taskService.update(task.id, orgId, { status: "completed" });

    const reread = await prisma.task.findUnique({ where: { id: task.id } });
    expect(reread!.scheduledStart?.toISOString()).toBe(START);
    expect(reread!.scheduledEnd?.toISOString()).toBe(END);
  });

  it("survives a sequence of partial updates", async () => {
    const task = await scheduledTask();

    await taskService.update(task.id, orgId, { status: "in_progress" });
    await taskService.update(task.id, orgId, { priority: "urgent" });
    const updated = await taskService.update(task.id, orgId, { title: "Third" });

    expect(updated.scheduledStart?.toISOString()).toBe(START);
    expect(updated.scheduledEnd?.toISOString()).toBe(END);
  });

  it("still clears BOTH when the caller explicitly sends empty strings", async () => {
    // Clearing must remain possible — the fix must not turn "clear" into a no-op.
    const task = await scheduledTask();

    const updated = await taskService.update(task.id, orgId, {
      scheduledStart: "",
      scheduledEnd: "",
    });

    expect(updated.scheduledStart).toBeNull();
    expect(updated.scheduledEnd).toBeNull();
  });

  it("still rejects clearing only one side", async () => {
    const task = await scheduledTask();

    await expect(
      taskService.update(task.id, orgId, { scheduledStart: "" })
    ).rejects.toThrow("Must provide both start and end time, or clear both");
  });

  it("still rejects an end before the stored start on a one-sided update", async () => {
    const task = await scheduledTask();

    await expect(
      taskService.update(task.id, orgId, { scheduledEnd: "2026-08-02T09:00:00.000Z" })
    ).rejects.toThrow("End time must be after start time");
  });

  it("leaves an unscheduled task unscheduled", async () => {
    const task = await taskService.create({ title: "No schedule" }, orgId, userId);

    const updated = await taskService.update(task.id, orgId, { status: "in_progress" });

    expect(updated.scheduledStart).toBeNull();
    expect(updated.scheduledEnd).toBeNull();
  });
});

/**
 * departmentId was passed through raw, so `undefined` (what the UI sends for
 * "No department") was dropped by Prisma and the department never changed —
 * the save reported success and did nothing.
 */
describe("TaskService.update — clearing the department", () => {
  it("clears the department when null is sent explicitly", async () => {
    const task = await taskService.create(
      { title: "Dept task", departmentId: deptId },
      orgId,
      userId
    );

    const updated = await taskService.update(task.id, orgId, { departmentId: null });

    expect(updated.departmentId).toBeNull();
  });

  it("leaves the department alone when the key is absent", async () => {
    const task = await taskService.create(
      { title: "Dept task", departmentId: deptId },
      orgId,
      userId
    );

    const updated = await taskService.update(task.id, orgId, { title: "Renamed" });

    expect(updated.departmentId).toBe(deptId);
  });

  it("still reassigns the department when a new id is sent", async () => {
    const other = await deptRepo.create({ name: "Bar", color: "#3B82F6", organizationId: orgId });
    const task = await taskService.create(
      { title: "Dept task", departmentId: deptId },
      orgId,
      userId
    );

    const updated = await taskService.update(task.id, orgId, { departmentId: other.id });

    expect(updated.departmentId).toBe(other.id);
  });
});

/**
 * assignStaff resolves each membership through findById, which applies no
 * status filter. The UI's candidate lists are filtered, but this path reads ids
 * straight from the request body, so a deactivated employee could still be
 * rostered — the same privilege leak the active-only findByUserAndOrg default
 * was introduced to close, re-entering through a different door.
 */
describe("TaskService.assignStaff — deactivated members", () => {
  it("refuses to assign a deactivated member", async () => {
    await prisma.membership.update({
      where: { id: staffMembershipId },
      data: { status: "inactive" },
    });
    const task = await taskService.create({ title: "Shift" }, orgId, userId);

    await expect(
      taskService.assignStaff(task.id, orgId, [staffMembershipId], userId)
    ).rejects.toThrow("Staff member is deactivated");

    expect(await prisma.taskAssignment.count({ where: { taskId: task.id } })).toBe(0);
  });

  it("refuses the whole batch if any member is deactivated", async () => {
    const otherUser = await userRepo.create({
      name: "Other Staff",
      email: "other-staff@example.com",
      hashedPassword: "hash",
    });
    const otherMembership = await prisma.membership.create({
      data: { userId: otherUser.id, organizationId: orgId, role: "staff", status: "active" },
    });
    await prisma.membership.update({
      where: { id: staffMembershipId },
      data: { status: "inactive" },
    });
    const task = await taskService.create({ title: "Shift" }, orgId, userId);
    await prisma.task.update({ where: { id: task.id }, data: { requiredHeadcount: 2 } });

    await expect(
      taskService.assignStaff(task.id, orgId, [otherMembership.id, staffMembershipId], userId)
    ).rejects.toThrow("Staff member is deactivated");
  });

  it("still assigns an active member", async () => {
    const task = await taskService.create({ title: "Shift" }, orgId, userId);

    const result = await taskService.assignStaff(task.id, orgId, [staffMembershipId], userId);

    expect(result).toHaveLength(1);
  });
});
