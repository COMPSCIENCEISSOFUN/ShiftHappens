// @vitest-environment node
/**
 * The plan limit on projects.
 *
 * Projects were the only capped resource with no cap: every other service that
 * creates something countable calls `enforceResourceLimit` first, and
 * `ProjectService.create` did not — so Free, Pro and Enterprise all had
 * unlimited projects regardless of what the pricing page said.
 *
 * The last test is the one that pins the SEMANTICS rather than the number.
 * Pro's single project is one at a time, not one ever, so deleting frees the
 * slot — same promise `departments` and `work_rules` already make. If that is
 * ever changed to a lifetime allowance it has to fail here first, because a
 * limit that silently stops refunding is indistinguishable from a bug to the
 * person who deleted a project to make room.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ProjectService } from "@/services/project.service";
import { SubscriptionLimitError } from "@/lib/subscription-tiers";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const projects = new ProjectService();

function projectCount(orgId: string) {
  return prisma.project.count({ where: { organizationId: orgId } });
}

function makeProject(tenant: Tenant, title: string) {
  return projects.create(
    {
      title,
      staffingMode: "task_based",
      departmentIds: [tenant.departmentId],
    },
    tenant.orgId,
    tenant.admin.userId
  );
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("project limits by plan", () => {
  it("refuses the very first project on Free", async () => {
    const tenant = await createTenant("free-proj", { subscriptionTier: "free" });

    await expect(makeProject(tenant, "First")).rejects.toThrow(
      SubscriptionLimitError
    );
    // Both halves: refused, AND nothing was written on the way to refusing.
    expect(await projectCount(tenant.orgId)).toBe(0);
  });

  it("allows the one included project on Pro, then refuses the second", async () => {
    const tenant = await createTenant("pro-proj", { subscriptionTier: "pro" });

    await makeProject(tenant, "Included");
    expect(await projectCount(tenant.orgId)).toBe(1);

    await expect(makeProject(tenant, "Second")).rejects.toThrow(
      SubscriptionLimitError
    );
    expect(await projectCount(tenant.orgId)).toBe(1);
  });

  it("names Enterprise as the way up when Pro is full", async () => {
    const tenant = await createTenant("pro-hint", { subscriptionTier: "pro" });
    await makeProject(tenant, "Included");

    await expect(makeProject(tenant, "Second")).rejects.toThrow(
      /Upgrade to Enterprise/
    );
  });

  it("does not cap Enterprise", async () => {
    const tenant = await createTenant("ent-proj", {
      subscriptionTier: "enterprise",
    });

    for (const title of ["One", "Two", "Three", "Four"]) {
      await makeProject(tenant, title);
    }
    expect(await projectCount(tenant.orgId)).toBe(4);
  });

  it("frees the slot when a project is deleted", async () => {
    const tenant = await createTenant("recycle", { subscriptionTier: "pro" });

    const first = await makeProject(tenant, "Included");
    await expect(makeProject(tenant, "Blocked")).rejects.toThrow(
      SubscriptionLimitError
    );

    await prisma.project.delete({ where: { id: first.id } });

    // The slot is genuinely back — not merely un-refused.
    await makeProject(tenant, "Replacement");
    expect(await projectCount(tenant.orgId)).toBe(1);
  });
});
