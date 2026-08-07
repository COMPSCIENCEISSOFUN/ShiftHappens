/**
 * Tests for the certification dimension of the Eligibility engine.
 *
 * A task can declare `requiredCertifications` (by name). A staff member is
 * eligible on this dimension only if they hold ALL required certifications
 * as verified, non-expired records. Managers can waive it with an override.
 *
 * Tasks here are created WITHOUT a schedule so the availability/scheduling/
 * work-rule dimensions all pass — isolating the certification check.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EligibilityService } from "@/services/eligibility.service";
import { TaskRepository } from "@/repositories/task.repository";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const eligibilityService = new EligibilityService();
const taskRepo = new TaskRepository();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let adminUserId: string;
let staffMembershipId: string;

beforeEach(async () => {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Admin User",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create({ name: "Acme Corp", slug: "acme-corp" }, admin.id);
  orgId = org.id;

  const staff = await userRepo.create({
    name: "Staff User",
    email: "staff@example.com",
    hashedPassword: "hash",
  });
  const membership = await prisma.membership.create({
    data: {
      userId: staff.id,
      organizationId: org.id,
      role: "staff",
      status: "active",
      employmentType: "casual", // skip availability entirely
    },
  });
  staffMembershipId = membership.id;

  await prisma.companySettings.create({
    data: { organizationId: org.id, breakRuleHoursWorked: 8 },
  });
});

/** Adds a certification for the staff member with the given status/expiry. */
async function addCert(
  name: string,
  opts: { status?: string; expiryDate?: Date | null } = {}
) {
  return prisma.certification.create({
    data: {
      membershipId: staffMembershipId,
      name,
      issuedDate: new Date("2026-01-01T00:00:00.000Z"),
      expiryDate: opts.expiryDate ?? null,
      status: opts.status ?? "verified",
      verifiedById: adminUserId,
      verifiedAt: new Date(),
    },
  });
}

function certCheckFor(results: Awaited<ReturnType<EligibilityService["checkEligibilityForTask"]>>) {
  return results.find((r) => r.membershipId === staffMembershipId)!;
}

describe("EligibilityService — certifications", () => {
  it("passes when the task requires no certifications", async () => {
    const task = await taskRepo.create({
      title: "No cert task",
      organizationId: orgId,
      createdById: adminUserId,
      requiredCertifications: [],
    });

    const staff = certCheckFor(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.certifications.eligible).toBe(true);
    expect(staff.eligible).toBe(true);
  });

  it("blocks staff missing a required certification", async () => {
    const task = await taskRepo.create({
      title: "Food prep",
      organizationId: orgId,
      createdById: adminUserId,
      requiredCertifications: ["Food Safety"],
    });

    const staff = certCheckFor(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.certifications.eligible).toBe(false);
    expect(staff.checks.certifications.reason).toContain("Food Safety");
    expect(staff.eligible).toBe(false);
  });

  it("allows staff holding a verified, non-expired required certification", async () => {
    await addCert("Food Safety");
    const task = await taskRepo.create({
      title: "Food prep",
      organizationId: orgId,
      createdById: adminUserId,
      requiredCertifications: ["Food Safety"],
    });

    const staff = certCheckFor(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.certifications.eligible).toBe(true);
    expect(staff.eligible).toBe(true);
  });

  it("does not count a pending (unverified) certification", async () => {
    await addCert("Food Safety", { status: "pending" });
    const task = await taskRepo.create({
      title: "Food prep",
      organizationId: orgId,
      createdById: adminUserId,
      requiredCertifications: ["Food Safety"],
    });

    const staff = certCheckFor(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.certifications.eligible).toBe(false);
  });

  it("does not count an expired certification", async () => {
    await addCert("Food Safety", { expiryDate: new Date("2020-01-01T00:00:00.000Z") });
    const task = await taskRepo.create({
      title: "Food prep",
      organizationId: orgId,
      createdById: adminUserId,
      requiredCertifications: ["Food Safety"],
    });

    const staff = certCheckFor(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.certifications.eligible).toBe(false);
  });

  it("requires ALL certifications, not just one", async () => {
    await addCert("Food Safety");
    const task = await taskRepo.create({
      title: "Bar + kitchen",
      organizationId: orgId,
      createdById: adminUserId,
      requiredCertifications: ["Food Safety", "RSA Certification"],
    });

    const staff = certCheckFor(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.certifications.eligible).toBe(false);
    expect(staff.checks.certifications.reason).toContain("RSA Certification");
    expect(staff.checks.certifications.reason).not.toContain("Food Safety");
  });

  it("matches certification names case-insensitively", async () => {
    await addCert("Food Safety");
    const task = await taskRepo.create({
      title: "Food prep",
      organizationId: orgId,
      createdById: adminUserId,
      requiredCertifications: ["  food safety  "],
    });

    const staff = certCheckFor(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.certifications.eligible).toBe(true);
  });

  it("does not permit a missing certification to be overridden", async () => {
    const task = await taskRepo.create({
      title: "Food prep",
      organizationId: orgId,
      createdById: adminUserId,
      requiredCertifications: ["Food Safety"],
    });

    await expect(eligibilityService.createOverride(
      task.id, staffMembershipId, adminUserId,
      "Trainee working under supervision", "certification", orgId
    )).rejects.toThrow("Only availability warnings can be overridden");

    const staff = certCheckFor(await eligibilityService.checkEligibilityForTask(task.id, orgId));
    expect(staff.checks.certifications.eligible).toBe(false);
    expect(staff.eligible).toBe(false);
  });
});
