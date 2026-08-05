/**
 * The endpoints a scoped manager could reach past their own departments.
 *
 * Department scoping is applied consistently across the reporting and task
 * surfaces, which is what made these four stand out: each is MANAGER by
 * default, each sits beside a scoped sibling, and none consulted the caller's
 * departments.
 *
 *   GET  /members/seniority              every member's level, org-wide, while
 *                                        `GET /members` next door is scoped
 *   PATCH /members/[id]/seniority        pin anyone's level — and seniority
 *                                        feeds composition rules, so it changes
 *                                        who satisfies staffing constraints on
 *                                        shifts in departments they do not run
 *   POST /members/[id]/request-availability
 *                                        send a nudge, signed with their own
 *                                        name, to anyone in the organisation
 *   POST /recurring-tasks/generate       materialise every series in the org,
 *                                        spending the plan's task headroom
 *
 * Out of scope is reported as "not found" throughout, matching the convention
 * `CertificationService` uses: a manager must not be able to probe for members
 * outside their own departments.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SeniorityService } from "@/services/seniority.service";
import { AvailabilityService } from "@/services/availability.service";
import { RecurringTaskService } from "@/services/recurring-task.service";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor } from "@/lib/department-scope";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { sgt } from "../helpers/time";

const seniority = new SeniorityService();
const availability = new AvailabilityService();
const recurring = new RecurringTaskService();
const access = new AccessService();

let tenant: Tenant;
let otherDept: { id: string };
/** A member of a department the fixture manager does NOT hold. */
let outsider: { id: string; userId: string };

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("scopegap");

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
  outsider = { id: membership.id, userId: user.id };
});

/** The fixture manager's scope, as the routes compute it. */
async function managerScope() {
  const membership = await access.getMembership(tenant.manager.userId, tenant.orgId);
  return departmentScopeFor(membership!);
}

describe("seniority is read within the caller's departments", () => {
  it("omits a member of another department", async () => {
    const assessments = await seniority.assessOrganisation(
      tenant.orgId,
      await managerScope()
    );
    expect(assessments[outsider.id]).toBeUndefined();
  });

  it("includes a member of the caller's own department", async () => {
    const assessments = await seniority.assessOrganisation(
      tenant.orgId,
      await managerScope()
    );
    expect(assessments[tenant.staff.membershipId]).toBeDefined();
  });

  it("gives a company admin the whole organisation", async () => {
    const adminMembership = await access.getMembership(
      tenant.admin.userId,
      tenant.orgId
    );
    const assessments = await seniority.assessOrganisation(
      tenant.orgId,
      departmentScopeFor(adminMembership!)
    );
    expect(assessments[outsider.id]).toBeDefined();
  });

  // Empty means "no departments", never "all".
  it("gives a manager with no departments nothing", async () => {
    const assessments = await seniority.assessOrganisation(tenant.orgId, []);
    expect(Object.keys(assessments)).toHaveLength(0);
  });
});

describe("seniority cannot be pinned outside the caller's departments", () => {
  it("refuses a member of another department", async () => {
    await expect(
      seniority.setOverrideForUser(
        tenant.orgId,
        outsider.userId,
        "senior",
        tenant.manager.userId,
        await managerScope()
      )
    ).rejects.toThrow("Member not found");
  });

  it("still allows a member of the caller's own department", async () => {
    const updated = await seniority.setOverrideForUser(
      tenant.orgId,
      tenant.staff.userId,
      "senior",
      tenant.manager.userId,
      await managerScope()
    );
    expect(updated).toBeDefined();
  });

  it("gives the same answer as a member who does not exist", async () => {
    const scope = await managerScope();
    const forOutsider = await seniority
      .setOverrideForUser(tenant.orgId, outsider.userId, "senior", tenant.manager.userId, scope)
      .catch((e: Error) => e.message);
    const forFake = await seniority
      .setOverrideForUser(tenant.orgId, "nobody", "senior", tenant.manager.userId, scope)
      .catch((e: Error) => e.message);
    expect(forOutsider).toBe(forFake);
  });
});

describe("an availability nudge stays inside the caller's departments", () => {
  /*
   * The notification is signed with the sender's name, so without a scope any
   * manager could send what looks like a personal request to every member of
   * the organisation.
   */
  it("refuses a member of another department", async () => {
    await expect(
      availability.requestAvailabilityReview(
        tenant.orgId,
        outsider.userId,
        "A Manager",
        tenant.manager.userId,
        await managerScope()
      )
    ).rejects.toThrow("Member not found");
  });

  it("still reaches a member of the caller's own department", async () => {
    await availability.requestAvailabilityReview(
      tenant.orgId,
      tenant.staff.userId,
      "A Manager",
      tenant.manager.userId,
      await managerScope()
    );

    const sent = await prisma.notification.findMany({
      where: { type: "availability_review_requested" },
    });
    expect(sent).toHaveLength(1);
  });
});

describe("recurring generation stays inside the caller's departments", () => {
  async function recurringSeries(departmentId: string, title: string) {
    return prisma.task.create({
      data: {
        title,
        organizationId: tenant.orgId,
        departmentId,
        createdById: tenant.admin.userId,
        requiredHeadcount: 1,
        status: "open",
        isRecurring: true,
        recurringPattern: JSON.stringify({ freq: "weekly", interval: 1 }),
        scheduledStart: sgt("2026-09-07T09:00"),
        scheduledEnd: sgt("2026-09-07T17:00"),
      },
    });
  }

  it("expands only the series in the caller's departments", async () => {
    await recurringSeries(tenant.departmentId, "Ours");
    await recurringSeries(otherDept.id, "Theirs");

    const result = await recurring.generateForOrganization(
      tenant.orgId,
      14,
      tenant.manager.userId,
      await managerScope()
    );

    expect(result.seriesProcessed).toBe(1);

    const generated = await prisma.task.findMany({
      where: { organizationId: tenant.orgId, parentTaskId: { not: null } },
      select: { title: true },
    });
    expect(generated.every((t) => t.title === "Ours")).toBe(true);
  });

  /*
   * The cron job and the create-a-recurring-task path pass no scope, which is
   * correct: neither has a caller whose departments could limit them. Pinned so
   * the new parameter cannot silently turn the scheduled run into a no-op.
   */
  it("expands everything when no scope is given", async () => {
    await recurringSeries(tenant.departmentId, "Ours");
    await recurringSeries(otherDept.id, "Theirs");

    const result = await recurring.generateForOrganization(tenant.orgId, 14);
    expect(result.seriesProcessed).toBe(2);
  });

  it("expands nothing for a manager with no departments", async () => {
    await recurringSeries(tenant.departmentId, "Ours");

    const result = await recurring.generateForOrganization(
      tenant.orgId,
      14,
      tenant.manager.userId,
      []
    );
    expect(result.seriesProcessed).toBe(0);
  });
});
