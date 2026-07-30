/**
 * Tests for Certification Repository (Entity Layer)
 * Verifies certification CRUD, status transitions,
 * and valid certification filtering.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CertificationRepository } from "@/repositories/certification.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const certRepo = new CertificationRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let membershipId: string;
let adminUserId: string;

beforeEach(async () => {
  await cleanDatabase();

  const user = await userRepo.create({
    name: "Staff User",
    email: "staff@example.com",
    hashedPassword: "hash",
  });

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

  const staffMembership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: org.id,
      role: "staff",
      status: "active",
    },
  });
  membershipId = staffMembership.id;
});

describe("CertificationRepository", () => {
  describe("create", () => {
    it("creates a certification", async () => {
      const cert = await certRepo.create({
        membershipId,
        name: "Food Safety Level 2",
        issuedDate: new Date("2026-01-15"),
        expiryDate: new Date("2027-01-15"),
      });

      expect(cert.id).toBeDefined();
      expect(cert.name).toBe("Food Safety Level 2");
      expect(cert.status).toBe("pending");
    });

    it("creates without expiry date", async () => {
      const cert = await certRepo.create({
        membershipId,
        name: "First Aid",
        issuedDate: new Date("2026-01-15"),
      });

      expect(cert.expiryDate).toBeNull();
    });
  });

  describe("findById", () => {
    it("returns cert with membership and user", async () => {
      const cert = await certRepo.create({
        membershipId,
        name: "Food Safety",
        issuedDate: new Date("2026-01-15"),
      });

      const found = await certRepo.findById(cert.id);
      expect(found).not.toBeNull();
      expect(found!.membership.user.name).toBe("Staff User");
    });

    it("returns null for non-existent ID", async () => {
      const found = await certRepo.findById("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("findByMembershipId", () => {
    it("returns all certs for a member", async () => {
      await certRepo.create({
        membershipId,
        name: "Food Safety",
        issuedDate: new Date("2026-01-15"),
      });
      await certRepo.create({
        membershipId,
        name: "First Aid",
        issuedDate: new Date("2026-02-15"),
      });

      const certs = await certRepo.findByMembershipId(membershipId);
      expect(certs).toHaveLength(2);
    });
  });

  describe("findByOrganizationId", () => {
    it("returns all certs for an org", async () => {
      await certRepo.create({
        membershipId,
        name: "Food Safety",
        issuedDate: new Date("2026-01-15"),
      });

      const certs = await certRepo.findByOrganizationId(orgId);
      expect(certs).toHaveLength(1);
    });

    it("filters by status", async () => {
      const cert = await certRepo.create({
        membershipId,
        name: "Food Safety",
        issuedDate: new Date("2026-01-15"),
      });
      await certRepo.updateStatus(cert.id, "verified", adminUserId);

      await certRepo.create({
        membershipId,
        name: "First Aid",
        issuedDate: new Date("2026-02-15"),
      });

      const pending = await certRepo.findByOrganizationId(orgId, "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0].name).toBe("First Aid");
    });
  });

  describe("updateStatus", () => {
    it("verifies a certification", async () => {
      const cert = await certRepo.create({
        membershipId,
        name: "Food Safety",
        issuedDate: new Date("2026-01-15"),
      });

      const verified = await certRepo.updateStatus(cert.id, "verified", adminUserId);
      expect(verified.status).toBe("verified");
      expect(verified.verifiedById).toBe(adminUserId);
      expect(verified.verifiedAt).not.toBeNull();
    });

    it("rejects a certification", async () => {
      const cert = await certRepo.create({
        membershipId,
        name: "Fake Cert",
        issuedDate: new Date("2026-01-15"),
      });

      const rejected = await certRepo.updateStatus(cert.id, "rejected", adminUserId);
      expect(rejected.status).toBe("rejected");
    });
  });

  describe("delete", () => {
    it("deletes a certification", async () => {
      const cert = await certRepo.create({
        membershipId,
        name: "Food Safety",
        issuedDate: new Date("2026-01-15"),
      });

      await certRepo.delete(cert.id);

      const found = await certRepo.findById(cert.id);
      expect(found).toBeNull();
    });
  });

  describe("getValidCertifications", () => {
    it("returns only verified non-expired certs", async () => {
      // Verified, no expiry
      const cert1 = await certRepo.create({
        membershipId,
        name: "First Aid",
        issuedDate: new Date("2026-01-15"),
      });
      await certRepo.updateStatus(cert1.id, "verified", adminUserId);

      // Verified, future expiry
      const cert2 = await certRepo.create({
        membershipId,
        name: "Food Safety",
        issuedDate: new Date("2026-01-15"),
        expiryDate: new Date("2028-01-15"),
      });
      await certRepo.updateStatus(cert2.id, "verified", adminUserId);

      // Verified, expired
      const cert3 = await certRepo.create({
        membershipId,
        name: "Old Cert",
        issuedDate: new Date("2024-01-15"),
        expiryDate: new Date("2025-01-15"),
      });
      await certRepo.updateStatus(cert3.id, "verified", adminUserId);

      // Pending (not verified)
      await certRepo.create({
        membershipId,
        name: "Pending Cert",
        issuedDate: new Date("2026-01-15"),
      });

      const valid = await certRepo.getValidCertifications(membershipId);
      expect(valid).toHaveLength(2);
      expect(valid.map((c) => c.name).sort()).toEqual(["First Aid", "Food Safety"]);
    });
  });

  describe("updateStatus — rejection reasons", () => {
    it("stores the reason and notes on a rejection", async () => {
      const cert = await certRepo.create({
        membershipId,
        name: "Food Safety",
        issuedDate: new Date("2026-01-15"),
      });

      const rejected = await certRepo.updateStatus(
        cert.id,
        "rejected",
        adminUserId,
        {
          rejectionReason: "document_unreadable",
          rejectionNotes: "The photo is too blurry to read the issue date.",
        }
      );

      expect(rejected.status).toBe("rejected");
      expect(rejected.rejectionReason).toBe("document_unreadable");
      expect(rejected.rejectionNotes).toContain("too blurry");
    });

    it("clears a stale reason when a later decision carries none", async () => {
      const cert = await certRepo.create({
        membershipId,
        name: "Food Safety",
        issuedDate: new Date("2026-01-15"),
      });

      await certRepo.updateStatus(cert.id, "rejected", adminUserId, {
        rejectionReason: "details_mismatch",
      });
      // Prisma ignores `undefined`, so the repository writes null explicitly —
      // otherwise a verified certificate would keep the old rejection reason.
      const verified = await certRepo.updateStatus(
        cert.id,
        "verified",
        adminUserId
      );

      expect(verified.status).toBe("verified");
      expect(verified.rejectionReason).toBeNull();
      expect(verified.rejectionNotes).toBeNull();
    });

    it("records a revocation like any other status change", async () => {
      const cert = await certRepo.create({
        membershipId,
        name: "Food Safety",
        issuedDate: new Date("2026-01-15"),
      });
      await certRepo.updateStatus(cert.id, "verified", adminUserId);

      const revoked = await certRepo.updateStatus(
        cert.id,
        "revoked",
        adminUserId,
        { rejectionReason: "not_recognised" }
      );

      expect(revoked.status).toBe("revoked");
      expect(revoked.rejectionReason).toBe("not_recognised");
    });
  });

  describe("findExpiringSoon", () => {
    const DAY = 24 * 60 * 60 * 1000;

    async function verified(name: string, expiryDate: Date | undefined) {
      const cert = await certRepo.create({
        membershipId,
        name,
        issuedDate: new Date("2026-01-01"),
        expiryDate,
      });
      await certRepo.updateStatus(cert.id, "verified", adminUserId);
      return cert;
    }

    it("returns verified certs expiring inside the window, soonest first", async () => {
      const now = new Date();
      await verified("Expires in 5 days", new Date(now.getTime() + 5 * DAY));
      await verified("Expires in 20 days", new Date(now.getTime() + 20 * DAY));
      await verified("Expires in 90 days", new Date(now.getTime() + 90 * DAY));

      const found = await certRepo.findExpiringSoon(
        orgId,
        now,
        new Date(now.getTime() + 30 * DAY)
      );

      expect(found.map((c) => c.name)).toEqual([
        "Expires in 5 days",
        "Expires in 20 days",
      ]);
    });

    it("ignores certs with no expiry date", async () => {
      const now = new Date();
      await verified("Never expires", undefined);

      const found = await certRepo.findExpiringSoon(
        orgId,
        now,
        new Date(now.getTime() + 30 * DAY)
      );
      expect(found).toHaveLength(0);
    });

    it("ignores pending and revoked certs — neither confers anything", async () => {
      const now = new Date();
      const soon = new Date(now.getTime() + 5 * DAY);

      await certRepo.create({
        membershipId,
        name: "Still pending",
        issuedDate: new Date("2026-01-01"),
        expiryDate: soon,
      });

      const revoked = await verified("Revoked", soon);
      await certRepo.updateStatus(revoked.id, "revoked", adminUserId, {
        rejectionReason: "not_recognised",
      });

      const found = await certRepo.findExpiringSoon(
        orgId,
        now,
        new Date(now.getTime() + 30 * DAY)
      );
      expect(found).toHaveLength(0);
    });

    it("ignores already-expired certs — the window starts at `from`", async () => {
      const now = new Date();
      await verified("Expired last week", new Date(now.getTime() - 7 * DAY));

      const found = await certRepo.findExpiringSoon(
        orgId,
        now,
        new Date(now.getTime() + 30 * DAY)
      );
      expect(found).toHaveLength(0);
    });
  });
});
