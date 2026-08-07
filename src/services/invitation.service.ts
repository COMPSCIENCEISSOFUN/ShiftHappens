import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { normalizeEmploymentType } from "@/lib/role-config";
import {
  getResourceLimit,
  SUBSCRIPTION_TIERS,
  SubscriptionLimitError,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";
import { InvitationRepository } from "@/repositories/invitation.repository";
import { UserRepository } from "@/repositories/user.repository";

/** Atomic, entitlement-safe invitation acceptance. */
export class InvitationService {
  private invitationRepo = new InvitationRepository();
  private userRepo = new UserRepository();

  async getInvitationDetails(token: string) {
    const invitation = await this.invitationRepo.findByToken(token);
    if (!invitation || invitation.acceptedAt || invitation.expires < new Date()) {
      return null;
    }
    const existingUser = await this.userRepo.findByEmail(invitation.email);
    return { ...invitation, existingUser: Boolean(existingUser) };
  }

  async acceptInvitation(
    token: string,
    registrationData: { name: string; password: string } | null
  ) {
    // Hash before opening the transaction so bcrypt does not hold the org lock.
    const hashedPassword = registrationData
      ? await bcrypt.hash(registrationData.password, 12)
      : null;

    return prisma.$transaction(async (tx) => {
      const initial = await tx.invitationToken.findUnique({ where: { token } });
      if (!initial) throw new Error("Invalid or expired invitation");

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${initial.organizationId}))`;
      const invitation = await tx.invitationToken.findUnique({ where: { token } });
      const now = new Date();
      if (!invitation || invitation.acceptedAt || invitation.expires < now) {
        throw new Error("Invalid or expired invitation");
      }

      const organization = await tx.organization.findUnique({
        where: { id: invitation.organizationId },
        select: { subscriptionTier: true },
      });
      if (!organization) throw new Error("Organization not found");
      const tier = SUBSCRIPTION_TIERS.includes(
        organization.subscriptionTier as SubscriptionTier
      )
        ? organization.subscriptionTier as SubscriptionTier
        : "free";
      const limit = getResourceLimit(tier, "members");
      const [activeMembers, validPending] = await Promise.all([
        tx.membership.count({
          where: { organizationId: invitation.organizationId, status: "active" },
        }),
        tx.invitationToken.count({
          where: {
            organizationId: invitation.organizationId,
            acceptedAt: null,
            expires: { gt: now },
          },
        }),
      ]);
      const billableCount = activeMembers + validPending;
      // This invitation is already part of validPending; accepting it replaces
      // one pending seat with one active seat, so equality is allowed.
      if (limit !== null && billableCount > limit) {
        throw new SubscriptionLimitError("members", billableCount, limit, tier);
      }

      let user = await tx.user.findUnique({ where: { email: invitation.email } });
      if (!user) {
        if (!registrationData || !hashedPassword) {
          throw new Error("Registration data required for new users");
        }
        user = await tx.user.create({
          data: {
            name: registrationData.name,
            email: invitation.email,
            hashedPassword,
            emailVerified: now,
          },
        });
      }

      const existingMembership = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: invitation.organizationId,
          },
        },
        select: { id: true },
      });
      if (existingMembership) {
        throw new Error("User is already a member of this organization");
      }

      if (invitation.departmentId) {
        const department = await tx.department.findFirst({
          where: {
            id: invitation.departmentId,
            organizationId: invitation.organizationId,
          },
          select: { id: true },
        });
        if (!department) {
          throw new Error("Invitation department is no longer available");
        }
      }

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          role: invitation.role,
          status: "active",
          employmentType:
            invitation.role === "staff"
              ? normalizeEmploymentType(invitation.employmentType)
              : null,
        },
      });
      if (invitation.departmentId) {
        await tx.departmentMembership.create({
          data: {
            membershipId: membership.id,
            departmentId: invitation.departmentId,
          },
        });
      }
      await tx.invitationToken.update({
        where: { id: invitation.id },
        data: { acceptedAt: now },
      });

      return { user };
    }, { isolationLevel: "Serializable" });
  }
}
