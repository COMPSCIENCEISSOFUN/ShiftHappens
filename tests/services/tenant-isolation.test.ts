/**
 * Tenant Isolation Tests (Control Layer) — Cross-tenant IDOR guard.
 *
 * Every org-scoped service method that fetches a sub-resource by ID must
 * verify that the resource belongs to the organization the caller is acting
 * within. These tests set up TWO organizations and assert that a caller
 * scoped to Org A can never read, mutate, or act on Org B's resources by
 * supplying Org B's IDs.
 *
 * Regression guard for the cross-tenant IDOR found in review.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskService } from "@/services/task.service";
import { AllocationService } from "@/services/allocation.service";
import { EligibilityService } from "@/services/eligibility.service";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { RoleService } from "@/services/role.service";
import { CertificationService } from "@/services/certification.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const taskService = new TaskService();
const allocationService = new AllocationService();
const eligibilityService = new EligibilityService();
const assignmentService = new TaskAssignmentService();
const roleService = new RoleService();
const certService = new CertificationService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

interface Tenant {
  orgId: string;
  adminUserId: string;
  adminMembershipId: string;
  staffUserId: string;
  staffMembershipId: string;
}

let emailCounter = 0;

async function createTenant(slug: string): Promise<Tenant> {
  const admin = await userRepo.create({
    name: `Admin ${slug}`,
    email: `admin-${slug}-${emailCounter++}@example.com`,
    hashedPassword: "hash",
  });

  const org = await orgRepo.create({ name: `Org ${slug}`, slug }, admin.id);

  await prisma.organization.update({
    where: { id: org.id },
    data: { subscriptionTier: "pro" },
  });

  await prisma.companySettings.create({
    data: {
      organizationId: org.id,
      allocationMode: "auto",
      breakRuleHoursWorked: 8,
    },
  });

  const adminMembership = await prisma.membership.findFirst({
    where: { organizationId: org.id },
  });

  const staffUser = await userRepo.create({
    name: `Staff ${slug}`,
    email: `staff-${slug}-${emailCounter++}@example.com`,
    hashedPassword: "hash",
  });
  const staffMembership = await prisma.membership.create({
    data: {
      userId: staffUser.id,
      organizationId: org.id,
      role: "staff",
      status: "active",
    },
  });

  return {
    orgId: org.id,
    adminUserId: admin.id,
    adminMembershipId: adminMembership!.id,
    staffUserId: staffUser.id,
    staffMembershipId: staffMembership.id,
  };
}

let orgA: Tenant;
let orgB: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  emailCounter = 0;
  orgA = await createTenant("org-a");
  orgB = await createTenant("org-b");
});

describe("Tenant isolation — TaskService", () => {
  it("getById returns null for a task in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);

    // Own org: visible.
    expect(await taskService.getById(taskB.id, orgB.orgId)).not.toBeNull();
    // Other org: not visible.
    expect(await taskService.getById(taskB.id, orgA.orgId)).toBeNull();
  });

  it("update refuses a task in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);

    await expect(
      taskService.update(taskB.id, orgA.orgId, { title: "hacked" })
    ).rejects.toThrow("Task not found");

    const still = await taskService.getById(taskB.id, orgB.orgId);
    expect(still!.title).toBe("B task");
  });

  it("delete refuses a task in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);

    await expect(
      taskService.delete(taskB.id, orgA.orgId)
    ).rejects.toThrow("Task not found");

    expect(await taskService.getById(taskB.id, orgB.orgId)).not.toBeNull();
  });

  it("assignStaff refuses a task in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);

    await expect(
      taskService.assignStaff(taskB.id, orgA.orgId, [orgA.staffMembershipId], orgA.adminUserId)
    ).rejects.toThrow("Task not found");
  });

  it("assignStaff refuses a membership from another org", async () => {
    const taskA = await taskService.create(
      { title: "A task", requiredHeadcount: 2 },
      orgA.orgId,
      orgA.adminUserId
    );

    await expect(
      taskService.assignStaff(taskA.id, orgA.orgId, [orgB.staffMembershipId], orgA.adminUserId)
    ).rejects.toThrow(/does not belong to this organization/);

    // No assignment should have been created for the other org's membership.
    const count = await prisma.taskAssignment.count({
      where: { taskId: taskA.id, membershipId: orgB.staffMembershipId },
    });
    expect(count).toBe(0);
  });

  it("cancelAssignment refuses an assignment in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);
    const assignment = await prisma.taskAssignment.findFirstOrThrow({
      where: { taskId: taskB.id },
    });

    await expect(
      taskService.cancelAssignment(assignment.id, orgA.orgId, orgA.adminUserId)
    ).rejects.toThrow("Assignment not found");

    const still = await prisma.taskAssignment.findUnique({ where: { id: assignment.id } });
    expect(still).not.toBeNull();
  });
});

describe("Tenant isolation — AllocationService", () => {
  it("getSuggestions refuses a task in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);

    await expect(
      allocationService.getSuggestions(taskB.id, orgA.orgId)
    ).rejects.toThrow("Task not found");
  });

  it("autoAllocate refuses a task in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);

    await expect(
      allocationService.autoAllocate(taskB.id, orgA.orgId, orgA.adminUserId)
    ).rejects.toThrow("Task not found");
  });
});

describe("Tenant isolation — EligibilityService", () => {
  it("checkEligibilityForTask refuses a task in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);

    await expect(
      eligibilityService.checkEligibilityForTask(taskB.id, orgA.orgId)
    ).rejects.toThrow("Task not found");
  });

  it("createOverride refuses a task in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);

    await expect(
      eligibilityService.createOverride(
        taskB.id,
        orgB.staffMembershipId,
        orgA.adminUserId,
        "reason",
        "availability",
        orgA.orgId
      )
    ).rejects.toThrow("Task not found");
  });

  it("createOverride refuses a membership from another org", async () => {
    const taskA = await taskService.create({ title: "A task" }, orgA.orgId, orgA.adminUserId);

    await expect(
      eligibilityService.createOverride(
        taskA.id,
        orgB.staffMembershipId,
        orgA.adminUserId,
        "reason",
        "availability",
        orgA.orgId
      )
    ).rejects.toThrow(/does not belong to this organization/);
  });
});

describe("Tenant isolation — TaskAssignmentService", () => {
  it("resolveWithdrawal refuses an assignment in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);
    const assignment = await prisma.taskAssignment.findFirstOrThrow({
      where: { taskId: taskB.id },
    });
    await prisma.taskAssignment.update({
      where: { id: assignment.id },
      data: { status: "withdrawal_requested", withdrawalReason: "need off" },
    });

    await expect(
      assignmentService.resolveWithdrawal(assignment.id, "approve", orgA.adminUserId, orgA.orgId)
    ).rejects.toThrow("Assignment not found");

    const still = await prisma.taskAssignment.findUnique({ where: { id: assignment.id } });
    expect(still!.status).toBe("withdrawal_requested");
  });
});

describe("Tenant isolation — RoleService", () => {
  async function makeRole(tenant: Tenant, name: string) {
    const permissions = await prisma.permission.findMany({ take: 2 });
    return roleService.create(
      { name, displayLabel: name, permissionIds: permissions.map((p) => p.id) },
      tenant.orgId,
      tenant.adminUserId
    );
  }

  it("getById returns null for a role in another org", async () => {
    const roleB = await makeRole(orgB, "shift_lead_b");

    expect(await roleService.getById(roleB.id, orgB.orgId)).not.toBeNull();
    expect(await roleService.getById(roleB.id, orgA.orgId)).toBeNull();
  });

  it("update refuses a role in another org", async () => {
    const roleB = await makeRole(orgB, "shift_lead_b");

    await expect(
      roleService.update(roleB.id, orgA.orgId, { displayLabel: "hacked" }, orgA.adminUserId)
    ).rejects.toThrow("Role not found");
  });

  it("delete refuses a role in another org", async () => {
    const roleB = await makeRole(orgB, "shift_lead_b");

    await expect(
      roleService.delete(roleB.id, orgA.orgId, orgA.adminUserId)
    ).rejects.toThrow("Role not found");

    expect(await roleService.getById(roleB.id, orgB.orgId)).not.toBeNull();
  });
});

describe("Tenant isolation — CertificationService", () => {
  async function makeCert(tenant: Tenant) {
    return certService.create(tenant.staffMembershipId, {
      name: "Food Safety",
      issuedDate: "2026-01-15T00:00:00.000Z",
    });
  }

  it("getById returns null for a cert in another org", async () => {
    const certB = await makeCert(orgB);

    expect(await certService.getById(certB.id, orgB.orgId)).not.toBeNull();
    expect(await certService.getById(certB.id, orgA.orgId)).toBeNull();
  });

  it("updateStatus refuses a cert in another org", async () => {
    const certB = await makeCert(orgB);

    await expect(
      certService.updateStatus(certB.id, orgA.orgId, "verified", orgA.adminUserId)
    ).rejects.toThrow("Certification not found");

    const still = await certService.getById(certB.id, orgB.orgId);
    expect(still!.status).toBe("pending");
  });

  it("delete refuses a cert in another org", async () => {
    const certB = await makeCert(orgB);

    // Org A's staff member, acting in org A, against org B's certificate.
    // The org check runs first, so this reports "not found" rather than
    // confirming a certificate exists somewhere they cannot see.
    await expect(
      certService.delete(
        certB.id,
        orgA.orgId,
        orgA.staffMembershipId,
        orgA.staffUserId
      )
    ).rejects.toThrow("Certification not found");

    expect(await certService.getById(certB.id, orgB.orgId)).not.toBeNull();
  });

  it("delete refuses a colleague's cert inside the SAME org", async () => {
    const certB = await makeCert(orgB);

    // Not a tenant boundary — an authorisation one. Before the ownership check
    // existed, any member could delete any colleague's certification, which
    // silently changed who was eligible for work.
    await expect(
      certService.delete(
        certB.id,
        orgB.orgId,
        orgB.adminMembershipId,
        orgB.adminUserId
      )
    ).rejects.toThrow("Not authorized");

    expect(await certService.getById(certB.id, orgB.orgId)).not.toBeNull();
  });
});
