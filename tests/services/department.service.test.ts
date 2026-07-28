/**
 * Tests for Department Service (Control Layer)
 *
 * Verifies department CRUD business logic including:
 * - Creation with duplicate name prevention
 * - Update with name conflict detection
 * - Archive (soft-delete) lifecycle
 * - Unarchive (restore from archive)
 * - Impact summary before archive
 * - Permanent delete gated behind archived-only
 * - Member guard on permanent delete
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DepartmentService } from "@/services/department.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const deptService = new DepartmentService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
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
});

describe("DepartmentService", () => {
  describe("create", () => {
    it("creates a department", async () => {
      const dept = await deptService.create(
        { name: "Engineering", description: "Dev team" },
        orgId
      );

      expect(dept.name).toBe("Engineering");
      expect(dept.description).toBe("Dev team");
      expect(dept.organizationId).toBe(orgId);
    });

    it("throws if department name already exists in org", async () => {
      await deptService.create({ name: "Engineering" }, orgId);

      await expect(
        deptService.create({ name: "Engineering" }, orgId)
      ).rejects.toThrow("Department name already exists");
    });
  });

  describe("getByOrganization", () => {
    it("returns all active departments for an org", async () => {
      await deptService.create({ name: "Engineering" }, orgId);
      await deptService.create({ name: "Marketing" }, orgId);

      const depts = await deptService.getByOrganization(orgId);
      expect(depts).toHaveLength(2);
    });

    it("excludes archived departments by default", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);
      await deptService.create({ name: "Marketing" }, orgId);
      await deptService.archive(dept.id, orgId);

      const depts = await deptService.getByOrganization(orgId);
      expect(depts).toHaveLength(1);
      expect(depts[0].name).toBe("Marketing");
    });

    it("includes archived departments when requested", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);
      await deptService.create({ name: "Marketing" }, orgId);
      await deptService.archive(dept.id, orgId);

      const depts = await deptService.getByOrganization(orgId, true);
      expect(depts).toHaveLength(2);
    });
  });

  describe("getById", () => {
    it("returns a department by ID", async () => {
      const created = await deptService.create({ name: "Engineering" }, orgId);

      const found = await deptService.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Engineering");
    });
  });

  describe("update", () => {
    it("updates department name", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);

      const updated = await deptService.update(dept.id, orgId, {
        name: "Product Engineering",
      });
      expect(updated.name).toBe("Product Engineering");
    });

    it("throws if new name conflicts with existing department", async () => {
      await deptService.create({ name: "Engineering" }, orgId);
      const dept2 = await deptService.create({ name: "Marketing" }, orgId);

      await expect(
        deptService.update(dept2.id, orgId, { name: "Engineering" })
      ).rejects.toThrow("Department name already exists");
    });

    it("allows updating to the same name (no-op rename)", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);

      const updated = await deptService.update(dept.id, orgId, {
        name: "Engineering",
        description: "Updated desc",
      });
      expect(updated.description).toBe("Updated desc");
    });
  });

  describe("archive", () => {
    it("archives an active department", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);

      const archived = await deptService.archive(dept.id, orgId, userId);
      expect(archived.archivedAt).not.toBeNull();
    });

    it("throws if department is already archived", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);
      await deptService.archive(dept.id, orgId);

      await expect(
        deptService.archive(dept.id, orgId)
      ).rejects.toThrow("Department is already archived");
    });

    it("throws if department not found", async () => {
      await expect(
        deptService.archive("nonexistent-id", orgId)
      ).rejects.toThrow("Department not found");
    });

    it("archived department is hidden from default listing", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);
      await deptService.archive(dept.id, orgId);

      const depts = await deptService.getByOrganization(orgId);
      expect(depts).toHaveLength(0);
    });
  });

  describe("unarchive", () => {
    it("restores an archived department", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);
      await deptService.archive(dept.id, orgId);

      const restored = await deptService.unarchive(dept.id, orgId, userId);
      expect(restored.archivedAt).toBeNull();
    });

    it("restored department reappears in active listing", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);
      await deptService.archive(dept.id, orgId);
      await deptService.unarchive(dept.id, orgId);

      const depts = await deptService.getByOrganization(orgId);
      expect(depts).toHaveLength(1);
      expect(depts[0].name).toBe("Engineering");
    });

    it("throws if department is not archived", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);

      await expect(
        deptService.unarchive(dept.id, orgId)
      ).rejects.toThrow("Department is not archived");
    });

    it("throws if department not found", async () => {
      await expect(
        deptService.unarchive("nonexistent-id", orgId)
      ).rejects.toThrow("Department not found");
    });
  });

  describe("getImpactSummary", () => {
    it("returns zero counts for an empty department", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);

      const impact = await deptService.getImpactSummary(dept.id);
      expect(impact.memberCount).toBe(0);
      expect(impact.activeTaskCount).toBe(0);
      expect(impact.workRuleCount).toBe(0);
    });

    it("counts assigned members", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);

      const membership = await prisma.membership.findFirst({
        where: { organizationId: orgId },
      });
      await prisma.departmentMembership.create({
        data: { membershipId: membership!.id, departmentId: dept.id },
      });

      const impact = await deptService.getImpactSummary(dept.id);
      expect(impact.memberCount).toBe(1);
    });

    it("counts active tasks", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);

      await prisma.task.create({
        data: {
          title: "Active Task",
          organizationId: orgId,
          departmentId: dept.id,
          status: "open",
          createdById: userId,
        },
      });
      await prisma.task.create({
        data: {
          title: "In Progress Task",
          organizationId: orgId,
          departmentId: dept.id,
          status: "in_progress",
          createdById: userId,
        },
      });
      // Completed task should not be counted
      await prisma.task.create({
        data: {
          title: "Done Task",
          organizationId: orgId,
          departmentId: dept.id,
          status: "completed",
          createdById: userId,
        },
      });

      const impact = await deptService.getImpactSummary(dept.id);
      expect(impact.activeTaskCount).toBe(2);
    });

    it("counts work rules", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);

      await prisma.workRule.create({
        data: {
          name: "Max Hours",
          type: "max_hours_daily",
          organizationId: orgId,
          departmentId: dept.id,
          maxHours: 8,
        },
      });

      const impact = await deptService.getImpactSummary(dept.id);
      expect(impact.workRuleCount).toBe(1);
    });
  });

  describe("delete", () => {
    it("permanently deletes an archived department with no members", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);
      await deptService.archive(dept.id, orgId);

      await deptService.delete(dept.id, orgId, userId);

      const found = await deptService.getById(dept.id);
      expect(found).toBeNull();
    });

    it("throws if department is not archived", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);

      await expect(deptService.delete(dept.id, orgId)).rejects.toThrow(
        "Department must be archived before it can be permanently deleted"
      );
    });

    it("throws if archived department has members", async () => {
      const dept = await deptService.create({ name: "Engineering" }, orgId);

      const membership = await prisma.membership.findFirst({
        where: { organizationId: orgId },
      });
      await prisma.departmentMembership.create({
        data: { membershipId: membership!.id, departmentId: dept.id },
      });

      await deptService.archive(dept.id, orgId);

      await expect(deptService.delete(dept.id, orgId)).rejects.toThrow(
        "Cannot delete department with assigned members"
      );
    });

    it("throws if department not found", async () => {
      await expect(
        deptService.delete("nonexistent-id", orgId)
      ).rejects.toThrow("Department not found");
    });
  });
});
