import { beforeEach, describe, expect, it } from "vitest";
import { OperationsAssistantService } from "@/services/operations-assistant.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

describe("OperationsAssistantService", () => {
  beforeEach(async () => cleanDatabase());

  it("gives staff a personal work brief without exposing other members' tasks", async () => {
    const [staffUser, otherUser] = await Promise.all([
      prisma.user.create({ data: { name: "Taylor", email: "taylor@example.com", hashedPassword: "hash" } }),
      prisma.user.create({ data: { name: "Other", email: "other@example.com", hashedPassword: "hash" } }),
    ]);
    const organization = await prisma.organization.create({ data: { name: "Assistant Test", slug: "assistant-test" } });
    const [staffMembership, otherMembership] = await Promise.all([
      prisma.membership.create({ data: { userId: staffUser.id, organizationId: organization.id, role: "staff" } }),
      prisma.membership.create({ data: { userId: otherUser.id, organizationId: organization.id, role: "staff" } }),
    ]);
    const task = await prisma.task.create({
      data: { title: "Personal shift", organizationId: organization.id, createdById: staffUser.id, scheduledStart: new Date(Date.now() + 60 * 60 * 1000), scheduledEnd: new Date(Date.now() + 2 * 60 * 60 * 1000) },
    });
    await prisma.taskAssignment.create({ data: { taskId: task.id, membershipId: staffMembership.id, assignedById: staffUser.id } });
    await prisma.taskAssignment.create({ data: { taskId: task.id, membershipId: otherMembership.id, assignedById: staffUser.id } });

    const result = await new OperationsAssistantService().execute({
      text: "What do I need to do today?",
      organizationId: organization.id,
      userId: staffUser.id,
      membership: staffMembership,
    });

    expect(result.status).toBe("completed");
    expect(result.details).toEqual([expect.stringContaining("Personal shift")]);
  });

  it("only undoes a manager's own assistant-created task within their department scope", async () => {
    const [managerUser, adminUser] = await Promise.all([
      prisma.user.create({ data: { name: "Manager", email: "manager@example.com", hashedPassword: "hash" } }),
      prisma.user.create({ data: { name: "Admin", email: "admin@example.com", hashedPassword: "hash" } }),
    ]);
    const organization = await prisma.organization.create({ data: { name: "Undo Test", slug: "undo-test" } });
    const department = await prisma.department.create({ data: { name: "Operations", organizationId: organization.id } });
    const manager = await prisma.membership.create({ data: { userId: managerUser.id, organizationId: organization.id, role: "manager" }, include: { departmentMemberships: { include: { department: true } } } });
    await prisma.departmentMembership.create({ data: { membershipId: manager.id, departmentId: department.id } });
    const refreshedManager = await prisma.membership.findUniqueOrThrow({ where: { id: manager.id }, include: { departmentMemberships: { include: { department: true } } } });
    const task = await prisma.task.create({ data: { title: "Assistant task", organizationId: organization.id, departmentId: department.id, createdById: managerUser.id } });

    const result = await new OperationsAssistantService().undo({
      undo: { kind: "task", taskIds: [task.id] },
      organizationId: organization.id,
      userId: managerUser.id,
      membership: refreshedManager,
    });

    expect(result.message).toContain("undone");
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toBeNull();
    await expect(prisma.user.findUnique({ where: { id: adminUser.id } })).resolves.not.toBeNull();
  });
});
