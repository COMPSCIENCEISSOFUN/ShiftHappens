/**
 * Counts behind the plan limits.
 *
 * Each count has a filter, and each filter is a decision: a deactivated member
 * frees a seat, a completed task stops occupying one, work rules count whether
 * active or not. Getting one wrong either blocks a customer who is within their
 * plan or lets them past it, and neither shows up until someone hits a limit.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SubscriptionRepository } from "@/repositories/subscription.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const repo = new SubscriptionRepository();

let tenant: Tenant;
let other: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("sub");
  other = await createTenant("oth");
});

async function makeTask(status: string) {
  return prisma.task.create({
    data: {
      title: `Task ${status}`,
      status,
      organizationId: tenant.orgId,
      createdById: tenant.admin.userId,
    },
  });
}

describe("getOrganizationTier", () => {
  it("returns the stored tier", async () => {
    // createTenant sets enterprise so feature gates don't interfere.
    await expect(repo.getOrganizationTier(tenant.orgId)).resolves.toBe("enterprise");
  });

  it("reflects an updated tier", async () => {
    await repo.updateOrganizationTier(tenant.orgId, "pro");
    await expect(repo.getOrganizationTier(tenant.orgId)).resolves.toBe("pro");
  });
});

describe("getResourceCounts", () => {
  it("counts only ACTIVE memberships", async () => {
    // createTenant makes four: admin, manager, staff, and one deactivated.
    const counts = await repo.getResourceCounts(tenant.orgId);
    expect(counts.members).toBe(3);
  });

  it("excludes completed and cancelled tasks", async () => {
    await makeTask("open");
    await makeTask("in_progress");
    await makeTask("completed");
    await makeTask("cancelled");

    const counts = await repo.getResourceCounts(tenant.orgId);
    expect(counts.activeTasks).toBe(2);
  });

  it("counts departments", async () => {
    const counts = await repo.getResourceCounts(tenant.orgId);
    expect(counts.departments).toBe(1);
  });

  it("counts work rules whether active or paused", async () => {
    // A paused rule still occupies a slot — you can re-enable it at any time.
    await prisma.workRule.create({
      data: { organizationId: tenant.orgId, name: "On", type: "max_hours_daily", maxHours: 10, isActive: true },
    });
    await prisma.workRule.create({
      data: { organizationId: tenant.orgId, name: "Off", type: "max_hours_weekly", maxHours: 40, isActive: false },
    });

    const counts = await repo.getResourceCounts(tenant.orgId);
    expect(counts.workRules).toBe(2);
  });

  it("counts custom roles but not system roles", async () => {
    await prisma.role.create({
      data: { organizationId: tenant.orgId, name: "shift_lead", displayLabel: "Shift Lead", isSystemRole: false },
    });
    await prisma.role.create({
      data: { organizationId: tenant.orgId, name: "builtin", displayLabel: "Built in", isSystemRole: true },
    });

    const counts = await repo.getResourceCounts(tenant.orgId);
    expect(counts.customRoles).toBe(1);
  });

  it("counts nothing from another organisation", async () => {
    await prisma.task.create({
      data: {
        title: "Their task",
        status: "open",
        organizationId: other.orgId,
        createdById: other.admin.userId,
      },
    });

    const counts = await repo.getResourceCounts(tenant.orgId);
    expect(counts.activeTasks).toBe(0);
  });

  it("returns zeroes for an organisation that does not exist", async () => {
    const counts = await repo.getResourceCounts("no-such-org");
    expect(counts).toEqual({
      members: 0,
      activeTasks: 0,
      departments: 0,
      workRules: 0,
      customRoles: 0,
    });
  });
});

describe("countResource", () => {
  it("agrees with getResourceCounts for every resource", async () => {
    // The two share their filters by copy, not by construction, so they can
    // drift — a limit check would then disagree with the usage display.
    await makeTask("open");
    await makeTask("completed");
    await prisma.workRule.create({
      data: { organizationId: tenant.orgId, name: "Cap", type: "max_hours_daily", maxHours: 10 },
    });
    await prisma.role.create({
      data: { organizationId: tenant.orgId, name: "lead", displayLabel: "Lead", isSystemRole: false },
    });

    const counts = await repo.getResourceCounts(tenant.orgId);

    await expect(repo.countResource(tenant.orgId, "members")).resolves.toBe(counts.members);
    await expect(repo.countResource(tenant.orgId, "active_tasks")).resolves.toBe(counts.activeTasks);
    await expect(repo.countResource(tenant.orgId, "departments")).resolves.toBe(counts.departments);
    await expect(repo.countResource(tenant.orgId, "work_rules")).resolves.toBe(counts.workRules);
    await expect(repo.countResource(tenant.orgId, "custom_roles")).resolves.toBe(counts.customRoles);
  });

  it("excludes deactivated members", async () => {
    await expect(repo.countResource(tenant.orgId, "members")).resolves.toBe(3);
  });

  it("excludes completed tasks", async () => {
    await makeTask("open");
    await makeTask("completed");
    await expect(repo.countResource(tenant.orgId, "active_tasks")).resolves.toBe(1);
  });
});

describe("updateOrganizationTier", () => {
  it("writes the new tier", async () => {
    await repo.updateOrganizationTier(tenant.orgId, "free");
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: tenant.orgId } });
    expect(org.subscriptionTier).toBe("free");
  });

  it("leaves other organisations alone", async () => {
    await repo.updateOrganizationTier(tenant.orgId, "free");
    await expect(repo.getOrganizationTier(other.orgId)).resolves.toBe("enterprise");
  });
});
