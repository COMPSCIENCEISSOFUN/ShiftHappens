/**
 * Tests for Certification Service (Control Layer)
 *
 * Covers submission, the verify/reject/revoke lifecycle, rejection reasons,
 * the withdraw rules, expiry warnings, and tenant scoping.
 *
 * The lifecycle rules are the point of this file:
 *   pending → verified → revoked
 *   pending → rejected
 * A certificate that has been acted on is an audit artifact — the eligibility
 * engine used it to decide who could work which shifts — so only a still-pending
 * submission may be deleted, and only by the member who submitted it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  CertificationService,
  EXPIRY_WARNING_DAYS,
} from "@/services/certification.service";
import { NOTIFICATION_TYPES } from "@/services/notification.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { eventuallyAtLeast } from "../helpers/settle";

const certService = new CertificationService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

const DAY_MS = 24 * 60 * 60 * 1000;

let orgId: string;
let membershipId: string;
let staffUserId: string;
let adminUserId: string;
let adminMembershipId: string;

beforeEach(async () => {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create(
    { name: "Acme Corp", slug: "acme-corp" },
    admin.id
  );
  orgId = org.id;

  const adminMembership = await prisma.membership.findFirstOrThrow({
    where: { userId: admin.id, organizationId: org.id },
  });
  adminMembershipId = adminMembership.id;

  const staff = await userRepo.create({
    name: "Staff User",
    email: "staff@example.com",
    hashedPassword: "hash",
  });
  staffUserId = staff.id;

  const staffMembership = await prisma.membership.create({
    data: {
      userId: staff.id,
      organizationId: org.id,
      role: "staff",
      status: "active",
    },
  });
  membershipId = staffMembership.id;
});

/** A pending submission for the staff member. */
async function submit(name = "Food Safety", expiryDate?: string) {
  return certService.create(
    membershipId,
    {
      name,
      issuedDate: "2026-01-15T00:00:00.000Z",
      ...(expiryDate ? { expiryDate } : {}),
    },
    { organizationId: orgId, userId: staffUserId }
  );
}

/** A verified certification, optionally expiring in `daysFromNow`. */
async function verifiedCert(name = "Food Safety", daysFromNow?: number) {
  const cert = await certService.create(
    membershipId,
    {
      name,
      issuedDate: "2026-01-01T00:00:00.000Z",
      ...(daysFromNow !== undefined
        ? { expiryDate: new Date(Date.now() + daysFromNow * DAY_MS).toISOString() }
        : {}),
    },
    { organizationId: orgId, userId: staffUserId }
  );
  await certService.updateStatus(cert.id, orgId, "verified", adminUserId);
  return cert;
}

function notificationsFor(userId: string, type: string) {
  return prisma.notification.findMany({ where: { userId, type } });
}

