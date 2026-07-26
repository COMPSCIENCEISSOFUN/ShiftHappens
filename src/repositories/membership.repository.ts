/**
 * Membership Repository (Entity Layer)
 * 
 * Data access layer for organization membership operations.
 * Handles member listing, role updates, status changes (activate/deactivate),
 * and department assignments.
 * 
 * Multi-tenancy: All queries are org-scoped for tenant isolation.
 * Security: Prisma parameterized queries prevent SQL injection.
 */
import { prisma } from "@/lib/prisma";

export class MembershipRepository {
  /**
   * Lists all members of an organization with their user details
   * and department assignments. Used by Company Admin and Manager
   * for user management views.
   */
  async findByOrgId(organizationId: string) {
    return prisma.membership.findMany({
      where: { organizationId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            emailVerified: true,
          },
        },
        departmentMemberships: {
          include: {
            department: {
              select: { id: true, name: true },
            },
          },
        },
        customRole: {
          select: { id: true, name: true, displayLabel: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Finds a specific user's membership in an organization.
   * Used for permission checks and role verification.
   */
  async findByUserAndOrg(userId: string, organizationId: string) {
    return prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId, organizationId },
      },
      include: {
        departmentMemberships: {
          include: {
            department: {
              select: { id: true, name: true },
            },
          },
        },
      },
    });
  }

  /** Creates a new membership (used when inviting users to an org) */
  async create(data: {
    userId: string;
    organizationId: string;
    role: string;
    employmentType?: string;
  }) {
    return prisma.membership.create({
      data: {
        userId: data.userId,
        organizationId: data.organizationId,
        role: data.role,
        status: "active",
        employmentType: data.employmentType || null,
      },
    });
  }

  /** Updates a member's role (e.g. staff → manager) */
  async updateRole(membershipId: string, role: string) {
    return prisma.membership.update({
      where: { id: membershipId },
      data: { role },
    });
  }

  /** Sets or clears a member's custom role assignment */
  async updateCustomRole(membershipId: string, customRoleId: string | null) {
    return prisma.membership.update({
      where: { id: membershipId },
      data: { customRoleId },
    });
  }

  /** Updates a member's employment type (full_time / casual) */
  async updateEmploymentType(membershipId: string, employmentType: string) {
    return prisma.membership.update({
      where: { id: membershipId },
      data: { employmentType },
    });
  }

  /**
   * Updates a member's status (active/inactive).
   * Deactivation prevents login to this org.
   * Task auto-unassignment will be added in Phase 4.
   */
  async updateStatus(membershipId: string, status: string) {
    return prisma.membership.update({
      where: { id: membershipId },
      data: { status },
    });
  }

  /**
   * Assigns a member to one or more departments.
   * Uses delete-then-create pattern to replace existing assignments.
   * This supports managers with multiple department assignments.
   */
  async assignDepartments(membershipId: string, departmentIds: string[]) {
    // Remove all current department assignments
    await prisma.departmentMembership.deleteMany({
      where: { membershipId },
    });

    // Create new assignments
    if (departmentIds.length > 0) {
      await prisma.departmentMembership.createMany({
        data: departmentIds.map((departmentId) => ({
          membershipId,
          departmentId,
        })),
      });
    }
  }

  /** Gets all departments a member is assigned to */
  async getDepartments(membershipId: string) {
    return prisma.departmentMembership.findMany({
      where: { membershipId },
      include: {
        department: {
          select: { id: true, name: true },
        },
      },
    });
  }

  /** Finds a membership by its ID */
  async findById(id: string) {
    return prisma.membership.findUnique({
      where: { id },
    });
  }

  /**
   * Finds a membership with the user and department details needed for
   * eligibility checks and hour-limit alerting.
   */
  async findByIdWithDetails(id: string) {
    return prisma.membership.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        departmentMemberships: {
          include: { department: { select: { id: true, name: true } } },
        },
      },
    });
  }
}