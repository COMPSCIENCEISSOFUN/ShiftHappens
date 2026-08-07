// @vitest-environment node
/**
 * Boundary-layer authorisation gaps that the manifest sweep cannot express.
 *
 * `contract.test.ts` drives the declared table: it proves that every route
 * marked `suspension: true` refuses a suspended organisation. Two things are
 * still missing, and they are the two that make the gate meaningful rather
 * than merely present:
 *
 *   1. The POSITIVE CONTROL. A route that returns 403 unconditionally would
 *      satisfy the sweep. Each newly guarded handler is therefore also called
 *      against an ACTIVE org and expected to do its job.
 *
 *   2. The ONE DELIBERATE EXEMPTION. clock-out is the only assignment action
 *      that does not refuse a suspended org — see the comment on its route —
 *      and an exemption nobody tests is indistinguishable from an oversight.
 *
 * The department-scope half asserts what a scoped MANAGER gets back from the
 * five reporting/calendar/certification endpoints, end to end through the
 * route. The service-level equivalents live in
 * tests/services/department-scoping.test.ts; what is verified here is that the
 * routes actually pass `departmentScopeFor(membership)` down, which is exactly
 * what they failed to do.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { POST as generateRecurring } from "@/app/api/organizations/[orgId]/recurring-tasks/generate/route";
import {
  GET as getHourAlerts,
  POST as postHourAlerts,
} from "@/app/api/organizations/[orgId]/hour-alerts/route";
import {
  GET as getCertifications,
  POST as postCertification,
} from "@/app/api/organizations/[orgId]/certifications/route";
import { PUT as putAvailability } from "@/app/api/organizations/[orgId]/availability/route";
import { POST as postOverride } from "@/app/api/organizations/[orgId]/availability/overrides/route";
import { GET as getCalendarStaff } from "@/app/api/organizations/[orgId]/calendar/staff/route";
import { GET as getCalendarCoverage } from "@/app/api/organizations/[orgId]/calendar/coverage/route";
import { GET as getReports } from "@/app/api/organizations/[orgId]/reports/route";
import { POST as acceptAssignment } from "@/app/api/assignments/[assignmentId]/accept/route";
import { POST as clockInAssignment } from "@/app/api/assignments/[assignmentId]/clock-in/route";
import { POST as clockOutAssignment } from "@/app/api/assignments/[assignmentId]/clock-out/route";
import { POST as completeAssignment } from "@/app/api/assignments/[assignmentId]/complete/route";

import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import {
  createTenant,
  createTask,
  suspendOrg,
  type Tenant,
} from "../helpers/fixtures";
import { asUser } from "../helpers/session";
import { ctx, req, jsonReq, bodyOf } from "../helpers/route";

let tenant: Tenant;

/** Assigns the tenant's staff member to a task, in the given lifecycle state. */
async function assignStaff(
  status: string,
  extra: { clockInTime?: Date } = {}
) {
  const task = await createTask(tenant);
  return prisma.taskAssignment.create({
    data: {
      taskId: task.id,
      membershipId: tenant.staff.membershipId,
      assignedById: tenant.admin.userId,
      status,
      ...extra,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("authz");
  vi.clearAllMocks();
});

// ── Task 1: suspension ────────────────────────────────────────────────────

describe("newly guarded routes still work on an ACTIVE organisation", () => {
  // Without these, a handler that returned 403 to everyone would pass the
  // suspension sweep in contract.test.ts and look correct.

  it("POST recurring-tasks/generate succeeds", async () => {
    asUser(tenant.admin.userId);
    const res = await generateRecurring(
      jsonReq("POST", {}),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(200);
    // 0 series is the honest empty-state answer, not a failure.
    expect((await bodyOf(res)).seriesProcessed).toBe(0);
  });

  it("POST hour-alerts succeeds", async () => {
    asUser(tenant.admin.userId);
    const res = await postHourAlerts(
      jsonReq("POST", {}),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(200);
  });

  it("POST certifications succeeds", async () => {
    asUser(tenant.staff.userId);
    const res = await postCertification(
      jsonReq("POST", {
        name: "Food Safety Level 2",
        issuedDate: "2026-01-15T00:00:00.000Z",
      }),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(201);
  });

  it("PUT availability succeeds", async () => {
    asUser(tenant.staff.userId);
    const res = await putAvailability(
      jsonReq("PUT", {
        schedule: [
          { dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isAvailable: true },
        ],
      }),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(200);
  });

  it("POST availability/overrides succeeds", async () => {
    asUser(tenant.staff.userId);
    const res = await postOverride(
      jsonReq("POST", {
        // Relative, not a literal. This was "2026-08-01", which sat in the
        // future when it was written and quietly became the past — the route
        // now refuses back-dated overrides, so a fixed date here is a test
        // with an expiry date on it.
        date: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        isAvailable: false,
        reason: "Medical appointment",
      }),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(201);
  });

  it("POST assignments/accept succeeds", async () => {
    const assignment = await assignStaff("pending");
    asUser(tenant.staff.userId);
    const res = await acceptAssignment(
      jsonReq("POST", {}, "/api/test", { orgId: tenant.orgId }),
      ctx({ assignmentId: assignment.id })
    );
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).status).toBe("accepted");
  });
});

describe("clock-out is deliberately exempt from the suspension gate", () => {
  /**
   * The reasoning, so a future reader does not "fix" the inconsistency:
   * clocking out is the only assignment action that merely ENDS work already
   * under way. A member reaches it only once they are clocked in, and refusing
   * it would strand them mid-shift with the hours they actually worked never
   * recorded. Suspension is a billing state; it must not eat someone's pay.
   */
  it("lets a clocked-in member clock out of a SUSPENDED organisation", async () => {
    const assignment = await assignStaff("accepted", {
      clockInTime: new Date(Date.now() - 60 * 60 * 1000),
    });
    await suspendOrg(tenant.orgId);

    asUser(tenant.staff.userId);
    const res = await clockOutAssignment(
      jsonReq("POST", {}, "/api/test", { orgId: tenant.orgId }),
      ctx({ assignmentId: assignment.id })
    );

    expect(res.status).toBe(200);
    expect((await bodyOf(res)).clockOutTime).not.toBeNull();
  });

  it("still refuses clock-IN on a suspended organisation", async () => {
    // The exemption is one action wide. Starting new work stays blocked.
    const assignment = await assignStaff("accepted");
    await suspendOrg(tenant.orgId);

    asUser(tenant.staff.userId);
    const res = await clockInAssignment(
      jsonReq("POST", {}, "/api/test", { orgId: tenant.orgId }),
      ctx({ assignmentId: assignment.id })
    );

    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error).toBe("Organization is suspended");
  });

  it("still refuses complete on a suspended organisation", async () => {
    // So the assignment rests at "clocked_out" until the org is reactivated —
    // the suspension bites, it just does not trap anyone.
    const assignment = await assignStaff("clocked_out", {
      clockInTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    await suspendOrg(tenant.orgId);

    asUser(tenant.staff.userId);
    const res = await completeAssignment(
      jsonReq("POST", {}, "/api/test", { orgId: tenant.orgId }),
      ctx({ assignmentId: assignment.id })
    );

    expect(res.status).toBe(403);
  });
});

// ── Task 2: manager department scope, asserted through the route ──────────

describe("manager department scope is applied by the reporting routes", () => {
  /**
   * `tenant.manager` belongs to the tenant's one department. A second
   * department with its own staff member is added here: the manager must not
   * see it, the admin must.
   */
  let otherDeptId: string;
  let otherStaffMembershipId: string;

  beforeEach(async () => {
    const otherDept = await prisma.department.create({
      data: { name: "Bar", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    otherDeptId = otherDept.id;

    const otherUser = await prisma.user.create({
      data: {
        name: "Bar Staff",
        email: `bar-staff-${tenant.orgSlug}@example.com`,
        hashedPassword: "hash",
      },
    });
    const otherMembership = await prisma.membership.create({
      data: {
        userId: otherUser.id,
        organizationId: tenant.orgId,
        role: "staff",
        status: "active",
        employmentType: "casual",
      },
    });
    otherStaffMembershipId = otherMembership.id;
    await prisma.departmentMembership.create({
      data: { membershipId: otherMembership.id, departmentId: otherDeptId },
    });

    // Both staff available Monday 09:00–17:00, so the only difference between
    // the admin's answer and the manager's is the scope.
    for (const membershipId of [
      tenant.staff.membershipId,
      otherStaffMembershipId,
    ]) {
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

  it("GET certifications: admin sees both departments, manager sees one", async () => {
    for (const membershipId of [
      tenant.staff.membershipId,
      otherStaffMembershipId,
    ]) {
      await prisma.certification.create({
        data: {
          membershipId,
          name: "Food Safety",
          issuedDate: new Date("2026-01-01"),
        },
      });
    }

    asUser(tenant.admin.userId);
    const adminRes = await getCertifications(req(), ctx({ orgId: tenant.orgId }));
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toHaveLength(2);

    asUser(tenant.manager.userId);
    const managerRes = await getCertifications(req(), ctx({ orgId: tenant.orgId }));
    expect(managerRes.status).toBe(200);
    const managerCerts = (await managerRes.json()) as { membershipId: string }[];
    expect(managerCerts).toHaveLength(1);
    expect(managerCerts[0].membershipId).toBe(tenant.staff.membershipId);
  });

  it("GET calendar/staff: admin sees the whole roster, manager sees theirs", async () => {
    asUser(tenant.admin.userId);
    const adminRes = await getCalendarStaff(req(), ctx({ orgId: tenant.orgId }));
    const adminStaff = (await adminRes.json()) as { membershipId: string }[];
    expect(adminStaff.map((s) => s.membershipId).sort()).toEqual(
      [tenant.staff.membershipId, otherStaffMembershipId].sort()
    );

    asUser(tenant.manager.userId);
    const managerRes = await getCalendarStaff(req(), ctx({ orgId: tenant.orgId }));
    const managerStaff = (await managerRes.json()) as { membershipId: string }[];
    expect(managerStaff.map((s) => s.membershipId)).toEqual([
      tenant.staff.membershipId,
    ]);
  });

  it("GET calendar/coverage: the manager's heatmap counts only their department", async () => {
    type Cell = { dayOfWeek: number; hour: number; count: number };
    const monday10 = (cells: Cell[]) =>
      cells.find((c) => c.dayOfWeek === 1 && c.hour === 10)?.count;

    asUser(tenant.admin.userId);
    const adminRes = await getCalendarCoverage(req(), ctx({ orgId: tenant.orgId }));
    expect(monday10((await adminRes.json()) as Cell[])).toBe(2);

    asUser(tenant.manager.userId);
    const managerRes = await getCalendarCoverage(req(), ctx({ orgId: tenant.orgId }));
    expect(monday10((await managerRes.json()) as Cell[])).toBe(1);
  });

  it("GET reports: the manager's utilisation and workload cover only their department", async () => {
    type Reports = {
      staffUtilization: { name: string }[];
      departmentWorkload: { name: string }[];
    };

    asUser(tenant.admin.userId);
    const adminRes = await getReports(req(), ctx({ orgId: tenant.orgId }));
    const adminReports = (await adminRes.json()) as Reports;
    // Both departments, and every active staff/manager member.
    expect(adminReports.departmentWorkload).toHaveLength(2);
    expect(adminReports.staffUtilization.length).toBeGreaterThan(1);

    asUser(tenant.manager.userId);
    const managerRes = await getReports(req(), ctx({ orgId: tenant.orgId }));
    const managerReports = (await managerRes.json()) as Reports;
    expect(managerReports.departmentWorkload).toHaveLength(1);
    expect(managerReports.departmentWorkload[0].name).not.toBe("Bar");
    expect(managerReports.staffUtilization.map((s) => s.name)).not.toContain(
      "Bar Staff"
    );
  });

  it("GET hour-alerts: the manager sees worked-hour status only for their department", async () => {
    type Status = { membershipId: string };

    asUser(tenant.admin.userId);
    const adminRes = await getHourAlerts(req(), ctx({ orgId: tenant.orgId }));
    const adminIds = ((await adminRes.json()) as Status[]).map(
      (s) => s.membershipId
    );
    expect(adminIds).toContain(otherStaffMembershipId);
    expect(adminIds).toContain(tenant.staff.membershipId);

    asUser(tenant.manager.userId);
    const managerRes = await getHourAlerts(req(), ctx({ orgId: tenant.orgId }));
    const managerIds = ((await managerRes.json()) as Status[]).map(
      (s) => s.membershipId
    );
    expect(managerIds).not.toContain(otherStaffMembershipId);
    expect(managerIds).toContain(tenant.staff.membershipId);
  });

  it("a manager who belongs to NO department sees nothing, not everything", async () => {
    // The 0-items edge. An empty scope must not degrade to "unrestricted" —
    // that is the exact shape of the bug being fixed, one step further along.
    await prisma.departmentMembership.deleteMany({
      where: { membershipId: tenant.manager.membershipId },
    });

    asUser(tenant.manager.userId);

    const staffRes = await getCalendarStaff(req(), ctx({ orgId: tenant.orgId }));
    expect(await staffRes.json()).toHaveLength(0);

    const certRes = await getCertifications(req(), ctx({ orgId: tenant.orgId }));
    expect(await certRes.json()).toHaveLength(0);

    const alertRes = await getHourAlerts(req(), ctx({ orgId: tenant.orgId }));
    expect(await alertRes.json()).toHaveLength(0);

    const reportRes = await getReports(req(), ctx({ orgId: tenant.orgId }));
    const reports = (await reportRes.json()) as {
      staffUtilization: unknown[];
      departmentWorkload: unknown[];
    };
    expect(reports.staffUtilization).toEqual([]);
    expect(reports.departmentWorkload).toEqual([]);
  });

  it("POST hour-alerts scans only the manager's department", async () => {
    // The scan sends notifications; an unscoped one would let a manager alert
    // staff in departments they do not supervise.
    asUser(tenant.admin.userId);
    const adminRes = await postHourAlerts(
      jsonReq("POST", {}),
      ctx({ orgId: tenant.orgId })
    );
    // Every active non-admin member: the manager, their staff, and Bar Staff.
    expect((await bodyOf(adminRes)).checked).toBe(3);

    asUser(tenant.manager.userId);
    const res = await postHourAlerts(
      jsonReq("POST", {}),
      ctx({ orgId: tenant.orgId })
    );
    expect(res.status).toBe(200);
    // The manager and their own department's staff — Bar Staff is not scanned.
    expect((await bodyOf(res)).checked).toBe(2);
  });
});
