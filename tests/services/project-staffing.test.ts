/**
 * Project staffing mode regression tests.
 *
 * The contract under test:
 *
 *  - `task_based` projects place no restriction on who may be considered.
 *  - `project_team` projects narrow every allocation path to eligible
 *    members of the persistent Project Team: AI suggestions, auto
 *    allocation, manual assignment and the weekly auto-schedule.
 *  - Team membership NEVER bypasses an eligibility check, and never
 *    reserves a calendar — a member may sit on a 6-month project team
 *    while being scheduled only for the work items they are assigned.
 *  - An empty Project Team yields no candidates rather than silently
 *    falling back to the whole organization.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { prisma } from "@/lib/prisma";
import { AllocationService } from "@/services/allocation.service";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { EligibilityService } from "@/services/eligibility.service";
import { ProjectService } from "@/services/project.service";
import { TaskService } from "@/services/task.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";

import { cleanDatabase } from "../helpers/cleanup";

const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

const projects = new ProjectService();
const allocation = new AllocationService();
const eligibility = new EligibilityService();
const tasks = new TaskService();

let orgId: string;
let adminUserId: string;
let departmentId: string;
/** On the Project Team. */
let insiderMembershipId: string;
/** Same department, equally eligible, but NOT on the Project Team. */
let outsiderMembershipId: string;

async function addStaff(name: string, email: string, inDepartment = true) {
  const user = await userRepo.create({ name, email, hashedPassword: "hash" });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: orgId,
      role: "staff",
      status: "active",
      employmentType: "casual",
    },
  });
  if (inDepartment) {
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId },
    });
  }
  await prisma.availability.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      membershipId: membership.id,
      dayOfWeek,
      startTime: "00:00",
      endTime: "23:59",
      isAvailable: true,
    })),
  });
  return membership.id;
}

/** A project work item inside the project timeframe. */
async function createWorkItem(
  projectId: string,
  overrides: { title?: string; start?: Date; end?: Date } = {}
) {
  return prisma.task.create({
    data: {
      title: overrides.title ?? "Work item",
      organizationId: orgId,
      departmentId,
      projectId,
      createdById: adminUserId,
      status: "open",
      priority: "medium",
      requiredHeadcount: 1,
      scheduledStart: overrides.start ?? new Date("2026-09-07T09:00:00.000Z"),
      scheduledEnd: overrides.end ?? new Date("2026-09-07T17:00:00.000Z"),
    },
  });
}

async function createProject(staffingMode: "task_based" | "project_team") {
  return projects.create(
    {
      title: "Atlas API Release",
      staffingMode,
      departmentId,
      priority: "high",
      // A deliberately long-running project: six months.
      plannedStart: "2026-09-01T00:00:00.000Z",
      plannedEnd: "2027-03-01T00:00:00.000Z",
    },
    orgId,
    adminUserId
  );
}

beforeEach(async () => {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create({ name: "Acme", slug: "acme" }, admin.id);
  orgId = org.id;

  await prisma.companySettings.create({
    data: { organizationId: orgId, allocationMode: "manual", workingDayHours: 8 },
  });

  const department = await prisma.department.create({
    data: { name: "Engineering", organizationId: orgId },
  });
  departmentId = department.id;

  insiderMembershipId = await addStaff("Insider", "insider@example.com");
  outsiderMembershipId = await addStaff("Outsider", "outsider@example.com");
});

