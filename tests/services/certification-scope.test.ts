/**
 * Deciding a certification is a department-scoped action.
 *
 * The LISTING endpoint was scoped from the start — a manager's review queue
 * shows only their own departments' staff. The three endpoints that ACT on a
 * single record were not, and a certification id is not a secret: they come
 * back in dashboard and eligibility payloads.
 *
 * So a manager scoped to Kitchen could read, verify or revoke a Front-of-House
 * member's certification. Revoking is the sharp end — certifications are a hard
 * constraint in the eligibility engine, so it silently changes who another
 * department can roster.
 *
 * Out of scope is reported as "not found" rather than "forbidden", so a manager
 * cannot probe for the existence of another department's records.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CertificationService } from "@/services/certification.service";
import { departmentScopeFor } from "@/lib/department-scope";
import { AccessService } from "@/services/access.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const certService = new CertificationService();
const access = new AccessService();

let tenant: Tenant;
let otherDept: { id: string };
/** A staff member in a department the fixture manager does NOT hold. */
let outsiderMembershipId: string;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("certscope");

  otherDept = await prisma.department.create({
    data: { name: "Front of House", organizationId: tenant.orgId, color: "#22C55E" },
  });

  const user = await prisma.user.create({
    data: {
      name: "Other Dept Staff",
      email: `foh-${Date.now()}@example.com`,
      hashedPassword: "hash",
    },
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: tenant.orgId,
      role: "staff",
      status: "active",
      departmentMemberships: { create: { departmentId: otherDept.id } },
    },
  });
  outsiderMembershipId = membership.id;
});

async function certFor(membershipId: string, status = "pending") {
  return prisma.certification.create({
    data: {
      membershipId,
      name: "Food Safety",
      issuedDate: new Date("2026-01-01"),
      status,
    },
  });
}

/** The fixture manager's scope, as the routes compute it. */
async function managerScope() {
  const membership = await access.getMembership(tenant.manager.userId, tenant.orgId);
  return departmentScopeFor(membership!);
}

/** A company admin's scope — null, meaning unrestricted. */
async function adminScope() {
  const membership = await access.getMembership(tenant.admin.userId, tenant.orgId);
  return departmentScopeFor(membership!);
}

describe("a scoped manager and another department's certification", () => {
  it("cannot read it", async () => {
    const cert = await certFor(outsiderMembershipId);

    const found = await certService.getById(cert.id, tenant.orgId, await managerScope());
    expect(found).toBeNull();
  });

  it("cannot verify it", async () => {
    const cert = await certFor(outsiderMembershipId);

    await expect(
      certService.updateStatus(
        cert.id,
        tenant.orgId,
        "verified",
        tenant.manager.userId,
        undefined,
        await managerScope()
      )
    ).rejects.toThrow("Certification not found");
  });

  it("cannot revoke it", async () => {
    const cert = await certFor(outsiderMembershipId, "verified");

    await expect(
      certService.revoke(
        cert.id,
        tenant.orgId,
        tenant.manager.userId,
        { rejectionReason: "expired" },
        await managerScope()
      )
    ).rejects.toThrow("Certification not found");
  });

  // Reported as missing, not as forbidden — the two must be indistinguishable,
  // or the endpoint becomes a way to enumerate other departments' records.
  it("reports the same error as a certification that does not exist", async () => {
    const real = await certFor(outsiderMembershipId);
    const scope = await managerScope();

    const forReal = await certService
      .updateStatus(real.id, tenant.orgId, "verified", tenant.manager.userId, undefined, scope)
      .catch((e: Error) => e.message);
    const forFake = await certService
      .updateStatus("nonexistent", tenant.orgId, "verified", tenant.manager.userId, undefined, scope)
      .catch((e: Error) => e.message);

    expect(forReal).toBe(forFake);
  });
});

describe("the manager's own department is unaffected", () => {
  it("can verify a certification in their own department", async () => {
    const cert = await certFor(tenant.staff.membershipId);

    const updated = await certService.updateStatus(
      cert.id,
      tenant.orgId,
      "verified",
      tenant.manager.userId,
      undefined,
      await managerScope()
    );
    expect(updated.status).toBe("verified");
  });

  it("can read one in their own department", async () => {
    const cert = await certFor(tenant.staff.membershipId);
    const found = await certService.getById(cert.id, tenant.orgId, await managerScope());
    expect(found?.id).toBe(cert.id);
  });
});

