/**
 * Certification Repository (Entity Layer)
 * 
 * Data access layer for staff certifications.
 * Certifications are submitted by staff, verified by managers,
 * and used by the eligibility engine to determine task fitness.
 * 
 * Status lifecycle: pending → verified → revoked
 *                   pending → rejected
 *
 * rejected = never accepted. revoked = was verified, later withdrawn.
 * Nothing is hard-deleted once reviewed: the eligibility engine used these rows
 * to decide who could work which shifts, so they have to survive as an audit
 * trail. Only a still-pending submission may be removed, by its owner.
 *
 * Expiry is derived from expiryDate at check time, never stored.
 */
import { prisma } from "@/lib/prisma";

export class CertificationRepository {
  /** Creates a new certification submission */
  async create(data: {
    membershipId: string;
    name: string;
    issuedDate: Date;
    expiryDate?: Date;
    documentUrl?: string;
  }) {
    return prisma.certification.create({
      data: {
        membershipId: data.membershipId,
        name: data.name,
        issuedDate: data.issuedDate,
        expiryDate: data.expiryDate,
        documentUrl: data.documentUrl,
        status: "pending",
      },
    });
  }

  /** Finds a certification by ID */
  async findById(id: string) {
    return prisma.certification.findUnique({
      where: { id },
      include: {
        membership: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
        verifiedBy: { select: { id: true, name: true } },
      },
    });
  }

  /** Gets all certifications for a member */
  async findByMembershipId(membershipId: string) {
    return prisma.certification.findMany({
      where: { membershipId },
      include: {
        verifiedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Gets all certifications for an org, optionally filtered by status */
  async findByOrganizationId(organizationId: string, status?: string) {
    return prisma.certification.findMany({
      where: {
        membership: { organizationId },
        ...(status && { status }),
      },
      include: {
        membership: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
        verifiedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Records a status decision — verify, reject, or revoke.
   * `verifiedById`/`verifiedAt` hold the LAST reviewer and time; the audit log
   * carries the full history, so the row does not duplicate it.
   */
  async updateStatus(
    id: string,
    status: string,
    verifiedById: string,
    reason?: { rejectionReason?: string; rejectionNotes?: string }
  ) {
    return prisma.certification.update({
      where: { id },
      data: {
        status,
        verifiedById,
        verifiedAt: new Date(),
        // Prisma ignores `undefined`, so an approval explicitly CLEARS any
        // reason left over from an earlier rejection rather than keeping it.
        rejectionReason: reason?.rejectionReason ?? null,
        rejectionNotes: reason?.rejectionNotes ?? null,
      },
    });
  }

  /** Deletes a certification */
  async delete(id: string) {
    return prisma.certification.delete({ where: { id } });
  }

  /**
   * Certifications expiring within `days`, across an organisation.
   * Verified only — a pending or revoked certificate confers nothing, so its
   * expiry is not worth anyone's attention.
   */
  async findExpiringSoon(organizationId: string, from: Date, until: Date) {
    return prisma.certification.findMany({
      where: {
        membership: { organizationId, status: "active" },
        status: "verified",
        expiryDate: { gte: from, lte: until },
      },
      include: {
        membership: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
      orderBy: { expiryDate: "asc" },
    });
  }

  /**
   * Gets all valid (verified, non-expired) certifications for a member.
   * Used by the eligibility engine.
   */
  async getValidCertifications(membershipId: string) {
    return prisma.certification.findMany({
      where: {
        membershipId,
        status: "verified",
        OR: [
          { expiryDate: null },
          { expiryDate: { gt: new Date() } },
        ],
      },
    });
  }
}