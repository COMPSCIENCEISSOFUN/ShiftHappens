// @vitest-environment node
/**
 * Buying permanent project quota, and keeping a downgraded organisation whole.
 *
 * Projects became a LIFETIME allowance on 2026-08-14: one cannot be archived,
 * and only an empty one can be deleted. Two consequences follow, and this file
 * pins both.
 *
 * The slot purchase is a ONE-OFF charge rather than a recurring item, because
 * what it unlocks is permanent — so the quota it grants has to survive the
 * subscription that was in force when it was bought.
 *
 * The grandfathering exists because an organisation that drops from Enterprise
 * to Pro keeps every project and can shed none of them. Without it, its next
 * slot purchase would go entirely on covering the overage.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SubscriptionService } from "@/services/subscription.service";
import { SubscriptionRepository } from "@/repositories/subscription.repository";
import { ProjectService } from "@/services/project.service";
import { getResourceLimit } from "@/lib/subscription-tiers";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const subscriptions = new SubscriptionService();
const subscriptionRepo = new SubscriptionRepository();
const projects = new ProjectService();

const PRO_PROJECTS = getResourceLimit("pro", "projects") as number;

function makeProject(tenant: Tenant, title: string) {
  return projects.create(
    { title, staffingMode: "task_based", departmentIds: [tenant.departmentId] },
    tenant.orgId,
    tenant.admin.userId
  );
}

/** Creates `count` projects directly, bypassing the limit the service enforces. */
async function seedProjects(tenant: Tenant, count: number) {
  for (let i = 0; i < count; i++) {
    await prisma.project.create({
      data: {
        title: `Seeded ${i + 1}`,
        organizationId: tenant.orgId,
        createdById: tenant.admin.userId,
        staffingMode: "task_based",
      },
    });
  }
}

function quotaOf(orgId: string) {
  return subscriptionRepo.getPlanState(orgId).then((s) => s.projectQuotaAddon);
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("grandfathering an organisation that downgraded over its limit", () => {
  it("records the overage as quota, so nothing is taken away", async () => {
    /*
     * Fifteen projects on a plan that includes ten. They cannot be deleted, so
     * the only honest outcome is that the organisation keeps them.
     */
    const tenant = await createTenant("over", { subscriptionTier: "pro" });
    await seedProjects(tenant, PRO_PROJECTS + 5);

    await subscriptions.grandfatherProjectOverage(tenant.orgId);

    expect(await quotaOf(tenant.orgId)).toBe(5);
  });

  it("leaves them exactly at their limit, not over it", async () => {
    // The point of the arithmetic: after grandfathering, one slot bought is one
    // project gained — the same deal everybody else gets.
    const tenant = await createTenant("over-at", { subscriptionTier: "pro" });
    await seedProjects(tenant, PRO_PROJECTS + 5);

    await subscriptions.grandfatherProjectOverage(tenant.orgId);
    const check = await subscriptions.checkResourceLimit(
      tenant.orgId,
      "projects"
    );

    expect(check.limit).toBe(PRO_PROJECTS + 5);
    expect(check.current).toBe(PRO_PROJECTS + 5);
    expect(check.allowed).toBe(false);
  });

  it("then lets one purchased slot buy exactly one project", async () => {
    const tenant = await createTenant("over-buy", { subscriptionTier: "pro" });
    await seedProjects(tenant, PRO_PROJECTS + 5);
    await subscriptions.grandfatherProjectOverage(tenant.orgId);

    await subscriptionRepo.setProjectQuotaAddon(tenant.orgId, 5 + 1);

    await expect(makeProject(tenant, "Bought")).resolves.toBeDefined();
  });

  it("does nothing when the organisation is within its plan", async () => {
    const tenant = await createTenant("under", { subscriptionTier: "pro" });
    await seedProjects(tenant, 2);

    await subscriptions.grandfatherProjectOverage(tenant.orgId);

    expect(await quotaOf(tenant.orgId)).toBe(0);
  });

  it("does nothing on an unlimited plan", async () => {
    // Nothing can be over a limit that does not exist.
    const tenant = await createTenant("ent-over", {
      subscriptionTier: "enterprise",
    });
    await seedProjects(tenant, 40);

    await subscriptions.grandfatherProjectOverage(tenant.orgId);

    expect(await quotaOf(tenant.orgId)).toBe(0);
  });

  it("never lowers quota that was already bought", async () => {
    /*
     * Somebody who purchased ten slots and then downgraded keeps all ten, even
     * though their overage is smaller. The grant is a floor, not a
     * recalculation — anything else would confiscate something paid for.
     */
    const tenant = await createTenant("keep-bought", {
      subscriptionTier: "pro",
    });
    await subscriptionRepo.setProjectQuotaAddon(tenant.orgId, 10);
    await seedProjects(tenant, PRO_PROJECTS + 2);

    await subscriptions.grandfatherProjectOverage(tenant.orgId);

    expect(await quotaOf(tenant.orgId)).toBe(10);
  });

  it("is safe to run twice", async () => {
    // The webhook can deliver the same subscription event more than once.
    const tenant = await createTenant("twice", { subscriptionTier: "pro" });
    await seedProjects(tenant, PRO_PROJECTS + 3);

    await subscriptions.grandfatherProjectOverage(tenant.orgId);
    await subscriptions.grandfatherProjectOverage(tenant.orgId);

    expect(await quotaOf(tenant.orgId)).toBe(3);
  });
});

describe("purchased quota raises what can actually be created", () => {
  it("lets the organisation create beyond the tier allowance", async () => {
    const tenant = await createTenant("slots-create", {
      subscriptionTier: "pro",
    });
    await seedProjects(tenant, PRO_PROJECTS);

    await expect(makeProject(tenant, "Blocked")).rejects.toThrow();

    await subscriptionRepo.setProjectQuotaAddon(tenant.orgId, 1);

    await expect(makeProject(tenant, "Bought")).resolves.toBeDefined();
  });

  it("stops again once the bought slots are used", async () => {
    const tenant = await createTenant("slots-exhaust", {
      subscriptionTier: "pro",
    });
    await seedProjects(tenant, PRO_PROJECTS);
    await subscriptionRepo.setProjectQuotaAddon(tenant.orgId, 1);

    await makeProject(tenant, "Bought");

    await expect(makeProject(tenant, "One too many")).rejects.toThrow();
  });
});
