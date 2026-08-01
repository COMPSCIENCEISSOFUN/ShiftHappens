/**
 * Tests for manager department scoping (Control layer).
 *
 * - TaskService.getByOrganization limits results to a department scope.
 * - UserManagementService.getOrgMembers limits members to a department scope.
 * - EligibilityService only considers staff in the task's department when the
 *   task has one (PRD §7.4), which also scopes what a manager can allocate.
 *
 * A null scope means "unrestricted" (company admin). An array scopes to those
 * departments. Two departments (Kitchen, Bar) with staff in each are used.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskService } from "@/services/task.service";
import { UserManagementService } from "@/services/user-management.service";
import { EligibilityService } from "@/services/eligibility.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const taskService = new TaskService();
const userMgmtService = new UserManagementService();
const eligibilityService = new EligibilityService();
const orgRepo = new OrganizationRepository();
const deptRepo = new DepartmentRepository();
const userRepo = new UserRepository();

let orgId: string;
let adminUserId: string;
let kitchenId: string;
let barId: string;
let kitchenStaffMembershipId: string;
let barStaffMembershipId: string;
let emailCounter = 0;

/** Creates an active staff member optionally assigned to a department. */
async function makeStaff(name: string, departmentId?: string) {
  const user = await userRepo.create({
    name,
    email: `staff-${emailCounter++}@example.com`,
    hashedPassword: "hash",
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: orgId,
      role: "staff",
      status: "active",
      employmentType: "casual",
    },
  });
  if (departmentId) {
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId },
    });
  }
  return membership.id;
}

beforeEach(async () => {
  await cleanDatabase();
  emailCounter = 0;

  const admin = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create({ name: "Acme", slug: "acme" }, admin.id);
  orgId = org.id;

  await prisma.companySettings.create({
    data: { organizationId: orgId, breakRuleHoursWorked: 100 },
  });

  kitchenId = (await deptRepo.create({ name: "Kitchen", organizationId: orgId })).id;
  barId = (await deptRepo.create({ name: "Bar", organizationId: orgId })).id;

  kitchenStaffMembershipId = await makeStaff("Kitchen Staff", kitchenId);
  barStaffMembershipId = await makeStaff("Bar Staff", barId);
});

describe("TaskService.getByOrganization — department scope", () => {
  beforeEach(async () => {
    await taskService.create({ title: "Kitchen task", departmentId: kitchenId }, orgId, adminUserId);
    await taskService.create({ title: "Bar task", departmentId: barId }, orgId, adminUserId);
    await taskService.create({ title: "General task" }, orgId, adminUserId); // no dept
  });

  it("returns every task when scope is null (admin)", async () => {
    const tasks = await taskService.getByOrganization(orgId, undefined, null);
    expect(tasks).toHaveLength(3);
  });

  it("returns only Kitchen tasks for a Kitchen-scoped manager", async () => {
    const tasks = await taskService.getByOrganization(orgId, undefined, [kitchenId]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Kitchen task");
  });

  it("returns nothing for a manager with an empty scope", async () => {
    const tasks = await taskService.getByOrganization(orgId, undefined, []);
    expect(tasks).toHaveLength(0);
  });
});

describe("UserManagementService.getOrgMembers — department scope", () => {
  it("returns all members when scope is null (admin)", async () => {
    const members = await userMgmtService.getOrgMembers(orgId, null);
    // admin + kitchen staff + bar staff
    expect(members.length).toBe(3);
  });

  it("returns only Kitchen members for a Kitchen-scoped manager", async () => {
    const members = await userMgmtService.getOrgMembers(orgId, [kitchenId]);
    const ids = members.map((m) => m.id);
    expect(ids).toContain(kitchenStaffMembershipId);
    expect(ids).not.toContain(barStaffMembershipId);
  });
});

describe("EligibilityService — task department scopes the candidate pool", () => {
  it("only considers staff in the task's department", async () => {
    const task = await taskService.create(
      { title: "Kitchen shift", departmentId: kitchenId },
      orgId,
      adminUserId
    );

    const results = await eligibilityService.checkEligibilityForTask(task.id, orgId);
    const ids = results.map((r) => r.membershipId);

    expect(ids).toContain(kitchenStaffMembershipId);
    expect(ids).not.toContain(barStaffMembershipId);
  });

  it("considers all staff when the task has no department", async () => {
    const task = await taskService.create({ title: "General shift" }, orgId, adminUserId);

    const results = await eligibilityService.checkEligibilityForTask(task.id, orgId);
    const ids = results.map((r) => r.membershipId);

    expect(ids).toContain(kitchenStaffMembershipId);
    expect(ids).toContain(barStaffMembershipId);
  });
});
