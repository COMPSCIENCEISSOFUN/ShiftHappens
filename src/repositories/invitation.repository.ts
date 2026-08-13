/**
 * Invitation Repository (Entity Layer)
 * 
 * Data access layer for user invitation tokens.
 * Handles invitation creation, lookup, acceptance tracking,
 * and cleanup. Invitations expire after 7 days.
 * 
 * Flow: Company Admin invites user → token created → email sent →
 * user clicks link → token validated → membership created → token marked accepted.
 * 
 * Security: Tokens are unique, time-limited, and single-use.
 */
import { prisma } from "@/lib/prisma";

const INVITATION_EXPIRY_DAYS = 7;

export class InvitationRepository {
  /**
   * Creates a new invitation token.
   * Token expires after 7 days. Department assignment is optional.
   */
  async create(data: {
    organizationId: string;
    email: string;
    role: string;
    departmentId?: string;
    employmentType?: string;
    token: string;
    invitedById: string;
  }) {
    const expires = new Date();
    expires.setDate(expires.getDate() + INVITATION_EXPIRY_DAYS);

    return prisma.invitationToken.create({
      data: {
        organizationId: data.organizationId,
        email: data.email,
        role: data.role,
        departmentId: data.departmentId,
        employmentType: data.employmentType,
        token: data.token,
        invitedById: data.invitedById,
        expires,
      },
    });
  }

  /**
   * Finds an invitation by its token value.
   * Includes organization details for the acceptance page.
   */
  async findByToken(token: string) {
    return prisma.invitationToken.findUnique({
      where: { token },
      include: {
        organization: {
          select: { id: true, name: true, slug: true },
        },
      },
    });
  }

  /** Lists all invitations for an organization (pending and accepted) */
  async findByOrgId(organizationId: string) {
    return prisma.invitationToken.findMany({
      where: { organizationId },
      include: {
        invitedBy: {
          select: { name: true, email: true },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  /**
   * Finds a pending (not yet accepted) invitation for a specific
   * email in an organization. Used to prevent duplicate invitations.
   */
  async findPendingByEmail(email: string, organizationId: string) {
    return prisma.invitationToken.findFirst({
      where: {
        email,
        organizationId,
        acceptedAt: null,
      },
    });
  }

  /**
   * One invitation, scoped to the organisation it belongs to.
   *
   * `findFirst` with both columns rather than `findUnique` on the id alone:
   * the id comes off a URL, and a lookup that ignores the tenant would let an
   * admin of one organisation read — and then revoke — an invitation belonging
   * to another. Scoping in the query means the wrong tenant gets `null` and the
   * caller's "not found" branch does the rest, instead of every caller having
   * to remember to compare the organisation itself.
   */
  async findByIdInOrg(id: string, organizationId: string) {
    return prisma.invitationToken.findFirst({
      where: { id, organizationId },
    });
  }

  /** Marks an invitation as accepted by setting the acceptedAt timestamp */
  async markAccepted(id: string) {
    return prisma.invitationToken.update({
      where: { id },
      data: { acceptedAt: new Date() },
    });
  }

  /** Deletes an invitation (e.g. admin revokes a pending invitation) */
  async delete(id: string) {
    return prisma.invitationToken.delete({
      where: { id },
    });
  }
}