// @vitest-environment node
/**
 * Purchased project quota, on top of the tier allowance.
 *
 * The add-on is a recurring Stripe subscription item, so the quota it grants
 * is held for exactly as long as it is paid for. Three things have to stay
 * true for that to mean anything:
 *
 *   1. it ADDS to the tier baseline rather than replacing it, so a plan change
 *      still moves the floor underneath it;
 *   2. the usage panel and the create path compute it the same way — the whole
 *      reason both call `effectiveLimit` — because a panel that promises room
 *      the guard refuses is a support ticket every time;
 *   3. it does not survive the subscription, or it is a permanent free upgrade
 *      bought once.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SubscriptionService } from "@/services/subscription.service";
import { SubscriptionRepository } from "@/repositories/subscription.repository";
import { ProjectService } from "@/services/project.service";
import { SubscriptionLimitError } from "@/lib/subscription-tiers";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const subscriptions = new SubscriptionService();
const subscriptionRepo = new SubscriptionRepository();
const projects = new ProjectService();

function makeProject(tenant: Tenant, title: string) {
  return projects.create(
    { title, staffingMode: "task_based", departmentIds: [tenant.departmentId] },
    tenant.orgId,
    tenant.admin.userId
  );
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("purchased project quota", () => {
  it("adds to the tier allowance rather than replacing it", async () => {
    const tenant = await createTenant("addon", { subscriptionTier: "pro" });
    await subscriptionRepo.setProjectQuotaAddon(tenant.orgId, 3);

    const check = await subscriptions.checkResourceLimit(tenant.orgId, "projects");
    // Pro includes 1; the pack adds 3.
    expect(check.limit).toBe(4);
  });

  it("lets the organisation actually create up to the raised limit", async () => {
    const tenant = await createTenant("addon-create", { subscriptionTier: "pro" });
    await subscriptionRepo.setProjectQuotaAddon(tenant.orgId, 2);

    for (const title of ["One", "Two", "Three"]) {
      await makeProject(tenant, title);
    }
    await expect(makeProject(tenant, "Fourth")).rejects.toThrow(
      SubscriptionLimitError
    );
    expect(
      await prisma.project.count({ where: { organizationId: tenant.orgId } })
    ).toBe(3);
  });

  it("reports the same raised limit on the usage panel as it enforces", async () => {
    const tenant = await createTenant("addon-usage", { subscriptionTier: "pro" });
    await subscriptionRepo.setProjectQuotaAddon(tenant.orgId, 5);

    const usage = await subscriptions.getUsage(tenant.orgId);
    const check = await subscriptions.checkResourceLimit(tenant.orgId, "projects");

    expect(usage.resources.projects.limit).toBe(6);
    expect(usage.resources.projects.limit).toBe(check.limit);
  });

  it("leaves unlimited plans unlimited", async () => {
    const tenant = await createTenant("addon-ent", {
      subscriptionTier: "enterprise",
    });
    await subscriptionRepo.setProjectQuotaAddon(tenant.orgId, 10);

    const check = await subscriptions.checkResourceLimit(tenant.orgId, "projects");
    // null, not 10 — adding to "no cap" must not invent one.
    expect(check.limit).toBeNull();
    expect(check.allowed).toBe(true);
  });

  it("does not raise the limit of any other resource", async () => {
    const tenant = await createTenant("addon-scope", { subscriptionTier: "pro" });
    await subscriptionRepo.setProjectQuotaAddon(tenant.orgId, 25);

    const departments = await subscriptions.checkResourceLimit(
      tenant.orgId,
      "departments"
    );
    const members = await subscriptions.checkResourceLimit(tenant.orgId, "members");

    expect(departments.limit).toBe(10);
    expect(members.limit).toBe(50);
  });

  it("is clamped at zero rather than going negative", async () => {
    const tenant = await createTenant("addon-neg", { subscriptionTier: "pro" });
    await subscriptionRepo.setProjectQuotaAddon(tenant.orgId, -5);

    const check = await subscriptions.checkResourceLimit(tenant.orgId, "projects");
    expect(check.limit).toBe(1);
  });
});
