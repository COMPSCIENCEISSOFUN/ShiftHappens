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
import bcrypt from "bcryptjs";
import { MembershipRepository } from "@/repositories/membership.repository";
import { InvitationRepository } from "@/repositories/invitation.repository";
import { UserRepository } from "@/repositories/user.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { RoleRepository } from "@/repositories/role.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { EmailService } from "@/services/email.service";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import { SubscriptionService } from "@/services/subscription.service";
import type { InviteUserInput, UpdateUserRoleInput } from "@/lib/validations";

export class UserManagementService {
  private membershipRepo = new MembershipRepository();
  private invitationRepo = new InvitationRepository();
  private userRepo = new UserRepository();
  private orgRepo = new OrganizationRepository();
  private roleRepo = new RoleRepository();
  private deptRepo = new DepartmentRepository();
  private emailService = new EmailService();
  private auditService = new AuditLogService();
  private subscriptionService = new SubscriptionService();

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
   * 7. Send invitation email (fire-and-forget)
   */
  async inviteUser(
    input: InviteUserInput,
    organizationId: string,
    invitedById: string
  ) {
    await this.subscriptionService.enforceResourceLimit(organizationId, 'members');

    // Check if the email already belongs to a member of this org
    const existingUser = await this.userRepo.findByEmail(input.email);
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
      input.email,
      organizationId
    );
    if (pendingInvitation) {
      throw new Error("An invitation has already been sent to this email");
    }

    // Generate secure token and create invitation
    const token = crypto.randomBytes(32).toString("hex");

    const invitation = await this.invitationRepo.create({
      organizationId,
      email: input.email,
      role: input.role,
      departmentId: input.departmentId,
      employmentType: input.employmentType,
      token,
      invitedById,
    });

    await this.auditService.log({
      organizationId,
      userId: invitedById,
      action: ACTIONS.MEMBER_INVITED,
      entityType: "invitation",
      entityId: invitation.id,
      details: { email: input.email, role: input.role },
    });

    // Send invitation email (fire-and-forget — never blocks or fails the invite)
    this.sendInvitationEmailAsync(
      input.email,
      token,
      organizationId,
      invitedById
    );

    return invitation;
  }

  /**
   * Sends the invitation email asynchronously.
   * Fetches org name and inviter name, then delegates to EmailService.
   * Errors are logged but never propagated — the invitation is
   * already created regardless of email delivery.
   */
  private async sendInvitationEmailAsync(
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

      await this.emailService.sendInvitationEmail(
        email,
        token,
        org?.name || "your organization",
        inviter?.name || inviter?.email || "A team member"
      );
    } catch (error) {
      console.error("[Invite Email Error]", error);
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
      input.role
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
    const updated = await this.membershipRepo.updateStatus(membership.id, newStatus);

    await this.auditService.log({
      organizationId,
      userId: performedById,
      action: newStatus === "active" ? ACTIONS.MEMBER_ACTIVATED : ACTIONS.MEMBER_DEACTIVATED,
      entityType: "member",
      entityId: userId,
      details: { previousStatus: membership.status, newStatus },
    });

    return updated;
  }

  /**
   * Batch imports members from a spreadsheet upload.
   * For each row:
   * 1. Find or create user (new users get a random password — they use "Forgot Password" to set their own)
   * 2. Create membership with role and employment type
   * 3. Assign department by name lookup
   * 4. Audit log each creation
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

    // Pre-fetch existing members to detect duplicates
    const existingMembers = await this.membershipRepo.findByOrgId(organizationId);
    const existingEmails = new Set(
      existingMembers.map((m) => m.user.email.toLowerCase())
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

        // Check existing membership
        if (existingEmails.has(email)) {
          errors.push(`Row ${email}: Already a member`);
          failed++;
          continue;
        }

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

        // Find or create user
        let user = await this.userRepo.findByEmail(email);
        if (!user) {
          const randomPassword = crypto.randomBytes(32).toString("hex");
          const hashedPassword = await bcrypt.hash(randomPassword, 12);
          user = await this.userRepo.create({
            name: member.name.trim(),
            email,
            hashedPassword,
          });
          // Mark email as verified — admin is adding them directly
          await this.userRepo.verifyEmail(user.id);
        }

        // Create membership
        const membership = await this.membershipRepo.create({
          userId: user.id,
          organizationId,
          role: member.role,
          employmentType: member.employmentType,
        });

        // Assign department
        if (departmentId) {
          await this.membershipRepo.assignDepartments(membership.id, [departmentId]);
        }

        // Audit log (fire-and-forget)
        void this.auditService.log({
          organizationId,
          userId: performedById,
          action: ACTIONS.MEMBER_INVITED,
          entityType: "member",
          entityId: user.id,
          details: {
            method: "batch_import",
            email,
            role: member.role,
            employmentType: member.employmentType,
            departmentName: member.departmentName,
          },
        });

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