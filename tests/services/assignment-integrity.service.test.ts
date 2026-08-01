import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { EligibilityService } from "@/services/eligibility.service";
import { TaskService } from "@/services/task.service";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { cleanDatabase } from "../helpers/cleanup";

const taskService = new TaskService();
const eligibilityService = new EligibilityService();
const autoScheduleService = new AutoScheduleService();

let organizationId: string;
let adminUserId: string;

async function createUser(
  name: string,
  options?: { isPlatformAdmin?: boolean }
) {
  return prisma.user.create({
    data: {
      name,
      email: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
      hashedPassword: "hash",
      emailVerified: new Date(),
      isPlatformAdmin: options?.isPlatformAdmin ?? false,
    },
  });
}

async function createMembership(
  name: string,
  options?: {
    role?: string;
    status?: string;
    employmentType?: string;
    organizationId?: string;
    isPlatformAdmin?: boolean;
  }
) {
  const user = await createUser(name, {
    isPlatformAdmin: options?.isPlatformAdmin,
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: options?.organizationId ?? organizationId,
      role: options?.role ?? "staff",
      status: options?.status ?? "active",
      employmentType: options?.employmentType ?? "full_time",
    },
  });
  return { user, membership };
}

async function createTask(options?: {
  requiredHeadcount?: number;
  departmentId?: string;
  requiredCertifications?: string[];
  scheduled?: boolean;
}) {
  return prisma.task.create({
    data: {
      title: `Integrity task ${Date.now()} ${Math.random()}`,
      organizationId,
      createdById: adminUserId,
      requiredHeadcount: options?.requiredHeadcount ?? 1,
      departmentId: options?.departmentId,
      requiredCertifications: options?.requiredCertifications ?? [],
      ...(options?.scheduled
        ? {
            scheduledStart: new Date("2026-06-15T01:00:00.000Z"),
            scheduledEnd: new Date("2026-06-15T04:00:00.000Z"),
          }
        : {}),
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();

  const admin = await createUser("Admin");
  adminUserId = admin.id;
  const organization = await prisma.organization.create({
    data: { name: "Integrity Org", slug: "integrity-org" },
  });
  organizationId = organization.id;
  await prisma.membership.create({
    data: {
      userId: admin.id,
      organizationId,
      role: "company_admin",
      status: "active",
    },
  });
  await prisma.companySettings.create({
    data: { organizationId, allocationMode: "manual" },
  });
});

describe("Phase 4 final assignment integrity", () => {
  it("excludes managers from candidate listing and final assignment", async () => {
    const manager = await createMembership("Manager", { role: "manager" });
    const task = await createTask();

    const eligibility = await eligibilityService.checkEligibilityForTask(
      task.id,
      organizationId
    );
    expect(
      eligibility.some((candidate) => candidate.membershipId === manager.membership.id)
    ).toBe(false);
    await expect(
      taskService.assignStaff(
        task.id,
        organizationId,
        [manager.membership.id],
        adminUserId
      )
    ).rejects.toThrow("Managers cannot be assigned to tasks");
  });

  it("blocks inactive staff and platform-admin accounts at final assignment", async () => {
    const inactive = await createMembership("Inactive", { status: "inactive" });
    const platformAdmin = await createMembership("Platform Admin", {
      isPlatformAdmin: true,
    });
    const task = await createTask( { requiredHeadcount: 2 } );

    await expect(
      taskService.assignStaff(
        task.id,
        organizationId,
        [inactive.membership.id],
        adminUserId
      )
    ).rejects.toThrow("Inactive staff cannot be assigned to tasks");
    await expect(
      taskService.assignStaff(
        task.id,
        organizationId,
        [platformAdmin.membership.id],
        adminUserId
      )
    ).rejects.toThrow("Platform Admins cannot be assigned to tasks");
  });

  it("revalidates department membership immediately before assignment", async () => {
    const department = await prisma.department.create({
      data: { name: "Kitchen", organizationId },
    });
    const staff = await createMembership("Wrong Department");
    const task = await createTask({ departmentId: department.id });

    await expect(
      taskService.assignStaff(
        task.id,
        organizationId,
        [staff.membership.id],
        adminUserId
      )
    ).rejects.toThrow("Staff member is not assigned to the task department");
  });

  it("rejects stale availability and certification decisions", async () => {
    const unavailable = await createMembership("Unavailable", {
      employmentType: "casual",
    });
    const uncertified = await createMembership("Uncertified");
    const scheduledTask = await createTask({ scheduled: true });
    const certifiedTask = await createTask({
      requiredCertifications: ["Food Safety"],
    });

    await expect(
      taskService.assignStaff(
        scheduledTask.id,
        organizationId,
        [unavailable.membership.id],
        adminUserId
      )
    ).rejects.toThrow(/not available/i);
    await expect(
      taskService.assignStaff(
        certifiedTask.id,
        organizationId,
        [uncertified.membership.id],
        adminUserId
      )
    ).rejects.toThrow(/Missing required certification/);
  });

  it("rolls back the whole selected batch when one member is ineligible", async () => {
    const eligible = await createMembership("Eligible");
    const unavailable = await createMembership("Unavailable", {
      employmentType: "casual",
    });
    const task = await createTask({ requiredHeadcount: 2, scheduled: true });

    await expect(
      taskService.assignStaff(
        task.id,
        organizationId,
        [eligible.membership.id, unavailable.membership.id],
        adminUserId
      )
    ).rejects.toThrow(/not available/i);

    expect(
      await prisma.taskAssignment.count({ where: { taskId: task.id } })
    ).toBe(0);
  });

  it("does not leave a partial write when a batch contains a duplicate member", async () => {
    const staff = await createMembership("Duplicate");
    const task = await createTask({ requiredHeadcount: 2 });

    await expect(
      taskService.assignStaff(
        task.id,
        organizationId,
        [staff.membership.id, staff.membership.id],
        adminUserId
      )
    ).rejects.toThrow();

    expect(
      await prisma.taskAssignment.count({ where: { taskId: task.id } })
    ).toBe(0);
  });

  it("allows only one concurrent request to claim the final slot", async () => {
    const first = await createMembership("First");
    const second = await createMembership("Second");
    const task = await createTask({ requiredHeadcount: 1 });

    const results = await Promise.allSettled([
      taskService.assignStaff(
        task.id,
        organizationId,
        [first.membership.id],
        adminUserId
      ),
      taskService.assignStaff(
        task.id,
        organizationId,
        [second.membership.id],
        adminUserId
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.taskAssignment.count({ where: { taskId: task.id } })
    ).toBe(1);
  });

  it("revalidates auto-schedule drafts instead of assigning a manager", async () => {
    const manager = await createMembership("Schedule Manager", { role: "manager" });
    const task = await createTask();

    await expect(
      autoScheduleService.confirmSchedule(
        organizationId,
        [{ taskId: task.id, membershipId: manager.membership.id }],
        adminUserId
      )
    ).rejects.toThrow();
    expect(
      await prisma.taskAssignment.count({ where: { taskId: task.id } })
    ).toBe(0);
  });

  it("rolls back every draft for a task when one auto-schedule member is invalid", async () => {
    const staff = await createMembership("Valid Draft");
    const manager = await createMembership("Invalid Draft", { role: "manager" });
    const task = await createTask({ requiredHeadcount: 2 });
    await expect(
      autoScheduleService.confirmSchedule(
        organizationId,
        [
          { taskId: task.id, membershipId: staff.membership.id },
          { taskId: task.id, membershipId: manager.membership.id },
        ],
        adminUserId
      )
    ).rejects.toThrow();
    expect(
      await prisma.taskAssignment.count({ where: { taskId: task.id } })
    ).toBe(0);
  });

  it("rejects cross-tenant membership IDs from auto-schedule confirmation", async () => {
    const otherOrg = await prisma.organization.create({
      data: { name: "Other Org", slug: "other-org" },
    });
    const outsider = await createMembership("Outsider", {
      organizationId: otherOrg.id,
    });
    const task = await createTask();

    await expect(
      autoScheduleService.confirmSchedule(
        organizationId,
        [{ taskId: task.id, membershipId: outsider.membership.id }],
        adminUserId
      )
    ).rejects.toThrow("invalid staff member");
    expect(
      await prisma.taskAssignment.count({ where: { taskId: task.id } })
    ).toBe(0);
  });

  it("collects only active non-platform staff for auto-scheduling", async () => {
    const staff = await createMembership("Schedulable");
    await createMembership("Manager Candidate", { role: "manager" });
    await createMembership("Inactive Candidate", { status: "inactive" });
    await createMembership("Platform Candidate", { isPlatformAdmin: true });

    const context = await autoScheduleService.collectWeekData(
      organizationId,
      new Date("2026-06-15T00:00:00.000Z")
    );

    expect(context.staff.map((candidate) => candidate.membershipId)).toEqual([
      staff.membership.id,
    ]);
  });
});