describe("Project Team staffing", () => {
  describe("smart suggestions and auto allocation", () => {
    it("ranks only Project Team members for project_team work items", async () => {
      const project = await createProject("project_team");
      await projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId);
      const task = await createWorkItem(project.id);

      const suggestions = await allocation.getSuggestions(task.id, orgId);

      expect(suggestions.map((s) => s.membershipId)).toEqual([insiderMembershipId]);
    });

    it("ranks every eligible staff member for task_based work items", async () => {
      const project = await createProject("task_based");
      const task = await createWorkItem(project.id);

      const suggestions = await allocation.getSuggestions(task.id, orgId);

      expect(suggestions.map((s) => s.membershipId).sort()).toEqual(
        [insiderMembershipId, outsiderMembershipId].sort()
      );
    });

    it("returns no candidates when the Project Team is empty", async () => {
      const project = await createProject("project_team");
      const task = await createWorkItem(project.id);

      await expect(allocation.getSuggestions(task.id, orgId)).resolves.toEqual([]);
    });

    it("auto allocation never reaches outside the Project Team", async () => {
      await prisma.companySettings.update({
        where: { organizationId: orgId },
        data: { allocationMode: "auto" },
      });

      const project = await createProject("project_team");
      await projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId);
      const task = await createWorkItem(project.id);

      const assignments = await allocation.autoAllocate(task.id, orgId, adminUserId);

      expect(assignments).toHaveLength(1);
      expect(assignments[0].membershipId).toBe(insiderMembershipId);
    });

    it("auto allocation assigns nobody when the Project Team is empty", async () => {
      await prisma.companySettings.update({
        where: { organizationId: orgId },
        data: { allocationMode: "auto" },
      });

      const project = await createProject("project_team");
      const task = await createWorkItem(project.id);

      // Same "no candidates" outcome as an org with no eligible staff — the
      // point is that it never falls back to non-team staff.
      await expect(
        allocation.autoAllocate(task.id, orgId, adminUserId)
      ).rejects.toThrow(/No eligible staff found/i);
      await expect(
        prisma.taskAssignment.count({ where: { taskId: task.id } })
      ).resolves.toBe(0);
    });
  });

  describe("final server-side assignment validation", () => {
    it("rejects a manual assignment of a non-team member", async () => {
      const project = await createProject("project_team");
      await projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId);
      const task = await createWorkItem(project.id);

      await expect(
        tasks.assignStaff(task.id, orgId, [outsiderMembershipId], adminUserId)
      ).rejects.toThrow(/not on the Project Team/i);

      await expect(
        prisma.taskAssignment.count({ where: { taskId: task.id } })
      ).resolves.toBe(0);
    });

    it("allows a manual assignment of a team member", async () => {
      const project = await createProject("project_team");
      await projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId);
      const task = await createWorkItem(project.id);

      await expect(
        tasks.assignStaff(task.id, orgId, [insiderMembershipId], adminUserId)
      ).resolves.toHaveLength(1);
    });

    it("rejects every member when the Project Team is empty", async () => {
      const project = await createProject("project_team");
      const task = await createWorkItem(project.id);

      await expect(
        eligibility.assertEligibleForAssignment(task.id, orgId, [insiderMembershipId])
      ).rejects.toThrow(/not on the Project Team/i);
    });

    it("does not restrict assignment for task_based projects", async () => {
      const project = await createProject("task_based");
      const task = await createWorkItem(project.id);

      await expect(
        eligibility.assertEligibleForAssignment(task.id, orgId, [outsiderMembershipId])
      ).resolves.toBeUndefined();
    });

    it("still enforces normal eligibility for a team member", async () => {
      // Being on the Project Team must not waive department scope.
      const project = await createProject("project_team");
      const strangerId = await addStaff(
        "No Department",
        "nodept@example.com",
        false
      );
      // Put them on the team directly: setTeam would reject them, which is
      // itself correct, but this asserts the ASSIGNMENT gate independently.
      await prisma.project.update({
        where: { id: project.id },
        data: { projectMembers: { create: { membershipId: strangerId } } },
      });
      const task = await createWorkItem(project.id);

      await expect(
        eligibility.assertEligibleForAssignment(task.id, orgId, [strangerId])
      ).rejects.toThrow(/failed final eligibility validation/i);
    });

    it("does not reserve a team member's calendar for the project duration", async () => {
      // The whole point of the mode: a 6-month project team membership must
      // not make its members look busy outside the work they are assigned.
      const project = await createProject("project_team");
      await projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId);

      const first = await createWorkItem(project.id, {
        title: "Sprint 1",
        start: new Date("2026-09-07T09:00:00.000Z"),
        end: new Date("2026-09-07T17:00:00.000Z"),
      });
      await tasks.assignStaff(first.id, orgId, [insiderMembershipId], adminUserId);

      // A non-overlapping work item months later is still assignable.
      const later = await createWorkItem(project.id, {
        title: "Sprint 9",
        start: new Date("2027-01-11T09:00:00.000Z"),
        end: new Date("2027-01-11T17:00:00.000Z"),
      });

      await expect(
        eligibility.assertEligibleForAssignment(later.id, orgId, [insiderMembershipId])
      ).resolves.toBeUndefined();
    });
  });

  describe("weekly auto-schedule", () => {
    it("drafts only Project Team members for project work items", async () => {
      const project = await createProject("project_team");
      await projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId);
      await createWorkItem(project.id, {
        start: new Date("2026-09-07T09:00:00.000Z"),
        end: new Date("2026-09-07T17:00:00.000Z"),
      });

      const draft = await new AutoScheduleService().generateSchedule(
        orgId,
        new Date("2026-09-07T00:00:00.000Z")
      );

      expect(draft.assignments.map((a) => a.membershipId)).toEqual([
        insiderMembershipId,
      ]);
    });

    it("drafts nobody when the Project Team is empty", async () => {
      const project = await createProject("project_team");
      await createWorkItem(project.id, {
        start: new Date("2026-09-07T09:00:00.000Z"),
        end: new Date("2026-09-07T17:00:00.000Z"),
      });

      const draft = await new AutoScheduleService().generateSchedule(
        orgId,
        new Date("2026-09-07T00:00:00.000Z")
      );

      expect(draft.assignments).toHaveLength(0);
      expect(draft.unfilledTasks[0]?.reason).toMatch(/no eligible staff remaining/i);
    });
  });

  describe("Project Team membership rules", () => {
    it("rejects staff outside the project department", async () => {
      const project = await createProject("project_team");
      const strangerId = await addStaff("Stranger", "stranger@example.com", false);

      await expect(
        projects.setTeam(project.id, orgId, [strangerId], adminUserId)
      ).rejects.toThrow(/invalid, inactive, outside the organization, or outside the project department/i);
    });

    it("rejects inactive staff", async () => {
      const project = await createProject("project_team");
      await prisma.membership.update({
        where: { id: insiderMembershipId },
        data: { status: "inactive" },
      });

      await expect(
        projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId)
      ).rejects.toThrow(/invalid, inactive/i);
    });

    it("refuses to build a team on a task_based project", async () => {
      const project = await createProject("task_based");

      await expect(
        projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId)
      ).rejects.toThrow(/only available when the project uses Project Team staffing/i);
    });
  });

  describe("switching staffing mode", () => {
    it("clears the persistent team but keeps existing assignments", async () => {
      const project = await createProject("project_team");
      await projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId);
      const task = await createWorkItem(project.id);
      await tasks.assignStaff(task.id, orgId, [insiderMembershipId], adminUserId);

      await projects.update(
        project.id,
        orgId,
        { staffingMode: "task_based" },
        adminUserId
      );

      await expect(
        prisma.projectMember.count({ where: { projectId: project.id } })
      ).resolves.toBe(0);
      await expect(
        prisma.taskAssignment.count({ where: { taskId: task.id } })
      ).resolves.toBe(1);
    });

    it("does not resurrect old members when switching back", async () => {
      const project = await createProject("project_team");
      await projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId);

      await projects.update(
        project.id,
        orgId,
        { staffingMode: "task_based" },
        adminUserId
      );
      const restored = await projects.update(
        project.id,
        orgId,
        { staffingMode: "project_team" },
        adminUserId
      );

      expect(restored.projectMembers).toHaveLength(0);
    });

    it("keeps the team when the mode is unchanged", async () => {
      const project = await createProject("project_team");
      await projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId);

      const updated = await projects.update(
        project.id,
        orgId,
        { title: "Atlas API Release v2" },
        adminUserId
      );

      expect(updated.projectMembers).toHaveLength(1);
    });
  });

  describe("project integrity rules", () => {
    it("blocks a department change once the team has members", async () => {
      const project = await createProject("project_team");
      await projects.setTeam(project.id, orgId, [insiderMembershipId], adminUserId);
      const other = await prisma.department.create({
        data: { name: "Support", organizationId: orgId },
      });

      await expect(
        projects.update(project.id, orgId, { departmentId: other.id }, adminUserId)
      ).rejects.toThrow(/Project Team has members/i);
    });

    it("blocks completing a project while work items are open", async () => {
      const project = await createProject("task_based");
      await createWorkItem(project.id);

      await expect(
        projects.update(project.id, orgId, { status: "completed" }, adminUserId)
      ).rejects.toThrow(/still open/i);
    });

    it("keeps work items inside the project timeframe", async () => {
      const project = await createProject("task_based");

      await expect(
        tasks.create(
          {
            title: "Too early",
            projectId: project.id,
            departmentId,
            scheduledStart: "2026-08-01T09:00:00.000Z",
            scheduledEnd: "2026-08-01T17:00:00.000Z",
          },
          orgId,
          adminUserId
        )
      ).rejects.toThrow(/within the project timeframe/i);
    });

    it("defaults a new work item to the project priority", async () => {
      const project = await createProject("task_based");

      const task = await tasks.create(
        {
          title: "Inherits priority",
          projectId: project.id,
          departmentId,
          scheduledStart: "2026-09-07T09:00:00.000Z",
          scheduledEnd: "2026-09-07T17:00:00.000Z",
        },
        orgId,
        adminUserId
      );

      expect(task.priority).toBe("high");
    });

    it("lets a manager override the inherited priority", async () => {
      const project = await createProject("task_based");

      const task = await tasks.create(
        {
          title: "Explicit priority",
          projectId: project.id,
          departmentId,
          priority: "low",
          scheduledStart: "2026-09-07T09:00:00.000Z",
          scheduledEnd: "2026-09-07T17:00:00.000Z",
        },
        orgId,
        adminUserId
      );

      expect(task.priority).toBe("low");
    });

    it("refuses new work items on a completed project", async () => {
      const project = await createProject("task_based");
      await projects.update(project.id, orgId, { status: "completed" }, adminUserId);

      await expect(
        tasks.create(
          { title: "Late arrival", projectId: project.id, departmentId },
          orgId,
          adminUserId
        )
      ).rejects.toThrow(/completed or cancelled project/i);
    });
  });
});
