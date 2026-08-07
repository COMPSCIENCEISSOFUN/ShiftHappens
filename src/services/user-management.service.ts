/**
 * User Management Service (Control Layer)
 *
 * Orchestrates user management within an organization:
 * - Listing organization members
 * - Inviting new users via email (with invitation email)
 * - Updating member roles and department assignments
 * - Assigning custom roles (blocked for company_admin)
 * - Activating/deactivating members
 *
 * BCE: Sits between Boundary (API routes) and Entity (repositories).
 * Only Company Admin can perform these operations (enforced at Boundary).
 */
import crypto from "crypto";
import { normalizeEmploymentType } from "@/lib/role-config";
import { MembershipRepository } from "@/repositories/membership.repository";
import { InvitationRepository } from "@/repositories/invitation.repository";
import { UserRepository } from "@/repositories/user.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { RoleRepository } from "@/repositories/role.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { EmailService } from "@/services/email.service";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { ReplacementAllocationService } from "@/services/replacement-allocation.service";
import type { InviteUserInput, UpdateUserRoleInput } from "@/lib/validations";
import { prisma } from "@/lib/prisma";
import {
  getResourceLimit,
  SUBSCRIPTION_TIERS,
  SubscriptionLimitError,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";

export class UserManagementService {
  private membershipRepo = new MembershipRepository();
  private invitationRepo = new InvitationRepository();
  private userRepo = new UserRepository();
  private orgRepo = new OrganizationRepository();
  private roleRepo = new RoleRepository();
  private deptRepo = new DepartmentRepository();
  private emailService = new EmailService();
  private auditService = new AuditLogService();
  private replacementService = new ReplacementAllocationService();

  /**
   * Lists an org's members, optionally limited to a department scope.
   * `departmentScope` null/undefined = unrestricted (company admin); an array
   * limits results to members belonging to those departments (a scoped
   * manager only manages staff in their own departments).
   */
  async getOrgMembers(organizationId: string, departmentScope?: string[] | null) {
    const members = await this.membershipRepo.findByOrgId(organizationId);
    if (departmentScope === undefined || departmentScope === null) {
      return members;
    }
    const scope = new Set(departmentScope);
    return members.filter((m) =>
      (m.departmentMemberships ?? []).some((dm) => scope.has(dm.department.id))
    );
  }

  /**
   * Invites a user to an organization:
   * 1. Check subscription member limit
   * 2. Check if user is already a member
   * 3. Check for existing pending invitation
   * 4. Generate secure invitation token
   * 5. Create invitation record
   * 6. Log audit event
   * 7. Send the invitation email and persist its delivery outcome
   */
  async inviteUser(
    input: InviteUserInput,
    organizationId: string,
    invitedById: string,
    source: "direct" | "batch_import" = "direct"
  ) {
    const normalizedInput = {
      ...input,
      email: input.email.trim().toLowerCase(),
    };

    // Check if the email already belongs to a member of this org
    const existingUser = await this.userRepo.findByEmail(normalizedInput.email);
    if (existingUser) {
      // Including inactive: a deactivated member is still a member. The
      // (userId, organizationId) pair is unique, so inviting them again would
      // hit a constraint violation rather than create a second membership —
      // they need reactivating, not re-inviting.
      const existingMembership =
        await this.membershipRepo.findByUserAndOrgIncludingInactive(
          existingUser.id,
          organizationId
        );
      if (existingMembership) {
        throw new Error("User is already a member of this organization");
      }
    }

    // Check for duplicate pending invitation
    const pendingInvitation = await this.invitationRepo.findPendingByEmail(
      normalizedInput.email,
      organizationId
    );
    if (pendingInvitation) {
      throw new Error("An invitation has already been sent to this email");
    }

    // Generate secure token and create invitation
    const token = crypto.randomBytes(32).toString("hex");

    const invitation = await this.createInvitationAtomic(
      normalizedInput,
      organizationId,
      invitedById,
      token
    );

    await this.auditService.log({
      organizationId,
      userId: invitedById,
      action: ACTIONS.MEMBER_INVITED,
      entityType: "invitation",
      entityId: invitation.id,
      details: { email: normalizedInput.email, role: input.role, method: source },
    });

    const emailDelivery = await this.sendInvitationEmail(
      invitation.id,
      normalizedInput.email,
      token,
      organizationId,
      invitedById
    );

    return { ...invitation, emailDelivery };
  }

  async getOrgMembersPage(
    organizationId: string,
    departmentScope: string[] | null,
    limit: number,
    offset: number
  ) {
    return this.membershipRepo.findPageByOrgId(
      organizationId,
      departmentScope,
      limit,
      offset
    );
  }

  /** Final entitlement, duplicate, and tenant checks under a per-org DB lock. */
  private async createInvitationAtomic(
    input: InviteUserInput,
    organizationId: string,
    invitedById: string,
    token: string
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { subscriptionTier: true },
      });
      if (!organization) throw new Error("Organization not found");

      const now = new Date();
      await tx.invitationToken.deleteMany({
        where: {
          organizationId,
          email: input.email,
          acceptedAt: null,
          expires: { lte: now },
        },
      });

      const tier = SUBSCRIPTION_TIERS.includes(
        organization.subscriptionTier as SubscriptionTier
      )
        ? organization.subscriptionTier as SubscriptionTier
        : "free";
      const limit = getResourceLimit(tier, "members");
      const [activeMembers, pendingInvitations] = await Promise.all([
        tx.membership.count({ where: { organizationId, status: "active" } }),
        tx.invitationToken.count({
          where: { organizationId, acceptedAt: null, expires: { gt: now } },
        }),
      ]);
      const current = activeMembers + pendingInvitations;
      if (limit !== null && current >= limit) {
        throw new SubscriptionLimitError("members", current, limit, tier);
      }

      const existingUser = await tx.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (existingUser) {
        const membership = await tx.membership.findUnique({
          where: {
            userId_organizationId: {
              userId: existingUser.id,
              organizationId,
            },
          },
          select: { id: true },
        });
        if (membership) {
          throw new Error("User is already a member of this organization");
        }
      }

      const pending = await tx.invitationToken.findFirst({
        where: { organizationId, email: input.email, acceptedAt: null },
        select: { id: true },
      });
      if (pending) {
        throw new Error("An invitation has already been sent to this email");
      }

      if (input.departmentId) {
        const department = await tx.department.findFirst({
          where: { id: input.departmentId, organizationId },
          select: { id: true },
        });
        if (!department) throw new Error("Department not found");
      }

      const expires = new Date(now);
      expires.setDate(expires.getDate() + 7);
      return tx.invitationToken.create({
        data: {
          organizationId,
          email: input.email,
          role: input.role,
          departmentId: input.departmentId,
          employmentType:
            input.role === "staff"
              ? normalizeEmploymentType(input.employmentType)
              : undefined,
          token,
          invitedById,
          expires,
        },
      });
    }, { isolationLevel: "Serializable" });
  }

  /**
   * Sends the invitation email asynchronously.
   * Fetches org name and inviter name, then delegates to EmailService.
   * Errors are logged but never propagated — the invitation is
   * already created regardless of email delivery.
   */
  private async sendInvitationEmail(
    invitationId: string,
    email: string,
    token: string,
    organizationId: string,
    invitedById: string
  ) {
    try {
      const [org, inviter] = await Promise.all([
        this.orgRepo.findById(organizationId),
        this.userRepo.findById(invitedById),
      ]);

      const delivery = await this.emailService.sendInvitationEmail(
        email,
        token,
        org?.name || "your organization",
        inviter?.name || inviter?.email || "A team member"
      );
      await prisma.invitationToken.update({
        where: { id: invitationId },
        data: delivery.sent
          ? {
              emailDeliveryStatus: "sent",
              emailDeliveryError: null,
              emailSentAt: new Date(),
            }
          : {
              emailDeliveryStatus: "failed",
              emailDeliveryError: delivery.error ?? "Email delivery failed",
            },
      });
      return delivery;
    } catch (error) {
      console.error("[Invite Email Error]", error);
      const message =
        error instanceof Error ? error.message : "Email delivery failed";
      await prisma.invitationToken.update({
        where: { id: invitationId },
        data: { emailDeliveryStatus: "failed", emailDeliveryError: message },
      });
      return { sent: false, error: message };
    }
  }

  /**
   * Updates a member's role and optionally their department assignments.
   * Prevents the last company_admin from being demoted.
   * Auto-clears custom role when promoting to company_admin
   * (admins have full access — custom roles are redundant).
   */
  async updateMemberRole(
    userId: string,
    organizationId: string,
    input: UpdateUserRoleInput,
    performedById?: string
  ) {
    // Including inactive: `userId` is the member being administered, not the
    // admin doing it. An inactive member's role must still be changeable.
    const membership =
      await this.membershipRepo.findByUserAndOrgIncludingInactive(
        userId,
        organizationId
      );
    if (!membership) {
      throw new Error("Membership not found");
    }

    const previousRole = membership.role;
    const affectedTaskIds = input.role !== "staff"
      ? await this.activeTaskIdsForMember(membership.id)
      : [];

    // Prevent demoting the last company_admin
    if (membership.role === "company_admin" && input.role !== "company_admin") {
      const allMembers = await this.membershipRepo.findByOrgId(organizationId);
      const adminCount = allMembers.filter(
        (m) => m.role === "company_admin" && m.status === "active"
      ).length;

      if (adminCount <= 1) {
        throw new Error(
          "Cannot demote the last Company Admin. Promote another member first."
        );
      }
    }

    // Update the role
    const updated = await this.membershipRepo.updateRole(
      membership.id,
      input.role,
      performedById
    );

    // Auto-clear custom role when promoting to company_admin
    if (input.role === "company_admin") {
      const currentCustomRoleId = (membership as Record<string, unknown>).customRoleId as string | null;
      if (currentCustomRoleId) {
        await this.membershipRepo.updateCustomRole(membership.id, null);
      }
    }

    // Update employment type if provided
    if (input.employmentType !== undefined) {
      await this.membershipRepo.updateEmploymentType(
        membership.id,
        input.employmentType
      );
    }

    // Update department assignments if provided
    if (input.departmentIds) {
      await this.membershipRepo.assignDepartments(
        membership.id,
        input.departmentIds
      );
    }

    await this.auditService.log({
      organizationId,
      userId: performedById,
      action: ACTIONS.MEMBER_ROLE_CHANGED,
      entityType: "member",
      entityId: userId,
      details: { previousRole, newRole: input.role, departmentIds: input.departmentIds, employmentType: input.employmentType },
    });

    await this.refillAffectedTasks(
      affectedTaskIds,
      organizationId,
      performedById,
      membership.id,
      "Role-changed member"
    );

    return updated;
  }

  /**
   * Assigns a custom role to a member.
   * Company admins cannot have custom roles (they have full access).
   * Pass null to clear the custom role.
   */
  async assignCustomRole(
    userId: string,
    organizationId: string,
    customRoleId: string | null,
    performedById?: string
  ) {
    // Including inactive: administering the target member, not authorising the
    // caller. The route has already checked the caller is a company admin.
    const membership =
      await this.membershipRepo.findByUserAndOrgIncludingInactive(
        userId,
        organizationId
      );
    if (!membership) {
      throw new Error("Membership not found");
    }

    if (membership.role === "company_admin" && customRoleId !== null) {
      throw new Error("Company Admins cannot be assigned custom roles");
    }

    // Validate custom role exists in the org if assigning (not clearing)
    if (customRoleId) {
      const role = await this.roleRepo.findById(customRoleId);
      if (!role || role.organizationId !== organizationId) {
        throw new Error("Custom role not found");
      }
      if (role.isSystemRole) {
        throw new Error("Cannot assign system roles as custom roles");
      }
    }

    await this.membershipRepo.updateCustomRole(membership.id, customRoleId);

    await this.auditService.log({
      organizationId,
      userId: performedById,
      action: ACTIONS.MEMBER_ROLE_CHANGED,
      entityType: "member",
      entityId: userId,
      details: { customRoleId },
    });

    return { ...membership, customRoleId };
  }

  /**
   * Toggles a member's status between active and inactive.
   * Deactivation prevents access to the organization.
   */
  async toggleMemberStatus(userId: string, organizationId: string, performedById?: string) {
    // Including inactive is REQUIRED here, not merely preferable: reactivating a
    // member means looking them up while they are inactive. An active-only
    // lookup would throw "Membership not found" and make deactivation
    // irreversible.
    const membership =
      await this.membershipRepo.findByUserAndOrgIncludingInactive(
        userId,
        organizationId
      );
    if (!membership) {
      throw new Error("Membership not found");
    }

    // Prevent deactivating the last active admin
    if (membership.role === "company_admin" && membership.status === "active") {
      const allMembers = await this.membershipRepo.findByOrgId(organizationId);
      const activeAdmins = allMembers.filter(
        (m) => m.role === "company_admin" && m.status === "active"
      );

      if (activeAdmins.length <= 1) {
        throw new Error(
          "Cannot deactivate the last active Company Admin."
        );
      }
    }

    const newStatus = membership.status === "active" ? "inactive" : "active";
    const affectedTaskIds = newStatus === "inactive"
      ? await this.activeTaskIdsForMember(membership.id)
      : [];
    const updated = await this.membershipRepo.updateStatus(
      membership.id,
      newStatus,
      performedById
    );

    await this.auditService.log({
      organizationId,
      userId: performedById,
      action: newStatus === "active" ? ACTIONS.MEMBER_ACTIVATED : ACTIONS.MEMBER_DEACTIVATED,
      entityType: "member",
      entityId: userId,
      details: { previousStatus: membership.status, newStatus },
    });

    await this.refillAffectedTasks(
      affectedTaskIds,
      organizationId,
      performedById,
      membership.id,
      "Deactivated member"
    );

    return updated;
  }

  private async activeTaskIdsForMember(membershipId: string) {
    const assignments = await prisma.taskAssignment.findMany({
      where: {
        membershipId,
        status: { notIn: ["completed", "withdrawn", "cancelled"] },
        task: { status: "open" },
      },
      select: { taskId: true },
    });
    return [...new Set(assignments.map((assignment) => assignment.taskId))];
  }

  private async refillAffectedTasks(
    taskIds: string[],
    organizationId: string,
    actorUserId: string | undefined,
    removedMembershipId: string,
    removedStaffName: string
  ) {
    if (!actorUserId) return;
    for (const taskId of taskIds) {
      await this.replacementService.fillCoverageGap({
        taskId,
        organizationId,
        actorUserId,
        excludedMembershipIds: [removedMembershipId],
        removedStaffName,
      });
    }
  }

  /**
   * Batch imports members from a spreadsheet upload.
   * For each row:
   * Each valid row creates a normal invitation. The recipient chooses their
   * own password during acceptance; no pre-verified account or hidden random
   * credential is created by an import.
   *
   * Partial-success pattern — one failed row does not stop the batch.
   * Returns created count, failed count, and per-row error messages.
   */
  async batchImportMembers(
    organizationId: string,
    members: {
      name: string;
      email: string;
      role: string;
      departmentName: string | null;
      employmentType: string;
    }[],
    performedById: string
  ): Promise<{ created: number; failed: number; errors: string[] }> {
    // Pre-fetch org departments for name → ID lookup
    const departments = await this.deptRepo.findByOrganizationId(organizationId);
    const deptMap = new Map(
      departments.map((d) => [d.name.toLowerCase(), d.id])
    );

    // Track emails within batch to detect intra-batch duplicates
    const seenEmails = new Set<string>();

    let created = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const member of members) {
      const email = member.email.toLowerCase().trim();

      try {
        // Check intra-batch duplicate
        if (seenEmails.has(email)) {
          errors.push(`Row ${email}: Duplicate email within import`);
          failed++;
          continue;
        }
        seenEmails.add(email);

        // Resolve department
        let departmentId: string | null = null;
        if (member.departmentName) {
          departmentId = deptMap.get(member.departmentName.toLowerCase()) || null;
          if (!departmentId) {
            errors.push(
              `Row ${email}: Department "${member.departmentName}" not found`
            );
            failed++;
            continue;
          }
        }

        await this.inviteUser(
          {
            email,
            role: member.role as InviteUserInput["role"],
            departmentId: departmentId ?? undefined,
            employmentType:
              member.employmentType as InviteUserInput["employmentType"],
          },
          organizationId,
          performedById,
          "batch_import"
        );

        created++;
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(`Row ${email}: ${msg}`);
        failed++;
      }
    }

    return { created, failed, errors };
  }
}
