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
import { DepartmentService } from "@/services/department.service";
import { AutoScheduleService } from "@/services/auto-schedule.service";
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
const deptService = new DepartmentService();
const autoScheduleService = new AutoScheduleService();
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
      taskAcceptanceMode: "require_acceptance",
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
    const taskA = await taskService.create({ title: "A task" }, orgA.orgId, orgA.adminUserId);

    await expect(
      taskService.assignStaff(taskA.id, orgA.orgId, [orgB.staffMembershipId], orgA.adminUserId)
    ).rejects.toThrow(/does not belong to this organization/);

    // No assignment should have been created.
    const count = await prisma.taskAssignment.count({ where: { taskId: taskA.id } });
    expect(count).toBe(0);
  });

  it("cancelAssignment refuses an assignment in another org", async () => {
    const taskB = await taskService.create({ title: "B task" }, orgB.orgId, orgB.adminUserId);
    const [assignment] = await taskService.assignStaff(
      taskB.id,
      orgB.orgId,
      [orgB.staffMembershipId],
      orgB.adminUserId
    );

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
    const [assignment] = await taskService.assignStaff(
      taskB.id,
      orgB.orgId,
      [orgB.staffMembershipId],
      orgB.adminUserId
    );
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

/**
 * DepartmentService took an `organizationId` on every id-based method and used
 * it only to label the audit row — it never compared it to the department's own
 * organizationId, and DepartmentRepository.findById is a bare findUnique on the
 * primary key. A company admin could therefore read, rename, archive, unarchive
 * or PERMANENTLY DELETE another tenant's department by posting its id to their
 * own org's endpoint. RoleService and WorkRuleService already did this check;
 * DepartmentService was the odd one out.
 */
describe("Tenant isolation — DepartmentService", () => {
  async function deptIn(t: Tenant, name = "Kitchen") {
    return deptService.create({ name, color: "#EF4444" }, t.orgId, t.adminUserId);
  }

  it("getById refuses a department in another org", async () => {
    const deptB = await deptIn(orgB);

    await expect(deptService.getById(deptB.id, orgA.orgId)).rejects.toThrow(
      "Department not found"
    );
  });

  it("reports a cross-tenant id as not-found, not as forbidden", async () => {
    // The distinction matters: "Forbidden" would confirm the id exists, which
    // is itself a disclosure. A caller must not be able to probe for valid ids.
    const deptB = await deptIn(orgB);

    const crossTenant = await deptService
      .getById(deptB.id, orgA.orgId)
      .catch((e: Error) => e.message);
    const nonExistent = await deptService
      .getById("clnonexistentid00000000", orgA.orgId)
      .catch((e: Error) => e.message);

    expect(crossTenant).toBe(nonExistent);
  });

  it("update refuses to rename a department in another org", async () => {
    const deptB = await deptIn(orgB, "Kitchen");

    await expect(
      deptService.update(deptB.id, orgA.orgId, { name: "Pwned" }, orgA.adminUserId)
    ).rejects.toThrow("Department not found");

    const untouched = await prisma.department.findUnique({ where: { id: deptB.id } });
    expect(untouched!.name).toBe("Kitchen");
  });

  it("archive refuses a department in another org", async () => {
    const deptB = await deptIn(orgB);

    await expect(
      deptService.archive(deptB.id, orgA.orgId, orgA.adminUserId)
    ).rejects.toThrow("Department not found");

    const untouched = await prisma.department.findUnique({ where: { id: deptB.id } });
    expect(untouched!.archivedAt).toBeNull();
  });

  it("unarchive refuses a department in another org", async () => {
    const deptB = await deptIn(orgB);
    await deptService.archive(deptB.id, orgB.orgId, orgB.adminUserId);

    await expect(
      deptService.unarchive(deptB.id, orgA.orgId, orgA.adminUserId)
    ).rejects.toThrow("Department not found");

    const stillArchived = await prisma.department.findUnique({ where: { id: deptB.id } });
    expect(stillArchived!.archivedAt).not.toBeNull();
  });

  it("delete refuses to permanently remove another org's department", async () => {
    // The sharpest case: archived + memberless is exactly the state that passes
    // every OTHER guard in delete(), so ownership was the only thing standing
    // between org A and destroying org B's data.
    const deptB = await deptIn(orgB);
    await deptService.archive(deptB.id, orgB.orgId, orgB.adminUserId);

    await expect(
      deptService.delete(deptB.id, orgA.orgId, orgA.adminUserId)
    ).rejects.toThrow("Department not found");

    expect(
      await prisma.department.findUnique({ where: { id: deptB.id } })
    ).not.toBeNull();
  });

  it("getImpactSummary refuses a department in another org", async () => {
    const deptB = await deptIn(orgB);

    await expect(
      deptService.getImpactSummary(deptB.id, orgA.orgId)
    ).rejects.toThrow("Department not found");
  });

  it("still allows every operation within the owning org", async () => {
    // Guard against over-correction: the ownership check must not break the
    // legitimate path it wraps.
    const deptA = await deptIn(orgA, "Front of House");

    expect((await deptService.getById(deptA.id, orgA.orgId)).name).toBe("Front of House");
    expect((await deptService.getImpactSummary(deptA.id, orgA.orgId)).memberCount).toBe(0);

    await deptService.update(deptA.id, orgA.orgId, { name: "FOH" }, orgA.adminUserId);
    await deptService.archive(deptA.id, orgA.orgId, orgA.adminUserId);
    await deptService.unarchive(deptA.id, orgA.orgId, orgA.adminUserId);
    await deptService.archive(deptA.id, orgA.orgId, orgA.adminUserId);
    await deptService.delete(deptA.id, orgA.orgId, orgA.adminUserId);

    expect(await prisma.department.findUnique({ where: { id: deptA.id } })).toBeNull();
  });
});

/**
 * confirmSchedule writes the assignment rows from a draft the CLIENT posts
 * back, so every id in it is caller-supplied. It previously created rows without
 * checking either id against the organisation, and swallowed per-row errors, so
 * a cross-tenant write returned 200 and notified the victim's employee.
 */
describe("Tenant isolation — AutoScheduleService.confirmSchedule", () => {
  it("refuses draft rows whose task or member belongs to another org", async () => {
    const taskB = await taskService.create(
      { title: "B shift", scheduledStart: "2026-08-03T01:00:00.000Z", scheduledEnd: "2026-08-03T09:00:00.000Z" },
      orgB.orgId,
      orgB.adminUserId
    );

    const result = await autoScheduleService.confirmSchedule(
      orgA.orgId,
      [
        {
          taskId: taskB.id,
          taskTitle: "B shift",
          membershipId: orgB.staffMembershipId,
          staffName: "B staff",
          reasoning: "injected",
        },
      ],
      orgA.adminUserId
    );

    expect(result.created).toBe(0);
    expect(result.rejected).toBe(1);
    expect(await prisma.taskAssignment.count({ where: { taskId: taskB.id } })).toBe(0);
    // And no notification reached org B's employee.
    expect(
      await prisma.notification.count({ where: { userId: orgB.staffUserId } })
    ).toBe(0);
  });

  it("refuses a mixed draft row-by-row without dropping the valid ones", async () => {
    const taskA = await taskService.create(
      { title: "A shift", scheduledStart: "2026-08-03T01:00:00.000Z", scheduledEnd: "2026-08-03T09:00:00.000Z" },
      orgA.orgId,
      orgA.adminUserId
    );
    const taskB = await taskService.create(
      { title: "B shift", scheduledStart: "2026-08-03T01:00:00.000Z", scheduledEnd: "2026-08-03T09:00:00.000Z" },
      orgB.orgId,
      orgB.adminUserId
    );

    const result = await autoScheduleService.confirmSchedule(
      orgA.orgId,
      [
        { taskId: taskA.id, taskTitle: "A", membershipId: orgA.staffMembershipId, staffName: "A staff", reasoning: "" },
        { taskId: taskB.id, taskTitle: "B", membershipId: orgB.staffMembershipId, staffName: "B staff", reasoning: "" },
        // Own task, but another tenant's member — the half-valid case.
        { taskId: taskA.id, taskTitle: "A", membershipId: orgB.staffMembershipId, staffName: "B staff", reasoning: "" },
      ],
      orgA.adminUserId
    );

    expect(result.created).toBe(1);
    expect(result.rejected).toBe(2);
    expect(await prisma.taskAssignment.count({ where: { taskId: taskB.id } })).toBe(0);
    expect(await prisma.taskAssignment.count({ where: { taskId: taskA.id } })).toBe(1);
  });

  it("accepts a wholly valid draft unchanged", async () => {
    const taskA = await taskService.create(
      { title: "A shift", scheduledStart: "2026-08-03T01:00:00.000Z", scheduledEnd: "2026-08-03T09:00:00.000Z" },
      orgA.orgId,
      orgA.adminUserId
    );

    const result = await autoScheduleService.confirmSchedule(
      orgA.orgId,
      [{ taskId: taskA.id, taskTitle: "A", membershipId: orgA.staffMembershipId, staffName: "A staff", reasoning: "" }],
      orgA.adminUserId
    );

    expect(result.created).toBe(1);
    expect(result.rejected).toBe(0);
  });

  it("handles an empty draft without querying for ids", async () => {
    const result = await autoScheduleService.confirmSchedule(orgA.orgId, [], orgA.adminUserId);
    expect(result).toMatchObject({ created: 0, rejected: 0 });
  });
});
