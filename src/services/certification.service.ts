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
  isExpiryNotifyDay,
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
  /**
   * A member submits a certificate for review.
   *
   * `context` exists only so this can be audited. Verification, rejection,
   * revocation and withdrawal all wrote an audit row; submission did not — so
   * the log could tell you a certificate had been verified with no record of it
   * ever arriving, which is the one step that says who claimed the
   * qualification in the first place. `CERTIFICATION_SUBMITTED` had been
   * declared for months with nothing raising it.
   *
   * Passed in rather than looked up: the route already holds both, and a query
   * to recover what the caller knows is a query for nothing.
   */
  async create(
    membershipId: string,
    input: CreateCertificationInput,
    context: { organizationId: string; userId: string }
  ) {
    const cert = await this.certRepo.create({
      membershipId,
      name: input.name,
      issuedDate: new Date(input.issuedDate),
      expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined,
      documentUrl: input.documentUrl,
    });

    void this.auditService.log({
      organizationId: context.organizationId,
      userId: context.userId,
      action: ACTIONS.CERTIFICATION_SUBMITTED,
      entityType: "certification",
      entityId: cert.id,
      details: { name: cert.name, expiryDate: input.expiryDate ?? null },
    });

    return cert;
  }

  /**
   * Gets a certification by ID, scoped to an organization and, optionally, to
   * a set of departments.
   *
   * A cert belongs to the org of the member who owns it. Returns null for a
   * missing cert, one owned by a member of another tenant, or — when a scope is
   * given — one owned by a member outside it.
   */
  async getById(
    certId: string,
    organizationId: string,
    departmentScope?: string[] | null
  ) {
    const cert = await this.certRepo.findById(certId);
    if (!cert || cert.membership.organizationId !== organizationId) return null;
    if (!this.ownerInScope(cert, departmentScope)) return null;
    return cert;
  }

  /**
   * Is this certification's owner inside the caller's department scope?
   *
   * `undefined`/`null` means unrestricted — a company admin. Anything else is
   * the caller's own departments, and the owner must share at least one.
   *
   * The listing endpoint was scoped from the start; the three that ACT on a
   * single record were not, and a certification id is not a secret — they come
   * back in dashboard and eligibility payloads. A manager scoped to Kitchen
   * could verify or revoke a Front-of-House member's certification, which
   * silently changes who the eligibility engine will roster.
   */
  private ownerInScope(
    cert: {
      membership: { departmentMemberships: { departmentId: string }[] };
    },
    departmentScope?: string[] | null
  ): boolean {
    if (departmentScope === undefined || departmentScope === null) return true;
    const scope = new Set(departmentScope);
    return cert.membership.departmentMemberships.some((dm) =>
      scope.has(dm.departmentId)
    );
  }

  /** Gets all certifications for a member */
  async getByMembership(membershipId: string) {
    return this.certRepo.findByMembershipId(membershipId);
  }

  /**
   * Gets all certifications for an org, optionally filtered by status and
   * limited to a department scope.
   *
   * `departmentScope` null/undefined = unrestricted (company admin); an array
   * limits results to certifications owned by members of those departments,
   * matching `TaskService.getByOrganization`. Without this a manager scoped to
   * one department could read every staff member's certification record in the
   * organisation.
   */
  async getByOrganization(
    organizationId: string,
    status?: string,
    departmentScope?: string[] | null
  ) {
    return this.certRepo.findByOrganizationId(
      organizationId,
      status,
      departmentScope
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
    departmentScope?: string[] | null
  ) {
    const cert = await this.certRepo.findById(certId);
    if (
      !cert ||
      cert.membership.organizationId !== organizationId ||
      !this.ownerInScope(cert, departmentScope)
    ) {
      // Out of scope is reported as not found on purpose — a manager should
      // not be able to probe for the existence of another department's records.
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
    departmentScope?: string[] | null
  ) {
    const cert = await this.certRepo.findById(certId);
    if (
      !cert ||
      cert.membership.organizationId !== organizationId ||
      !this.ownerInScope(cert, departmentScope)
    ) {
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
   * ## Once a day was the bug, not the guarantee
   *
   * `wasNotifiedSince` still suppresses a repeat within the same day, so extra
   * cron runs remain harmless — but that was the ONLY limit, and the scan runs
   * daily, so a certificate entering the 30-day window produced roughly thirty
   * notifications. The docstring described that as idempotent, which it was,
   * and it was still a month of identical morning messages.
   *
   * Now the member is told at the marks in `EXPIRY_NOTIFY_DAYS` — a month out,
   * a fortnight, a week, then three days, one, and the day itself — so the
   * warning tightens as it approaches costing them their eligibility and says
   * nothing in between. Five or six messages instead of thirty.
   *
   * A certificate whose expiry falls between two runs is not skipped: the marks
   * are checked against days REMAINING, and the daily scan visits every day.
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

      // Computed BEFORE the dedupe query, so a day that is not a mark costs no
      // database round trip at all — on a normal morning that is every row.
      if (!isExpiryNotifyDay(daysLeft)) continue;

      const already = await this.notificationService.wasNotifiedSince(
        userId,
        organizationId,
        NOTIFICATION_TYPES.CERT_EXPIRING,
        since,
        cert.id
      );
      if (already) continue;

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
}