describe("CertificationService", () => {
  describe("create", () => {
    it("creates a certification with pending status", async () => {
      const cert = await submit("Food Safety Level 2", "2027-01-15T00:00:00.000Z");

      expect(cert.name).toBe("Food Safety Level 2");
      expect(cert.status).toBe("pending");
      expect(cert.rejectionReason).toBeNull();
    });
  });

  describe("updateStatus — verify", () => {
    it("verifies a pending certification", async () => {
      const cert = await submit();

      const verified = await certService.updateStatus(
        cert.id,
        orgId,
        "verified",
        adminUserId
      );

      expect(verified.status).toBe("verified");
      expect(verified.verifiedById).toBe(adminUserId);
    });

    it("notifies the holder", async () => {
      const cert = await submit();
      await certService.updateStatus(cert.id, orgId, "verified", adminUserId);
      // Polled rather than slept — the notify call is fire-and-forget,
      // so a fixed pause is a guess about how fast the machine is.
      const notes = await eventuallyAtLeast(() =>
        notificationsFor(staffUserId, NOTIFICATION_TYPES.CERT_VERIFIED)
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].entityId).toBe(cert.id);
    });

    it("throws if not pending", async () => {
      const cert = await submit();
      await certService.updateStatus(cert.id, orgId, "verified", adminUserId);

      await expect(
        certService.updateStatus(cert.id, orgId, "rejected", adminUserId, {
          rejectionReason: "other",
        })
      ).rejects.toThrow("Can only verify or reject pending");
    });

    it("throws if cert not found", async () => {
      await expect(
        certService.updateStatus("nonexistent", orgId, "verified", adminUserId)
      ).rejects.toThrow("Certification not found");
    });
  });

  describe("updateStatus — reject", () => {
    it("requires a reason", async () => {
      const cert = await submit();

      await expect(
        certService.updateStatus(cert.id, orgId, "rejected", adminUserId)
      ).rejects.toThrow("A reason is required");
    });

    it("stores the reason and notes", async () => {
      const cert = await submit();

      const rejected = await certService.updateStatus(
        cert.id,
        orgId,
        "rejected",
        adminUserId,
        {
          rejectionReason: "document_unreadable",
          rejectionNotes: "Please upload a clearer scan.",
        }
      );

      expect(rejected.status).toBe("rejected");
      expect(rejected.rejectionReason).toBe("document_unreadable");
      expect(rejected.rejectionNotes).toBe("Please upload a clearer scan.");
    });

    it("tells the holder why", async () => {
      const cert = await submit();
      await certService.updateStatus(cert.id, orgId, "rejected", adminUserId, {
        rejectionReason: "certificate_expired",
        rejectionNotes: "Lapsed in 2024.",
      });
      // Polled rather than slept — the notify call is fire-and-forget,
      // so a fixed pause is a guess about how fast the machine is.
      const notes = await eventuallyAtLeast(() =>
        notificationsFor(staffUserId, NOTIFICATION_TYPES.CERT_REJECTED)
      );
      expect(notes).toHaveLength(1);
      // The readable label, not the enum value — the employee has to act on it.
      expect(notes[0].message).toContain("Certificate expired");
      expect(notes[0].message).toContain("Lapsed in 2024.");
    });
  });

  describe("revoke", () => {
    it("moves a verified certification to revoked, keeping the record", async () => {
      const cert = await verifiedCert();

      const revoked = await certService.revoke(cert.id, orgId, adminUserId, {
        rejectionReason: "not_recognised",
        rejectionNotes: "Issuer is not accepted here.",
      });

      expect(revoked.status).toBe("revoked");
      expect(revoked.rejectionReason).toBe("not_recognised");

      // Still retrievable — revocation is not a delete.
      expect(await certService.getById(cert.id, orgId)).not.toBeNull();
    });

    it("stops counting toward eligibility immediately", async () => {
      const cert = await verifiedCert();
      expect(await certService.getValidCertifications(membershipId)).toHaveLength(1);

      await certService.revoke(cert.id, orgId, adminUserId, {
        rejectionReason: "not_recognised",
      });

      expect(await certService.getValidCertifications(membershipId)).toHaveLength(0);
    });

    it("refuses to revoke something that was never verified", async () => {
      const cert = await submit();

      await expect(
        certService.revoke(cert.id, orgId, adminUserId, {
          rejectionReason: "other",
        })
      ).rejects.toThrow("Can only revoke a verified certification");
    });

    it("refuses to revoke twice", async () => {
      const cert = await verifiedCert();
      await certService.revoke(cert.id, orgId, adminUserId, {
        rejectionReason: "other",
      });

      await expect(
        certService.revoke(cert.id, orgId, adminUserId, {
          rejectionReason: "other",
        })
      ).rejects.toThrow("Can only revoke a verified certification");
    });

    it("notifies the holder that they have lost eligibility", async () => {
      const cert = await verifiedCert();
      await certService.revoke(cert.id, orgId, adminUserId, {
        rejectionReason: "not_recognised",
      });
      // Polled rather than slept — the notify call is fire-and-forget,
      // so a fixed pause is a guess about how fast the machine is.
      const notes = await eventuallyAtLeast(() =>
        notificationsFor(staffUserId, NOTIFICATION_TYPES.CERT_REJECTED)
      );
      expect(notes.some((n) => n.title === "Certification revoked")).toBe(true);
    });
  });

  describe("delete — withdraw", () => {
    it("lets the owner withdraw their own pending submission", async () => {
      const cert = await submit();

      await certService.delete(cert.id, orgId, membershipId, staffUserId);

      expect(await certService.getById(cert.id, orgId)).toBeNull();
    });

    it("refuses to delete another member's certification", async () => {
      const cert = await submit();

      // Previously ANY member of the org could delete ANY colleague's
      // certification, silently changing who was eligible for work.
      await expect(
        certService.delete(cert.id, orgId, adminMembershipId, adminUserId)
      ).rejects.toThrow("Not authorized");

      expect(await certService.getById(cert.id, orgId)).not.toBeNull();
    });

    it("refuses to delete a verified certification, even for its owner", async () => {
      const cert = await verifiedCert();

      await expect(
        certService.delete(cert.id, orgId, membershipId, staffUserId)
      ).rejects.toThrow("Only a pending certification can be withdrawn");
    });

    it("refuses to delete a rejected certification", async () => {
      const cert = await submit();
      await certService.updateStatus(cert.id, orgId, "rejected", adminUserId, {
        rejectionReason: "other",
      });

      await expect(
        certService.delete(cert.id, orgId, membershipId, staffUserId)
      ).rejects.toThrow("Only a pending certification can be withdrawn");
    });

    it("throws if not found", async () => {
      await expect(
        certService.delete("nonexistent", orgId, membershipId, staffUserId)
      ).rejects.toThrow("Certification not found");
    });
  });

  describe("getByOrganization", () => {
    it("returns all certs for an org", async () => {
      await submit("Food Safety");
      await submit("First Aid");

      expect(await certService.getByOrganization(orgId)).toHaveLength(2);
    });
  });

  describe("getValidCertifications", () => {
    it("returns only verified non-expired certs", async () => {
      await verifiedCert("Food Safety", 365);
      await submit("First Aid"); // pending — must not count

      const valid = await certService.getValidCertifications(membershipId);
      expect(valid).toHaveLength(1);
      expect(valid[0].name).toBe("Food Safety");
    });
  });

  describe("getExpiringSoon", () => {
    it("returns verified certs lapsing inside the warning window", async () => {
      await verifiedCert("Soon", 5);
      await verifiedCert("Later", EXPIRY_WARNING_DAYS + 30);

      const expiring = await certService.getExpiringSoon(orgId);

      expect(expiring.map((c) => c.name)).toEqual(["Soon"]);
    });

    it("honours a custom window", async () => {
      await verifiedCert("In 10 days", 10);

      expect(await certService.getExpiringSoon(orgId, 5)).toHaveLength(0);
      expect(await certService.getExpiringSoon(orgId, 20)).toHaveLength(1);
    });
  });

  describe("notifyExpiring", () => {
    /*
     * Seven days, because that is one of `EXPIRY_NOTIFY_DAYS`.
     *
     * These fixtures used ten, which worked only while EVERY day inside the
     * 30-day window sent a notification — which is precisely the bug: a
     * certificate entering the window produced about thirty messages. The scan
     * is quiet between the marks now, so a fixture has to sit on one.
     */
    it("warns the holder once per certificate", async () => {
      const cert = await verifiedCert("First Aid", 7);

      const result = await certService.notifyExpiring(orgId);

      expect(result.checked).toBe(1);
      expect(result.notified).toBe(1);

      const notes = await notificationsFor(
        staffUserId,
        NOTIFICATION_TYPES.CERT_EXPIRING
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].entityId).toBe(cert.id);
      expect(notes[0].message).toContain("First Aid");
    });

    it("is idempotent within the day, so extra cron runs are harmless", async () => {
      await verifiedCert("First Aid", 7);

      await certService.notifyExpiring(orgId);
      const second = await certService.notifyExpiring(orgId);

      expect(second.checked).toBe(1);
      expect(second.notified).toBe(0);
      expect(
        await notificationsFor(staffUserId, NOTIFICATION_TYPES.CERT_EXPIRING)
      ).toHaveLength(1);
    });

    it("says nothing when nothing is lapsing", async () => {
      await verifiedCert("Ages away", EXPIRY_WARNING_DAYS + 60);

      const result = await certService.notifyExpiring(orgId);

      expect(result).toEqual({ checked: 0, notified: 0 });
    });

    it("respects the organisation's notification preference", async () => {
      await verifiedCert("First Aid", 7);
      await prisma.companySettings.upsert({
        where: { organizationId: orgId },
        create: {
          organizationId: orgId,
          notificationPreferences: JSON.stringify({
            certificationExpiry: false,
          }),
        },
        update: {
          notificationPreferences: JSON.stringify({
            certificationExpiry: false,
          }),
        },
      });

      await certService.notifyExpiring(orgId);

      expect(
        await notificationsFor(staffUserId, NOTIFICATION_TYPES.CERT_EXPIRING)
      ).toHaveLength(0);
    });
  });

  describe("tenant scoping", () => {
    it("cannot act on a certification from another organisation", async () => {
      const cert = await submit();

      const otherOrg = await orgRepo.create(
        { name: "Other Org", slug: "other-org" },
        adminUserId
      );

      await expect(
        certService.updateStatus(cert.id, otherOrg.id, "verified", adminUserId)
      ).rejects.toThrow("Certification not found");

      expect(await certService.getById(cert.id, otherOrg.id)).toBeNull();
    });
  });
});
