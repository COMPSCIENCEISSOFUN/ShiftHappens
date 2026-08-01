import { describe, it, expect, beforeEach } from "vitest";
import { AllocationService } from "@/services/allocation.service";
import { TaskRepository } from "@/repositories/task.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const taskRepo = new TaskRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let adminUserId: string;
let staffMembershipId1: string;
let staffMembershipId2: string;

beforeEach(async () => {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create(
    { name: "Acme Corp", slug: "acme-corp" },
    admin.id
  );
  orgId = org.id;

  await prisma.companySettings.create({
    data: {
      organizationId: orgId,
      allocationMode: "manual",
      breakRuleHoursWorked: 8,
    },
  });

  const staff1 = await userRepo.create({
    name: "Alex Rivera",
    email: "alex@example.com",
    hashedPassword: "hash",
  });
  const membership1 = await prisma.membership.create({
    data: {
      userId: staff1.id,
      organizationId: orgId,
      role: "staff",
      status: "active",
    },
  });
  staffMembershipId1 = membership1.id;

  const staff2 = await userRepo.create({
    name: "Jamie Park",
    email: "jamie@example.com",
    hashedPassword: "hash",
  });
  const membership2 = await prisma.membership.create({
    data: {
      userId: staff2.id,
      organizationId: orgId,
      role: "staff",
      status: "active",
    },
  });
  staffMembershipId2 = membership2.id;
});

describe("AllocationService", () => {
  describe("getSuggestions", () => {
    it("returns ranked suggestions for eligible staff", async () => {
      const task = await taskRepo.create({
        title: "Test task",
        organizationId: orgId,
        createdById: adminUserId,
      });

      const service = new AllocationService();
      const suggestions = await service.getSuggestions(task.id, orgId);

      expect(suggestions.map((s) => s.membershipId).sort()).toEqual(
        [staffMembershipId1, staffMembershipId2].sort()
      );
    });

    it("returns empty when no eligible staff", async () => {
      await prisma.membership.updateMany({
        where: { organizationId: orgId, role: "staff" },
        data: { status: "inactive" },
      });

      const task = await taskRepo.create({
        title: "Test task",
        organizationId: orgId,
        createdById: adminUserId,
      });

      const service = new AllocationService();
      const suggestions = await service.getSuggestions(task.id, orgId);

      expect(suggestions).toHaveLength(0);
    });

    it("throws if task not found", async () => {
      const service = new AllocationService();

      await expect(
        service.getSuggestions("nonexistent", orgId)
      ).rejects.toThrow("Task not found");
    });
  });

  describe("autoAllocate", () => {
    it("throws if auto mode is not enabled", async () => {
      const task = await taskRepo.create({
        title: "Test task",
        organizationId: orgId,
        createdById: adminUserId,
      });

      const service = new AllocationService();

      await expect(
        service.autoAllocate(task.id, orgId, adminUserId)
      ).rejects.toThrow("Auto allocation is not enabled");
    });

    it("auto-assigns staff as active assignments when auto mode is enabled", async () => {
      await prisma.companySettings.update({
        where: { organizationId: orgId },
        data: { allocationMode: "auto" },
      });

      const task = await taskRepo.create({
        title: "Auto task",
        organizationId: orgId,
        createdById: adminUserId,
        requiredHeadcount: 1,
      });

      const service = new AllocationService();
      const assignments = await service.autoAllocate(task.id, orgId, adminUserId);

      expect(assignments).toHaveLength(1);
      expect(assignments[0].status).toBe("assigned");
    });
  });
});
