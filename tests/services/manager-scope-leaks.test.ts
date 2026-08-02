/**
 * Department scoping on the surfaces that were missing it.
 *
 * Tenant isolation between organisations was never in doubt — every route
 * resolves membership before touching data. The gap was one level down: three
 * admin/manager surfaces accepted a manager and then answered org-wide,
 * ignoring the departments that manager is actually responsible for.
 *
 * That is not a cosmetic difference. The data involved is staff names, hours
 * worked, task titles and per-person rejection history, and in the PDF case it
 * left the building as a downloadable file.
 *
 * Each test here names one thing a scoped manager must NOT be able to see.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReportingService } from "@/services/reporting.service";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { PdfReportService } from "@/services/pdf-report.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const reporting = new ReportingService();
const aiDashboard = new AIDashboardService();

let tenant: Tenant;
/** The department the manager is NOT in. */
let foreignDept: string;
let foreignStaffId: string;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("scope");

  const dept = await prisma.department.create({
    data: { name: "Front of house", organizationId: tenant.orgId, color: "#3B82F6" },
  });
  foreignDept = dept.id;

  // Someone in the other department, whose name must not reach our manager.
  const user = await prisma.user.create({
    data: {
      name: "Nadia Other-Department",
      email: "nadia-foreign@example.com",
      hashedPassword: "hash",
    },
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: tenant.orgId,
      role: "staff",
      status: "active",
      employmentType: "casual",
    },
  });
  await prisma.departmentMembership.create({
    data: { membershipId: membership.id, departmentId: foreignDept },
  });
  foreignStaffId = membership.id;
});

/** A task in the OTHER department, with a recognisable title. */
async function foreignTask(title = "Rooftop bar — Saturday") {
  return prisma.task.create({
    data: {
      title,
      organizationId: tenant.orgId,
      departmentId: foreignDept,
      createdById: tenant.admin.userId,
      requiredHeadcount: 3,
      status: "open",
    },
  });
}

/** The manager's own scope, as the routes compute it. */
const OWN_SCOPE = () => [tenant.departmentId];

/* ------------------------------------------------------------------ */

describe("getDepartmentWorkload", () => {
  it("hides departments the manager does not run", async () => {
    // The repository always supported a scope; the service dropped it on the
    // floor, so this returned every department in the organisation.
    const scoped = await reporting.getDepartmentWorkload(tenant.orgId, OWN_SCOPE());

    expect(scoped.map((d) => d.id)).toEqual([tenant.departmentId]);
  });

  it("still shows everything to a company admin", async () => {
    const all = await reporting.getDepartmentWorkload(tenant.orgId);
    expect(all.length).toBe(2);
  });

  it("shows nothing to a manager who runs no departments", async () => {
    // An empty scope must mean "nothing", not "everything" — the failure mode
    // where a scope of [] is read as unrestricted is the classic version of
    // this bug.
    const none = await reporting.getDepartmentWorkload(tenant.orgId, []);
    expect(none).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("AI dashboard data", () => {
  async function insightsFor(scope: string[] | null) {
    // No API keys in the test environment, so this exercises the algorithmic
    // path — which is the one that formats names and titles into strings, and
    // therefore the one where a leak would actually appear.
    return aiDashboard.generateInsights(tenant.orgId, scope);
  }

  it("does not name another department's understaffed task", async () => {
    const task = await foreignTask();
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: foreignStaffId,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    const scoped = await insightsFor(OWN_SCOPE());
    const text = JSON.stringify(scoped);

    expect(text).not.toContain("Rooftop bar");
  });

  it("does not name a staff member from another department", async () => {
    const task = await foreignTask();
    const clockOut = new Date();
    const clockIn = new Date(clockOut.getTime() - 9 * 60 * 60 * 1000);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: foreignStaffId,
        assignedById: tenant.admin.userId,
        status: "completed",
        clockInTime: clockIn,
        clockOutTime: clockOut,
      },
    });

    const scoped = await insightsFor(OWN_SCOPE());

    expect(JSON.stringify(scoped)).not.toContain("Nadia Other-Department");
  });

  it("does not report another department's rejection pattern", async () => {
    // Rejections are fetched org-wide and grouped by staff; the grouping now
    // drops anyone outside the caller's scope.
    for (let i = 0; i < 3; i++) {
      const task = await foreignTask(`Foreign shift ${i}`);
      await prisma.taskAssignment.create({
        data: {
          taskId: task.id,
          membershipId: foreignStaffId,
          assignedById: tenant.admin.userId,
          status: "rejected",
          rejectionReason: "schedule_conflict",
        },
      });
    }

    const scoped = await insightsFor(OWN_SCOPE());

    expect(scoped.rejectionPatterns.map((p) => p.staffName)).not.toContain(
      "Nadia Other-Department"
    );
  });

  it("a company admin still sees the whole organisation", async () => {
    // The guard against over-correcting: scoping must not blind the admin.
    const task = await foreignTask();
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: foreignStaffId,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    const unscoped = await insightsFor(null);

    expect(JSON.stringify(unscoped)).toContain("Rooftop bar");
  });

  it("recommendations are scoped the same way", async () => {
    const task = await foreignTask();
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: foreignStaffId,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    const scoped = await aiDashboard.generateRecommendations(
      tenant.orgId,
      OWN_SCOPE()
    );

    expect(JSON.stringify(scoped)).not.toContain("Rooftop bar");
  });
});

/* ------------------------------------------------------------------ */

describe("PDF export", () => {
  it("passes the caller's scope through to the data it renders", async () => {
    // The PDF is the highest-consequence surface of the three: it is durable,
    // downloadable and shareable. Asserting on the gathered data rather than
    // the rendered bytes, because the bytes are a compressed binary and the
    // question is what went into them.
    const service = new PdfReportService();
    const spy = vi.spyOn(
      ReportingService.prototype,
      "getStaffUtilization"
    );

    try {
      await service.generateReport(tenant.orgId, "Org", OWN_SCOPE());
      expect(spy).toHaveBeenCalledWith(tenant.orgId, [tenant.departmentId]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a company admin's null scope reaches the service as unrestricted", async () => {
    const service = new PdfReportService();
    const spy = vi.spyOn(ReportingService.prototype, "getStaffUtilization");

    try {
      await service.generateReport(tenant.orgId, "Org", null);
      expect(spy).toHaveBeenCalledWith(tenant.orgId, undefined);
    } finally {
      spy.mockRestore();
    }
  });

  it("omits another department's staff from the utilisation figures", async () => {
    const task = await foreignTask();
    const clockOut = new Date();
    const clockIn = new Date(clockOut.getTime() - 6 * 60 * 60 * 1000);
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: foreignStaffId,
        assignedById: tenant.admin.userId,
        status: "completed",
        clockInTime: clockIn,
        clockOutTime: clockOut,
      },
    });

    const scoped = await reporting.getStaffUtilization(tenant.orgId, OWN_SCOPE());

    expect(scoped.map((s) => s.name)).not.toContain("Nadia Other-Department");
  });
});
