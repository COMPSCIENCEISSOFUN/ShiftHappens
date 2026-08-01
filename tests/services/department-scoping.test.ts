/**
 * Tests for manager department scoping (Control layer).
 *
 * - TaskService.getByOrganization limits results to a department scope.
 * - UserManagementService.getOrgMembers limits members to a department scope.
 * - EligibilityService only considers staff in the task's department when the
 *   task has one (PRD §7.4), which also scopes what a manager can allocate.
 * - CertificationService.getByOrganization, ReportingService (calendar staff,
 *   calendar coverage, dashboard reports) and HourAlertService.getOrganizationStatus
 *   do the same. Those five read the whole organisation until a scope is passed,
 *   and their routes did not pass one — a manager assigned to Kitchen could read
 *   Bar's certifications, roster, availability, utilisation and worked hours.
 *
 * A null scope means "unrestricted" (company admin). An array scopes to those
 * departments. Two departments (Kitchen, Bar) with staff in each are used.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TaskService } from "@/services/task.service";
import { UserManagementService } from "@/services/user-management.service";
import { EligibilityService } from "@/services/eligibility.service";
import { CertificationService } from "@/services/certification.service";
import { ReportingService } from "@/services/reporting.service";
import { HourAlertService } from "@/services/hour-alert.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { DepartmentRepository } from "@/repositories/department.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";

const taskService = new TaskService();
const userMgmtService = new UserManagementService();
const eligibilityService = new EligibilityService();
const certService = new CertificationService();
const reportingService = new ReportingService();
const hourAlertService = new HourAlertService();
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
      employmentType: "full_time",
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

/**
 * Certifications carry medical and identity details about a named person. The
 * certifications route read them org-wide for anyone who passed the
 * admin-or-manager gate, so a Kitchen manager could read Bar's.
 */
