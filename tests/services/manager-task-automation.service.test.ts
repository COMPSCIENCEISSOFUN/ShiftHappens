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
      where: { id: tenant.manager.membershipId },
      include: { departmentMemberships: { include: { department: true } } },
    });

    const result = await new ManagerTaskAutomationService().execute(
      "I need someone to prepare tomorrow morning",
      tenant.orgId,
      tenant.manager.userId,
      membership
    );

    expect(result.status).toBe("needs_review");
    expect(result.message).toContain("Which department");
    expect(await prisma.task.count({ where: { organizationId: tenant.orgId } })).toBe(0);
  });
});
