/**
 * Profile Service (Control Layer)
 * 
 * Handles user profile operations. Created to fix the BCE violation
 * where the profile API route was directly importing UserRepository.
 * Now the route goes through this service (Boundary → Control → Entity).
 */
import bcrypt from "bcryptjs";
import { UserRepository } from "@/repositories/user.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";

export class ProfileService {
  private userRepo = new UserRepository();
  private auditService = new AuditLogService();

  /** Retrieves safe user profile data (excludes hashedPassword) */
  async getProfile(userId: string) {
    const user = await this.userRepo.findById(userId);
    if (!user) return null;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: user.createdAt,
    };
  }

  /**
   * Retrieves full profile data including org memberships.
   * Used by the redesigned Profile page to show the user's
   * organisations, roles, and account details in one view.
   */
  async getFullProfile(userId: string) {
    const user = await this.userRepo.findByIdWithMemberships(userId);
    if (!user) return null;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: user.createdAt,
      memberships: user.memberships.map((m) => ({
        id: m.id,
        role: m.role,
        status: m.status,
        employmentType: m.employmentType,
        joinedAt: m.createdAt,
        organization: {
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
        },
        customRole: m.customRole
          ? {
              id: m.customRole.id,
              name: m.customRole.name,
              displayLabel: m.customRole.displayLabel,
            }
          : null,
      })),
    };
  }

  /**
   * Updates user profile (name and/or password).
   * Password change requires verifying the current password first.
   */
  async updateProfile(
    userId: string,
    data: {
      name?: string;
      currentPassword?: string;
      newPassword?: string;
    }
  ) {
    const updateData: { name?: string; hashedPassword?: string } = {};

    if (data.name) {
      updateData.name = data.name;
    }

    if (data.newPassword && data.currentPassword) {
      const user = await this.userRepo.findById(userId);
      if (!user) throw new Error("User not found");

      const isValid = await bcrypt.compare(
        data.currentPassword,
        user.hashedPassword
      );
      if (!isValid) {
        throw new Error("Current password is incorrect");
      }

      updateData.hashedPassword = await bcrypt.hash(data.newPassword, 12);
    }

    const updated = await this.userRepo.updateProfile(userId, updateData);

    /*
     * Two events, because they answer different questions. A name change is
     * housekeeping; a password change is the thing somebody looks for after a
     * suspected compromise, and burying it inside "profile updated" would make
     * it findable only by reading the details of every edit.
     *
     * `changed` names the fields rather than carrying their values — an audit
     * row recording somebody's new name is a copy of data that already lives on
     * the user, and one recording anything about a password would be worse.
     */
    if (updateData.hashedPassword) {
      await this.auditService.logForUser({
        userId,
        action: ACTIONS.USER_PASSWORD_CHANGED,
        entityType: "user",
        details: { via: "profile" },
      });
    }

    if (updateData.name) {
      await this.auditService.logForUser({
        userId,
        action: ACTIONS.USER_PROFILE_UPDATED,
        entityType: "user",
        details: { changed: ["name"] },
      });
    }

    return {
      id: updated.id,
      name: updated.name,
      email: updated.email,
    };
  }
}