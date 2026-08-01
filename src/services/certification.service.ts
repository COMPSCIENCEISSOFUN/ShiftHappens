/**
 * Certification Service (Control Layer)
 *
 * Business logic for staff certification management.
 * Staff submit certifications, managers verify, reject or revoke them.
 * The eligibility engine uses verified, non-expired certifications to
 * determine task fitness.
 *
 * Status lifecycle:
 *   pending → verified → revoked
 *   pending → rejected
 *
 * "rejected" means never accepted; "revoked" means accepted and later
 * withdrawn. They are deliberately distinct — a compliance report needs to tell
 * a certificate that was refused from one that was honoured for six months and
 * then found invalid.
 *
 * Enforced rules:
 * - Only a pending certification can be verified or rejected
 * - Only a verified certification can be revoked
 * - A rejection or revocation must carry a reason
 * - Only a still-pending certification may be deleted, and only by its owner.
 *   Once a manager has acted the record survives: the eligibility engine used
 *   it to decide who could work which shifts, so deleting it would break the
 *   audit trail for those assignments.
 */
import { CertificationRepository } from "@/repositories/certification.repository";
import { AuditLogService, ACTIONS } from "@/services/audit-log.service";
import {
  NotificationService,
  NOTIFICATION_TYPES,
} from "@/services/notification.service";
import { startOfDayInTimeZone } from "@/lib/timezone";
import type { CreateCertificationInput } from "@/lib/validations";

import {
  EXPIRY_WARNING_DAYS,
  REJECTION_REASON_LABELS,
} from "@/lib/certification-display";

// The warning window and the reason labels are shared with the certification
// pages, which are client components and cannot import this file (it reaches
// Prisma through the repository). They live in `@/lib/certification-display`
// and are re-exported here so existing importers of the service keep working
// and there is still only one copy of each value.
export { EXPIRY_WARNING_DAYS, REJECTION_REASON_LABELS };

const DAY_MS = 24 * 60 * 60 * 1000;

export class CertificationService {
  private certRepo = new CertificationRepository();
  private auditService = new AuditLogService();
  private notificationService = new NotificationService();

  /** Submits a new certification */
  async create(membershipId: string, input: CreateCertificationInput) {
    return this.certRepo.create({
      membershipId,
      name: input.name,
      issuedDate: new Date(input.issuedDate),
      expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined,
      documentUrl: input.documentUrl,
    });
  }

  /**
   * Gets a certification by ID, scoped to an organization.
   * A cert belongs to the org of the member who owns it. Returns null for a
   * missing cert OR one owned by a member of another tenant.
   */
  async getById(certId: string, organizationId: string) {
    const cert = await this.certRepo.findById(certId);
    if (!cert || cert.membership.organizationId !== organizationId) return null;
    return cert;
  }

  /** Gets all certifications for a member */
  async getByMembership(membershipId: string) {
    return this.certRepo.findByMembershipId(membershipId);
  }

  /** Gets all certifications for an org, optionally filtered by status */
  async getByOrganization(
    organizationId: string,
    status?: string,
    departmentIds: string[] | null = null
  ) {
    return this.certRepo.findByOrganizationId(
      organizationId,
      status,
      departmentIds
    );
  }

  /**
   * Verifies or rejects a PENDING certification, scoped to an organization.
   * A rejection must carry a reason — telling someone "rejected" with no
   * explanation gives them nothing to act on.
   */
  async updateStatus(
    certId: string,
    organizationId: string,
    status: string,
    verifiedById: string,
    reason?: { rejectionReason?: string; rejectionNotes?: string },
    departmentIds: string[] | null = null
  ) {
    const cert = await this.certRepo.findById(certId);
    if (!cert || cert.membership.organizationId !== organizationId) {
      throw new Error("Certification not found");
    }
    if (!this.isWithinDepartmentScope(cert, departmentIds)) {
      throw new Error("Certification not found");
    }

    if (cert.status !== "pending") {
      throw new Error("Can only verify or reject pending certifications");
    }

    if (status === "rejected" && !reason?.rejectionReason) {
      throw new Error("A reason is required when rejecting a certification");
    }

    const updated = await this.certRepo.updateStatus(
      certId,
      status,
      verifiedById,
      status === "rejected" ? reason : undefined
    );

    void this.auditService.log({
      organizationId,
      userId: verifiedById,
      action:
        status === "verified"
          ? ACTIONS.CERTIFICATION_VERIFIED
          : ACTIONS.CERTIFICATION_REJECTED,
      entityType: "certification",
      entityId: certId,
      details: {
        name: cert.name,
        member: cert.membership.user?.name ?? cert.membership.user?.email,
        ...(status === "rejected" ? { ...reason } : {}),
      },
    });

    void this.notifyDecision(organizationId, cert, status, reason);

    return updated;
  }

  /**
   * Revokes a VERIFIED certification — it was honoured and is now withdrawn.
   * Not a delete: `getValidCertifications` filters on "verified", so the member
   * stops being eligible immediately while the record survives for the audit
   * trail of assignments already made on the strength of it.
   */
  async revoke(
    certId: string,
    organizationId: string,
    revokedById: string,
    reason: { rejectionReason: string; rejectionNotes?: string },
    departmentIds: string[] | null = null
  ) {
    const cert = await this.certRepo.findById(certId);
    if (!cert || cert.membership.organizationId !== organizationId) {
      throw new Error("Certification not found");
    }
    if (!this.isWithinDepartmentScope(cert, departmentIds)) {
      throw new Error("Certification not found");
    }

    if (cert.status !== "verified") {
      throw new Error("Can only revoke a verified certification");
    }

    const updated = await this.certRepo.updateStatus(
      certId,
      "revoked",
      revokedById,
      reason
    );

    void this.auditService.log({
      organizationId,
      userId: revokedById,
      action: ACTIONS.CERTIFICATION_REVOKED,
      entityType: "certification",
      entityId: certId,
      details: {
        name: cert.name,
        member: cert.membership.user?.name ?? cert.membership.user?.email,
        ...reason,
      },
    });

    void this.notifyDecision(organizationId, cert, "revoked", reason);

    return updated;
  }

