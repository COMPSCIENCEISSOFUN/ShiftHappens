/**
 * Tests for Membership Repository (Entity Layer)
 * Verifies org membership operations including role updates,
 * department assignments, and user status management.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MembershipRepository } from "@/repositories/membership.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const membershipRepo = new MembershipRepository();
const deptRepo = new DepartmentRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let adminUserId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = user.id;

  const org = await orgRepo.create(
    { name: "Acme Corp", slug: "acme-corp" },
    user.id
  );
  orgId = org.id;
});

describe("MembershipRepository", () => {
  describe("findByOrgId", () => {
    it("returns all members of an organization", async () => {
      const user2 = await userRepo.create({
        name: "Staff User",
        email: "staff@example.com",
        hashedPassword: "hash",
      });

      await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });

      const members = await membershipRepo.findByOrgId(orgId);
      expect(members).toHaveLength(2);
    });

    it("does not return members from other organizations", async () => {
      const user2 = await userRepo.create({
        name: "Other User",
        email: "other@example.com",
        hashedPassword: "hash",
      });
      const org2 = await orgRepo.create(
        { name: "Other Corp", slug: "other-corp" },
        user2.id
      );

      const members = await membershipRepo.findByOrgId(orgId);
      expect(members).toHaveLength(1);
    });
  });

  describe("findByUserAndOrg", () => {
    it("finds a specific user's membership in an org", async () => {
      const membership = await membershipRepo.findByUserAndOrg(
        adminUserId,
        orgId
      );

      expect(membership).not.toBeNull();
      expect(membership!.role).toBe("company_admin");
    });

    it("returns null for non-member", async () => {
      const user2 = await userRepo.create({
        name: "Outsider",
        email: "outsider@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.findByUserAndOrg(
        user2.id,
        orgId
      );
      expect(membership).toBeNull();
    });

    /**
     * The security property this method exists to provide.
     *
     * Every API route gates on `if (!membership) return 403`. Before this
     * filter, a deactivated member satisfied that check and kept full access to
     * the organisation they had been removed from — only three route files
     * checked `membership.status` themselves.
     */
    it("returns null for a deactivated member", async () => {
      const user2 = await userRepo.create({
        name: "Deactivated Staff",
        email: "deactivated@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });
      await membershipRepo.updateStatus(membership.id, "inactive");

      const found = await membershipRepo.findByUserAndOrg(user2.id, orgId);
      expect(found).toBeNull();
    });

    it("finds the member again once reactivated", async () => {
      const user2 = await userRepo.create({
        name: "Returning Staff",
        email: "returning@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });

      await membershipRepo.updateStatus(membership.id, "inactive");
      expect(await membershipRepo.findByUserAndOrg(user2.id, orgId)).toBeNull();

      await membershipRepo.updateStatus(membership.id, "active");
      const found = await membershipRepo.findByUserAndOrg(user2.id, orgId);
      expect(found).not.toBeNull();
      expect(found!.role).toBe("staff");
    });

    it("still includes department memberships", async () => {
      // departmentScopeFor() reads this off the returned membership, so the
      // switch from findUnique to findFirst must not drop the include.
      const dept = await deptRepo.create({
        name: "Kitchen",
        organizationId: orgId,
      });
      const membership = await membershipRepo.findByUserAndOrg(
        adminUserId,
        orgId
      );
      await membershipRepo.assignDepartments(membership!.id, [dept.id]);

      const reloaded = await membershipRepo.findByUserAndOrg(
        adminUserId,
        orgId
      );
      expect(reloaded!.departmentMemberships).toHaveLength(1);
      expect(reloaded!.departmentMemberships[0].department.name).toBe("Kitchen");
    });
  });

  describe("findByUserAndOrgIncludingInactive", () => {
    /**
     * The counterpart, and the reason the split exists. Reactivating a member
     * requires finding them WHILE they are inactive — an active-only lookup
     * would throw "Membership not found" and make deactivation irreversible.
     */
    it("finds a deactivated member", async () => {
      const user2 = await userRepo.create({
        name: "Deactivated Staff",
        email: "deactivated2@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });
      await membershipRepo.updateStatus(membership.id, "inactive");

      const found = await membershipRepo.findByUserAndOrgIncludingInactive(
        user2.id,
        orgId
      );
      expect(found).not.toBeNull();
      expect(found!.status).toBe("inactive");
    });

    it("finds an active member too", async () => {
      const found = await membershipRepo.findByUserAndOrgIncludingInactive(
        adminUserId,
        orgId
      );
      expect(found).not.toBeNull();
      expect(found!.role).toBe("company_admin");
    });

    it("still returns null for a genuine non-member", async () => {
      const user2 = await userRepo.create({
        name: "Outsider",
        email: "outsider2@example.com",
        hashedPassword: "hash",
      });

      const found = await membershipRepo.findByUserAndOrgIncludingInactive(
        user2.id,
        orgId
      );
      expect(found).toBeNull();
    });

    it("disagrees with findByUserAndOrg exactly when the member is inactive", async () => {
      // States the contract as a single assertion: the two methods differ on
      // inactive members and agree on everything else.
      const user2 = await userRepo.create({
        name: "Toggling Staff",
        email: "toggling@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });

      const active = await Promise.all([
        membershipRepo.findByUserAndOrg(user2.id, orgId),
        membershipRepo.findByUserAndOrgIncludingInactive(user2.id, orgId),
      ]);
      expect(active[0]).not.toBeNull();
      expect(active[1]).not.toBeNull();

      await membershipRepo.updateStatus(membership.id, "inactive");

      const inactive = await Promise.all([
        membershipRepo.findByUserAndOrg(user2.id, orgId),
        membershipRepo.findByUserAndOrgIncludingInactive(user2.id, orgId),
      ]);
      expect(inactive[0]).toBeNull();
      expect(inactive[1]).not.toBeNull();
    });
  });

  describe("create", () => {
    it("creates a new membership", async () => {
      const user2 = await userRepo.create({
        name: "New Staff",
        email: "newstaff@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });

      expect(membership.id).toBeDefined();
      expect(membership.role).toBe("staff");
      expect(membership.status).toBe("active");
    });
  });

  describe("updateRole", () => {
    it("updates a member's role", async () => {
      const user2 = await userRepo.create({
        name: "Staff User",
        email: "staff@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });

      const updated = await membershipRepo.updateRole(
        membership.id,
        "manager"
      );
      expect(updated.role).toBe("manager");
    });
  });

  describe("updateStatus", () => {
    it("deactivates a member", async () => {
      const user2 = await userRepo.create({
        name: "Staff User",
        email: "staff@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });

      const updated = await membershipRepo.updateStatus(
        membership.id,
        "inactive"
      );
      expect(updated.status).toBe("inactive");
    });

    it("reactivates a member", async () => {
      const user2 = await userRepo.create({
        name: "Staff User",
        email: "staff@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });

      await membershipRepo.updateStatus(membership.id, "inactive");
      const reactivated = await membershipRepo.updateStatus(
        membership.id,
        "active"
      );
      expect(reactivated.status).toBe("active");
    });
  });

  describe("updateEmploymentType", () => {
    it("updates a member's employment type", async () => {
      const user2 = await userRepo.create({
        name: "Staff User",
        email: "staff@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });

      const updated = await membershipRepo.updateEmploymentType(
        membership.id,
        "full_time"
      );
      expect(updated.employmentType).toBe("full_time");
    });

    it("changes employment type from full_time to casual", async () => {
      const user2 = await userRepo.create({
        name: "Staff User",
        email: "staff@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
        employmentType: "full_time",
      });

      const updated = await membershipRepo.updateEmploymentType(
        membership.id,
        "casual"
      );
      expect(updated.employmentType).toBe("casual");
    });
  });

  describe("create with employmentType", () => {
    it("creates membership with employmentType", async () => {
      const user2 = await userRepo.create({
        name: "FT Staff",
        email: "ftstaff@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
        employmentType: "full_time",
      });

      expect(membership.employmentType).toBe("full_time");
    });

    it("defaults employmentType to null when not provided", async () => {
      const user2 = await userRepo.create({
        name: "No ET Staff",
        email: "noet@example.com",
        hashedPassword: "hash",
      });

      const membership = await membershipRepo.create({
        userId: user2.id,
        organizationId: orgId,
        role: "staff",
      });

      expect(membership.employmentType).toBeNull();
    });
  });

  describe("assignDepartments", () => {
    it("assigns a member to departments", async () => {
      const dept1 = await deptRepo.create({
        name: "Engineering",
        organizationId: orgId,
      });
      const dept2 = await deptRepo.create({
        name: "Marketing",
        organizationId: orgId,
      });

      const membership = await prisma.membership.findFirst({
        where: { userId: adminUserId, organizationId: orgId },
      });

      await membershipRepo.assignDepartments(membership!.id, [
        dept1.id,
        dept2.id,
      ]);

      const deptMemberships = await prisma.departmentMembership.findMany({
        where: { membershipId: membership!.id },
      });
      expect(deptMemberships).toHaveLength(2);
    });

    it("replaces existing department assignments", async () => {
      const dept1 = await deptRepo.create({
        name: "Engineering",
        organizationId: orgId,
      });
      const dept2 = await deptRepo.create({
        name: "Marketing",
        organizationId: orgId,
      });
      const dept3 = await deptRepo.create({
        name: "Sales",
        organizationId: orgId,
      });

      const membership = await prisma.membership.findFirst({
        where: { userId: adminUserId, organizationId: orgId },
      });

      // First assign to dept1 and dept2
      await membershipRepo.assignDepartments(membership!.id, [
        dept1.id,
        dept2.id,
      ]);

      // Then reassign to dept3 only — should replace, not append
      await membershipRepo.assignDepartments(membership!.id, [dept3.id]);

      const deptMemberships = await prisma.departmentMembership.findMany({
        where: { membershipId: membership!.id },
      });
      expect(deptMemberships).toHaveLength(1);
      expect(deptMemberships[0].departmentId).toBe(dept3.id);
    });
  });

  describe("getDepartments", () => {
    it("returns departments for a membership", async () => {
      const dept1 = await deptRepo.create({
        name: "Engineering",
        organizationId: orgId,
      });
      const dept2 = await deptRepo.create({
        name: "Marketing",
        organizationId: orgId,
      });

      const membership = await prisma.membership.findFirst({
        where: { userId: adminUserId, organizationId: orgId },
      });

      await membershipRepo.assignDepartments(membership!.id, [
        dept1.id,
        dept2.id,
      ]);

      const depts = await membershipRepo.getDepartments(membership!.id);
      expect(depts).toHaveLength(2);
    });
  });

  describe("findByOrgId — customRole include", () => {
    it("returns customRole data when a custom role is assigned", async () => {
      const staff = await userRepo.create({
        name: "Staff User",
        email: "staff@example.com",
        hashedPassword: "hash",
      });
      const membership = await membershipRepo.create({
        userId: staff.id,
        organizationId: orgId,
        role: "staff",
      });

      const customRole = await prisma.role.create({
        data: {
          name: "shift_lead",
          displayLabel: "Shift Lead",
          organizationId: orgId,
          isSystemRole: false,
        },
      });

      await membershipRepo.updateCustomRole(membership.id, customRole.id);

      const members = await membershipRepo.findByOrgId(orgId);
      const staffMember = members.find((m) => m.user.email === "staff@example.com");

      expect(staffMember).toBeDefined();
      expect(staffMember!.customRole).not.toBeNull();
      expect(staffMember!.customRole!.id).toBe(customRole.id);
      expect(staffMember!.customRole!.displayLabel).toBe("Shift Lead");
      expect(staffMember!.customRole!.name).toBe("shift_lead");
    });

    it("returns customRole as null when not assigned", async () => {
      const members = await membershipRepo.findByOrgId(orgId);
      expect(members).toHaveLength(1);
      expect(members[0].customRole).toBeNull();
    });

    it("returns customRole as null after clearing assignment", async () => {
      const staff = await userRepo.create({
        name: "Staff User",
        email: "staff@example.com",
        hashedPassword: "hash",
      });
      const membership = await membershipRepo.create({
        userId: staff.id,
        organizationId: orgId,
        role: "staff",
      });

      const customRole = await prisma.role.create({
        data: {
          name: "bartender",
          displayLabel: "Bartender",
          organizationId: orgId,
          isSystemRole: false,
        },
      });

      await membershipRepo.updateCustomRole(membership.id, customRole.id);
      await membershipRepo.updateCustomRole(membership.id, null);

      const members = await membershipRepo.findByOrgId(orgId);
      const staffMember = members.find((m) => m.user.email === "staff@example.com");
      expect(staffMember!.customRole).toBeNull();
    });
  });
});