describe("CertificationService.getByOrganization — department scope", () => {
  beforeEach(async () => {
    const noDeptMembershipId = await makeStaff("Floating Staff");
    await certService.create(kitchenStaffMembershipId, {
      name: "Food Safety",
      issuedDate: "2026-01-01T00:00:00.000Z",
    });
    await certService.create(barStaffMembershipId, {
      name: "Bar Licence",
      issuedDate: "2026-01-01T00:00:00.000Z",
    });
    await certService.create(noDeptMembershipId, {
      name: "Floating Cert",
      issuedDate: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns every certification when scope is null (admin)", async () => {
    const certs = await certService.getByOrganization(orgId, undefined, null);
    expect(certs).toHaveLength(3);
  });

  it("returns every certification when no scope is passed at all", async () => {
    // undefined and null must mean the same thing, or a caller that simply
    // omits the argument would silently see nothing.
    const certs = await certService.getByOrganization(orgId);
    expect(certs).toHaveLength(3);
  });

  it("returns only Kitchen certifications for a Kitchen-scoped manager", async () => {
    const certs = await certService.getByOrganization(orgId, undefined, [kitchenId]);
    expect(certs).toHaveLength(1);
    expect(certs[0].name).toBe("Food Safety");
  });

  it("hides a member who belongs to no department from a scoped manager", async () => {
    // Same rule as isDepartmentInScope: a resource with no department belongs
    // to the organisation, and only an admin sees organisation-wide things.
    const certs = await certService.getByOrganization(orgId, undefined, [kitchenId, barId]);
    expect(certs.map((c) => c.name)).not.toContain("Floating Cert");
  });

  it("returns nothing for a manager with an empty scope", async () => {
    // A manager in no department supervises nobody. An empty array must not
    // degrade to "unrestricted".
    const certs = await certService.getByOrganization(orgId, undefined, []);
    expect(certs).toHaveLength(0);
  });

  it("applies the status filter and the scope together", async () => {
    const certs = await certService.getByOrganization(orgId, "pending", [kitchenId]);
    expect(certs).toHaveLength(1);
    expect(certs[0].name).toBe("Food Safety");

    expect(
      await certService.getByOrganization(orgId, "verified", [kitchenId])
    ).toHaveLength(0);
  });
});

describe("ReportingService calendar methods — department scope", () => {
  beforeEach(async () => {
    // Both staff available Monday 09:00–17:00, so any difference in the result
    // comes from the scope and nothing else.
    for (const membershipId of [kitchenStaffMembershipId, barStaffMembershipId]) {
      await prisma.availability.create({
        data: {
          membershipId,
          dayOfWeek: 1,
          startTime: "09:00",
          endTime: "17:00",
          isAvailable: true,
        },
      });
    }
  });

  it("getAllStaffSchedules returns both staff when scope is null (admin)", async () => {
    const staff = await reportingService.getAllStaffSchedules(orgId, null);
    expect(staff).toHaveLength(2);
  });

  it("getAllStaffSchedules returns only Kitchen staff for a Kitchen-scoped manager", async () => {
    const staff = await reportingService.getAllStaffSchedules(orgId, [kitchenId]);
    expect(staff.map((s) => s.membershipId)).toEqual([kitchenStaffMembershipId]);
  });

  it("getAllStaffSchedules returns nothing for an empty scope", async () => {
    expect(await reportingService.getAllStaffSchedules(orgId, [])).toHaveLength(0);
  });

  it("getCalendarCoverage counts both staff when scope is null (admin)", async () => {
    const coverage = await reportingService.getCalendarCoverage(orgId, null);
    const monday10 = coverage.find((c) => c.dayOfWeek === 1 && c.hour === 10);
    expect(monday10?.count).toBe(2);
  });

  it("getCalendarCoverage counts only Kitchen staff for a Kitchen-scoped manager", async () => {
    // The parameter existed here before this fix but was never read, so this
    // returned 2 — the whole organisation's coverage — for a scoped manager.
    const coverage = await reportingService.getCalendarCoverage(orgId, [kitchenId]);
    const monday10 = coverage.find((c) => c.dayOfWeek === 1 && c.hour === 10);
    expect(monday10?.count).toBe(1);
  });

  it("getCalendarCoverage still returns a full matrix of zeros for an empty scope", async () => {
    // The 0-items case: the heatmap must render as empty, not break.
    const coverage = await reportingService.getCalendarCoverage(orgId, []);
    expect(coverage).toHaveLength(7 * 24);
    expect(coverage.every((c) => c.count === 0)).toBe(true);
  });
});

describe("ReportingService.getDashboardReports — department scope", () => {
  it("covers every staff member and department when scope is null (admin)", async () => {
    const reports = await reportingService.getDashboardReports(orgId, null);
    expect(reports.staffUtilization).toHaveLength(2);
    expect(reports.departmentWorkload.map((d) => d.name).sort()).toEqual([
      "Bar",
      "Kitchen",
    ]);
  });

  it("covers only Kitchen for a Kitchen-scoped manager", async () => {
    const reports = await reportingService.getDashboardReports(orgId, [kitchenId]);
    expect(reports.staffUtilization.map((s) => s.name)).toEqual(["Kitchen Staff"]);
    expect(reports.departmentWorkload.map((d) => d.name)).toEqual(["Kitchen"]);
  });

  it("returns empty sections for a manager with an empty scope", async () => {
    // Short-circuited in the service: the shared repository helpers test
    // `departmentIds?.length`, which would read [] as unrestricted.
    const reports = await reportingService.getDashboardReports(orgId, []);
    expect(reports.staffUtilization).toEqual([]);
    expect(reports.departmentWorkload).toEqual([]);
    expect(reports.completionTrend).toEqual([]);
    expect(reports.hoursSummary).toEqual({
      totalLogged: 0,
      totalCapacity: 0,
      percentage: 0,
    });
  });
});

describe("HourAlertService.getOrganizationStatus — department scope", () => {
  it("reports on every non-admin member when scope is null", async () => {
    const statuses = await hourAlertService.getOrganizationStatus(orgId, null);
    expect(statuses.map((s) => s.membershipId).sort()).toEqual(
      [kitchenStaffMembershipId, barStaffMembershipId].sort()
    );
  });

  it("reports only on Kitchen staff for a Kitchen-scoped manager", async () => {
    // Worked hours are personal data; a Bar manager has no reason to see them.
    const statuses = await hourAlertService.getOrganizationStatus(orgId, [kitchenId]);
    expect(statuses.map((s) => s.membershipId)).toEqual([kitchenStaffMembershipId]);
  });

  it("excludes a member who belongs to no department from a scoped view", async () => {
    await makeStaff("Floating Staff");
    const statuses = await hourAlertService.getOrganizationStatus(orgId, [
      kitchenId,
      barId,
    ]);
    expect(statuses).toHaveLength(2);
  });

  it("reports on nobody for a manager with an empty scope", async () => {
    expect(await hourAlertService.getOrganizationStatus(orgId, [])).toHaveLength(0);
  });

  it("checkOrganization carries the scope into the scan", async () => {
    // The POST endpoint sends notifications; an unscoped scan would let a
    // Kitchen manager alert on Bar's staff.
    const result = await hourAlertService.checkOrganization(orgId, [kitchenId]);
    expect(result.checked).toBe(1);
  });
});

/**
 * An EMPTY department scope must mean "sees nothing", never "sees everything".
 *
 * `reporting.repository.ts` guarded twelve queries with `departmentIds?.length`,
 * which is falsy for `[]` — so the filter was skipped entirely and a manager
 * belonging to no department was handed the whole organisation. That is the
 * opposite of what an empty scope means, and it is the exact shape of an
 * accidental privilege escalation: the person with the least access gets the
 * most.
 *
 * `TaskService.getByOrganization` always distinguished the two, so this brings
 * the reporting layer into line with the convention the rest of the code uses.
 */
describe("Empty department scope means nothing, not everything", () => {
  it("a manager in no department sees no report data", async () => {
    const reports = await reportingService.getDashboardReports(orgId, []);

    expect(reports.staffUtilization).toHaveLength(0);
  });

  it("a manager in no department sees no calendar coverage", async () => {
    const coverage = await reportingService.getCalendarCoverage(orgId, []);

    // The grid shape is fixed (7 days x 24 hours) regardless of scope — what an
    // empty scope must zero out is the counts inside it, not the matrix itself.
    const total = coverage.reduce((sum, cell) => sum + cell.count, 0);
    expect(total).toBe(0);
  });

  it("a manager in no department sees no staff schedules", async () => {
    const schedules = await reportingService.getAllStaffSchedules(orgId, []);

    expect(schedules).toHaveLength(0);
  });

  it("an admin (null scope) still sees everything", async () => {
    // The positive control. Null and [] must not be conflated in either
    // direction — tightening [] would be worthless if it also broke null.
    const reports = await reportingService.getDashboardReports(orgId, null);

    expect(reports.staffUtilization.length).toBeGreaterThan(0);
  });

  it("an omitted scope still means unrestricted", async () => {
    const reports = await reportingService.getDashboardReports(orgId);

    expect(reports.staffUtilization.length).toBeGreaterThan(0);
  });
});