  /**
   * Deletes a certification. Permitted only while still pending, and only for
   * the member who submitted it — a manager who disagrees with a submission
   * rejects it, leaving a record, rather than making it disappear.
   *
   * `actingMembershipId` is the caller's membership in this organisation.
   */
  async delete(
    certId: string,
    organizationId: string,
    actingMembershipId: string,
    actingUserId: string
  ) {
    const cert = await this.certRepo.findById(certId);
    if (!cert || cert.membership.organizationId !== organizationId) {
      throw new Error("Certification not found");
    }

    if (cert.membershipId !== actingMembershipId) {
      throw new Error("Not authorized");
    }

    if (cert.status !== "pending") {
      throw new Error("Only a pending certification can be withdrawn");
    }

    const deleted = await this.certRepo.delete(certId);

    void this.auditService.log({
      organizationId,
      userId: actingUserId,
      action: ACTIONS.CERTIFICATION_WITHDRAWN,
      entityType: "certification",
      entityId: certId,
      details: { name: cert.name },
    });

    return deleted;
  }

  /** Gets valid (verified, non-expired) certifications for eligibility checks */
  async getValidCertifications(membershipId: string) {
    return this.certRepo.getValidCertifications(membershipId);
  }

  /**
   * Certifications expiring within `days` for an organisation.
   * The window starts at the organisation's midnight rather than "now", so the
   * set does not quietly shift as the day progresses.
   */
  async getExpiringSoon(organizationId: string, days = EXPIRY_WARNING_DAYS) {
    const from = startOfDayInTimeZone(new Date());
    const until = new Date(from.getTime() + days * DAY_MS);
    return this.certRepo.findExpiringSoon(organizationId, from, until);
  }

  /**
   * Warns holders of certifications about to lapse.
   *
   * Run from the daily cron. Eligibility drops the moment a certificate
   * expires, so without this a staff member simply stops being offered work
   * they are qualified for and nobody knows why.
   *
   * Idempotent within a day: `wasNotifiedSince` suppresses a repeat for the
   * same certificate, so extra cron runs are harmless.
   */
  async notifyExpiring(
    organizationId: string,
    days = EXPIRY_WARNING_DAYS
  ): Promise<{ checked: number; notified: number }> {
    const expiring = await this.getExpiringSoon(organizationId, days);
    const since = startOfDayInTimeZone(new Date());
    let notified = 0;

    for (const cert of expiring) {
      const userId = cert.membership.userId;

      const already = await this.notificationService.wasNotifiedSince(
        userId,
        organizationId,
        NOTIFICATION_TYPES.CERT_EXPIRING,
        since,
        cert.id
      );
      if (already) continue;

      const daysLeft = cert.expiryDate
        ? Math.max(
            0,
            Math.ceil(
              (startOfDayInTimeZone(cert.expiryDate).getTime() -
                since.getTime()) /
                DAY_MS
            )
          )
        : null;

      await this.notificationService.notifyIfEnabled(
        organizationId,
        userId,
        NOTIFICATION_TYPES.CERT_EXPIRING,
        "A certification is about to expire",
        daysLeft === 0
          ? `Your "${cert.name}" certification expires today. Submit a renewal to stay eligible for tasks that require it.`
          : `Your "${cert.name}" certification expires in ${daysLeft} day${
              daysLeft === 1 ? "" : "s"
            }. Submit a renewal to stay eligible for tasks that require it.`,
        "certification",
        cert.id
      );
      notified++;
    }

    return { checked: expiring.length, notified };
  }

  /**
   * Tells the affected staff member the outcome of a review.
   * Fire-and-forget: a notification failure must never undo the decision.
   */
  private async notifyDecision(
    organizationId: string,
    cert: { id: string; name: string; membership: { userId: string } },
    status: string,
    reason?: { rejectionReason?: string; rejectionNotes?: string }
  ) {
    if (status === "verified") {
      return this.notificationService.notify(
        organizationId,
        cert.membership.userId,
        NOTIFICATION_TYPES.CERT_VERIFIED,
        "Certification verified",
        `Your "${cert.name}" certification was verified. You are now eligible for tasks that require it.`,
        "certification",
        cert.id
      );
    }

    const label = reason?.rejectionReason
      ? REJECTION_REASON_LABELS[reason.rejectionReason] ?? reason.rejectionReason
      : null;
    const detail = [label, reason?.rejectionNotes].filter(Boolean).join(" — ");
    const wasRevoked = status === "revoked";

    return this.notificationService.notify(
      organizationId,
      cert.membership.userId,
      NOTIFICATION_TYPES.CERT_REJECTED,
      wasRevoked ? "Certification revoked" : "Certification rejected",
      `Your "${cert.name}" certification was ${
        wasRevoked ? "revoked" : "rejected"
      }${detail ? `: ${detail}` : "."}`,
      "certification",
      cert.id
    );
  }

  private isWithinDepartmentScope(
    cert: { membership: { departmentMemberships: { departmentId: string }[] } },
    departmentIds: string[] | null
  ) {
    return (
      departmentIds === null ||
      cert.membership.departmentMemberships.some((membership) =>
        departmentIds.includes(membership.departmentId)
      )
    );
  }
}
