/**
 * Tests for Invitation Service (Control Layer)
 * Verifies invitation acceptance flow for both new users
 * (register + join org) and existing users (just join org).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { InvitationService } from "@/services/invitation.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const invitationService = new InvitationService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();
const deptRepo = new DepartmentRepository();

let orgId: string;
let adminUserId: string;

vi.mock("@/services/email.service", () => ({
  EmailService: class {
    sendVerificationEmail = vi.fn().mockResolvedValue(undefined);
    sendPasswordResetEmail = vi.fn().mockResolvedValue(undefined);
    sendInvitationEmail = vi.fn().mockResolvedValue(undefined);
  },
}));

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

describe("InvitationService", () => {
  describe("getInvitationDetails", () => {
    it("returns invitation details for a valid token", async () => {
      const invitation = await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "newuser@example.com",
          role: "staff",
          token: "valid-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const details = await invitationService.getInvitationDetails("valid-token");
      expect(details).not.toBeNull();
      expect(details!.email).toBe("newuser@example.com");
      expect(details!.organization.name).toBe("Acme Corp");
    });

    it("returns null for expired token", async () => {
      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "newuser@example.com",
          role: "staff",
          token: "expired-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() - 1000), // Already expired
        },
      });

      const details = await invitationService.getInvitationDetails("expired-token");
      expect(details).toBeNull();
    });

    it("returns null for already accepted token", async () => {
      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "newuser@example.com",
          role: "staff",
          token: "accepted-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          acceptedAt: new Date(),
        },
      });

      const details = await invitationService.getInvitationDetails("accepted-token");
      expect(details).toBeNull();
    });
  });

  describe("acceptInvitation — new user", () => {
    it("creates user, membership, and marks invitation accepted", async () => {
      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "newuser@example.com",
          role: "staff",
          token: "accept-new-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await invitationService.acceptInvitation(
        "accept-new-token",
        { name: "New User", password: "SecurePass1!" }
      );

      expect(result.user.email).toBe("newuser@example.com");
      expect(result.user.name).toBe("New User");

      // Verify membership was created
      const membership = await prisma.membership.findFirst({
        where: {
          userId: result.user.id,
          organizationId: orgId,
        },
      });
      expect(membership).not.toBeNull();
      expect(membership!.role).toBe("staff");

      // Verify invitation was marked accepted
      const invitation = await prisma.invitationToken.findUnique({
        where: { token: "accept-new-token" },
      });
      expect(invitation!.acceptedAt).not.toBeNull();
    });

    it("assigns department if specified in invitation", async () => {
      const dept = await deptRepo.create({
        name: "Engineering",
        organizationId: orgId,
      });

      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "dev@example.com",
          role: "staff",
          departmentId: dept.id,
          token: "dept-invite-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await invitationService.acceptInvitation(
        "dept-invite-token",
        { name: "Dev User", password: "SecurePass1!" }
      );

      const deptMemberships = await prisma.departmentMembership.findMany({
        where: {
          membership: {
            userId: result.user.id,
            organizationId: orgId,
          },
        },
      });
      expect(deptMemberships).toHaveLength(1);
      expect(deptMemberships[0].departmentId).toBe(dept.id);
    });

    it("sets emailVerified for invited users", async () => {
      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "verified@example.com",
          role: "staff",
          token: "verified-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await invitationService.acceptInvitation(
        "verified-token",
        { name: "Verified User", password: "SecurePass1!" }
      );

      expect(result.user.emailVerified).not.toBeNull();
    });
  });

  describe("acceptInvitation — existing user", () => {
    it("adds existing user to the organization", async () => {
      // Create an existing user not in this org
      const existingUser = await userRepo.create({
        name: "Existing User",
        email: "existing@example.com",
        hashedPassword: "hash",
      });

      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "existing@example.com",
          role: "manager",
          token: "existing-user-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await invitationService.acceptInvitation(
        "existing-user-token",
        null // No registration data — user already exists
      );

      expect(result.user.id).toBe(existingUser.id);

      const membership = await prisma.membership.findFirst({
        where: {
          userId: existingUser.id,
          organizationId: orgId,
        },
      });
      expect(membership).not.toBeNull();
      expect(membership!.role).toBe("manager");
    });
  });

  describe("acceptInvitation — employmentType carry-through", () => {
    it("maps a legacy full_time invitation to casual membership", async () => {
      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "ftuser@example.com",
          role: "staff",
          employmentType: "full_time",
          token: "ft-invite-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await invitationService.acceptInvitation(
        "ft-invite-token",
        { name: "Legacy Full-time User", password: "SecurePass1!" }
      );

      const membership = await prisma.membership.findFirst({
        where: {
          userId: result.user.id,
          organizationId: orgId,
        },
      });
      expect(membership).not.toBeNull();
      expect(membership!.employmentType).toBe("casual");
    });

    it("carries casual employmentType from invitation to membership", async () => {
      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "casual@example.com",
          role: "staff",
          employmentType: "casual",
          token: "casual-invite-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await invitationService.acceptInvitation(
        "casual-invite-token",
        { name: "Casual User", password: "SecurePass1!" }
      );

      const membership = await prisma.membership.findFirst({
        where: {
          userId: result.user.id,
          organizationId: orgId,
        },
      });
      expect(membership!.employmentType).toBe("casual");
    });

    it("carries temporary or part-time employmentType to membership", async () => {
      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "temporary@example.com",
          role: "staff",
          employmentType: "temporary_part_time",
          token: "temporary-invite-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await invitationService.acceptInvitation(
        "temporary-invite-token",
        { name: "Temporary User", password: "SecurePass1!" }
      );
      const membership = await prisma.membership.findFirst({
        where: { userId: result.user.id, organizationId: orgId },
      });

      expect(membership!.employmentType).toBe("temporary_part_time");
    });

    it("defaults a Staff invitation without employmentType to casual", async () => {
      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "noet@example.com",
          role: "staff",
          token: "no-et-invite-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await invitationService.acceptInvitation(
        "no-et-invite-token",
        { name: "No ET User", password: "SecurePass1!" }
      );

      const membership = await prisma.membership.findFirst({
        where: {
          userId: result.user.id,
          organizationId: orgId,
        },
      });
      expect(membership!.employmentType).toBe("casual");
    });

    it("normalizes legacy employmentType for an existing user", async () => {
      const existingUser = await userRepo.create({
        name: "Existing FT",
        email: "existingft@example.com",
        hashedPassword: "hash",
      });

      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "existingft@example.com",
          role: "staff",
          employmentType: "full_time",
          token: "existing-ft-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await invitationService.acceptInvitation(
        "existing-ft-token",
        null
      );

      expect(result.user.id).toBe(existingUser.id);

      const membership = await prisma.membership.findFirst({
        where: {
          userId: existingUser.id,
          organizationId: orgId,
        },
      });
      expect(membership!.employmentType).toBe("casual");
    });
  });

  describe("acceptInvitation — error cases", () => {
    it("throws for invalid token", async () => {
      await expect(
        invitationService.acceptInvitation("nonexistent", {
          name: "User",
          password: "SecurePass1!",
        })
      ).rejects.toThrow("Invalid or expired invitation");
    });

    it("throws for expired token", async () => {
      await prisma.invitationToken.create({
        data: {
          organizationId: orgId,
          email: "expired@example.com",
          role: "staff",
          token: "expired-accept-token",
          invitedById: adminUserId,
          expires: new Date(Date.now() - 1000),
        },
      });

      await expect(
        invitationService.acceptInvitation("expired-accept-token", {
          name: "User",
          password: "SecurePass1!",
        })
      ).rejects.toThrow("Invalid or expired invitation");
    });
  });
});