describe("a company admin is unscoped", () => {
  it("reaches every department", async () => {
    const cert = await certFor(outsiderMembershipId);

    const updated = await certService.updateStatus(
      cert.id,
      tenant.orgId,
      "verified",
      tenant.admin.userId,
      undefined,
      await adminScope()
    );
    expect(updated.status).toBe("verified");
  });
});

describe("scope shapes that are easy to get backwards", () => {
  /*
   * An empty array is "no departments", never "all departments". Getting that
   * round the wrong way is the difference between a manager seeing nothing and
   * a manager seeing the whole organisation.
   */
  it("treats an empty scope as no access", async () => {
    const cert = await certFor(tenant.staff.membershipId);
    expect(await certService.getById(cert.id, tenant.orgId, [])).toBeNull();
  });

  it("treats an omitted scope as unrestricted", async () => {
    const cert = await certFor(outsiderMembershipId);
    expect(await certService.getById(cert.id, tenant.orgId)).not.toBeNull();
  });

  // A member in BOTH departments is reachable from either — the scope is a
  // union, and holding one of someone's departments is enough.
  it("reaches a member who is in the manager's department as well as another", async () => {
    await prisma.departmentMembership.create({
      data: {
        membershipId: outsiderMembershipId,
        departmentId: tenant.departmentId,
      },
    });
    const cert = await certFor(outsiderMembershipId);

    expect(
      await certService.getById(cert.id, tenant.orgId, await managerScope())
    ).not.toBeNull();
  });
});

describe("certification alerts stay inside the manager's scope", () => {
  /*
   * `getNeedsAttention` scoped six of its eight sources and left the two
   * certification queries org-wide. Those items carry a staff NAME in their
   * message and become priority-call candidates — so a scoped manager's prompt
   * was carrying other departments' people to Groq or Gemini. Exactly the leak
   * `gatherDashboardData` was fixed for, left open on the newer path.
   */
  it("does not surface another department's expiring certification", async () => {
    const { ReportingService } = await import("@/services/reporting.service");
    const reporting = new ReportingService();

    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    await prisma.certification.create({
      data: {
        membershipId: outsiderMembershipId,
        name: "Secret FOH Cert",
        issuedDate: new Date("2026-01-01"),
        expiryDate: soon,
        status: "verified",
      },
    });

    const items = await reporting.getNeedsAttention(
      tenant.orgId,
      (await managerScope()) ?? undefined
    );

    expect(JSON.stringify(items)).not.toContain("Secret FOH Cert");
  });

  /*
   * The pending-verification alert is a COUNT, not a name, so a leak here does
   * not show as a stray string — it shows as a manager being told to review
   * certifications they cannot see. Asserted on the number.
   */
  it("does not count another department's pending verification", async () => {
    const { ReportingService } = await import("@/services/reporting.service");
    const reporting = new ReportingService();

    await prisma.certification.create({
      data: {
        membershipId: outsiderMembershipId,
        name: "Secret Pending Cert",
        issuedDate: new Date("2026-01-01"),
        status: "pending",
      },
    });

    const items = await reporting.getNeedsAttention(
      tenant.orgId,
      (await managerScope()) ?? undefined
    );

    expect(items.find((i) => i.type === "pending_verification")).toBeUndefined();
  });

  it("still counts one from the manager's own department", async () => {
    const { ReportingService } = await import("@/services/reporting.service");
    const reporting = new ReportingService();

    await prisma.certification.create({
      data: {
        membershipId: tenant.staff.membershipId,
        name: "Own Dept Cert",
        issuedDate: new Date("2026-01-01"),
        status: "pending",
      },
    });

    const items = await reporting.getNeedsAttention(
      tenant.orgId,
      (await managerScope()) ?? undefined
    );

    expect(items.find((i) => i.type === "pending_verification")).toBeDefined();
  });

  it("still surfaces an expiring one from the manager's own department", async () => {
    const { ReportingService } = await import("@/services/reporting.service");
    const reporting = new ReportingService();

    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    await prisma.certification.create({
      data: {
        membershipId: tenant.staff.membershipId,
        name: "Own Dept Expiring",
        issuedDate: new Date("2026-01-01"),
        expiryDate: soon,
        status: "verified",
      },
    });

    const items = await reporting.getNeedsAttention(
      tenant.orgId,
      (await managerScope()) ?? undefined
    );

    expect(JSON.stringify(items)).toContain("Own Dept Expiring");
  });
});
