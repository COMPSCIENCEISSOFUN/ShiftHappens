/**
 * Profile Service (Control Layer)
 * 
 * Handles user profile operations. Created to fix the BCE violation
 * where the profile API route was directly importing UserRepository.
 * Now the route goes through this service (Boundary → Control → Entity).
 */
import bcrypt from "bcryptjs";
import { UserRepository } from "@/repositories/user.repository";

export class ProfileService {
  private userRepo = new UserRepository();

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

    return {
      id: updated.id,
      name: updated.name,
      email: updated.email,
    };
  }
}