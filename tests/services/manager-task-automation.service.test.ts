import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant } from "../helpers/fixtures";
import { ManagerTaskAutomationService } from "@/services/manager-task-automation.service";

describe("ManagerTaskAutomationService", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("executes a complete request and reports the assigned staff", async () => {
    const tenant = await createTenant("manager-automation");
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { id: tenant.manager.membershipId },
      include: { departmentMemberships: { include: { department: true } } },
    });

    const result = await new ManagerTaskAutomationService().execute(
      `Need 1 staff for Kitchen ${tenant.orgSlug} tomorrow morning for prep`,
      tenant.orgId,
      tenant.manager.userId,
      membership
    );

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.assignedStaff).toEqual([`staff ${tenant.orgSlug}`]);
      expect(result.task?.department?.id).toBe(tenant.departmentId);
    }
  });

  it("asks for the department before creating an ambiguous task", async () => {
    const tenant = await createTenant("manager-review");
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { id: tenant.admin.membershipId },
      include: { departmentMemberships: { include: { department: true } } },
    });

    const result = await new ManagerTaskAutomationService().execute(
      "I need someone to prepare tomorrow morning",
      tenant.orgId,
      tenant.admin.userId,
      membership
    );

    expect(result.status).toBe("needs_review");
    expect(result.message).toContain("Which department");
    expect(await prisma.task.count({ where: { organizationId: tenant.orgId } })).toBe(0);
  });

  it("uses the manager's only department when the request omits one", async () => {
    const tenant = await createTenant("manager-single-scope");
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { id: tenant.manager.membershipId },
      include: { departmentMemberships: { include: { department: true } } },
    });

    const result = await new ManagerTaskAutomationService().execute(
      "Need 1 staff tomorrow morning for preparation",
      tenant.orgId,
      tenant.manager.userId,
      membership
    );

    expect(result.status).toBe("completed");
    expect(await prisma.task.count({ where: { organizationId: tenant.orgId, departmentId: tenant.departmentId } })).toBe(1);
  });

  it("returns only authorised departments for an ambiguous multi-department request", async () => {
    const tenant = await createTenant("manager-multi-scope");
    const secondDepartment = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId },
    });
    await prisma.departmentMembership.create({
      data: { membershipId: tenant.manager.membershipId, departmentId: secondDepartment.id },
    });
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { id: tenant.manager.membershipId },
      include: { departmentMemberships: { include: { department: true } } },
    });

    const result = await new ManagerTaskAutomationService().execute(
      "Need 1 staff tomorrow morning for preparation",
      tenant.orgId,
      tenant.manager.userId,
      membership
    );

    expect(result.status).toBe("needs_review");
    if (result.status === "needs_review") {
      expect(result.departmentOptions?.map((department) => department.id).sort()).toEqual(
        [tenant.departmentId, secondDepartment.id].sort()
      );
    }
  });
});
