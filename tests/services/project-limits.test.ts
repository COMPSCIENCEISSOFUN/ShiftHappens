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
import {
  SubscriptionLimitError,
  FeatureNotAvailableError,
  getResourceLimit,
} from "@/lib/subscription-tiers";
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
  /*
   * The FEATURE error, not the limit error, and the change is deliberate.
   *
   * Projects became a gated feature on 2026-08-14 as well as a counted one,
   * and `ProjectService.create` asks for the feature first. Both refuse a Free
   * organisation, but they say different things: the limit error reads
   * "projects limit reached (0/0)", which describes a container that is full,
   * where the truth is that the plan has no projects in it at all.
   *
   * The limit error is still what Pro meets, which the test below pins — so
   * the two are asserted separately rather than collapsed into "it throws".
   */
  it("refuses the very first project on Free, naming the plan", async () => {
    const tenant = await createTenant("free-proj", { subscriptionTier: "free" });

    await expect(makeProject(tenant, "First")).rejects.toThrow(
      FeatureNotAvailableError
    );
    await expect(makeProject(tenant, "First")).rejects.toThrow(
      /not available on the Free plan/i
    );
    // Both halves: refused, AND nothing was written on the way to refusing.
    expect(await projectCount(tenant.orgId)).toBe(0);
  });

  it("allows Pro its full allowance, then refuses the next", async () => {
    /*
     * Filled from the config rather than to a written number. Pro's allowance
     * moved from one to ten when projects became permanent, and this test was
     * about "refuses past the limit" rather than about the limit being one.
     */
    const tenant = await createTenant("pro-proj", { subscriptionTier: "pro" });
    const allowance = getResourceLimit("pro", "projects") as number;

    for (let i = 0; i < allowance; i++) {
      await makeProject(tenant, `Included ${i + 1}`);
    }
    expect(await projectCount(tenant.orgId)).toBe(allowance);

    await expect(makeProject(tenant, "One too many")).rejects.toThrow(
      SubscriptionLimitError
    );
    expect(await projectCount(tenant.orgId)).toBe(allowance);
  });

  it("names Enterprise as the way up when Pro is full", async () => {
    const tenant = await createTenant("pro-hint", { subscriptionTier: "pro" });
    const allowance = getResourceLimit("pro", "projects") as number;
    for (let i = 0; i < allowance; i++) {
      await makeProject(tenant, `Included ${i + 1}`);
    }

    await expect(makeProject(tenant, "One too many")).rejects.toThrow(
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

  it("frees the slot when an EMPTY project is deleted", async () => {
    /*
     * The only route back under a limit, and deliberately narrow: a project
     * holding work items cannot be deleted at all, so this cannot be used to
     * recycle a permanent slot. `project-delete.test.ts` pins that half.
     */
    const tenant = await createTenant("recycle", { subscriptionTier: "pro" });
    const allowance = getResourceLimit("pro", "projects") as number;

    const first = await makeProject(tenant, "Included 1");
    for (let i = 1; i < allowance; i++) {
      await makeProject(tenant, `Included ${i + 1}`);
    }
    await expect(makeProject(tenant, "Blocked")).rejects.toThrow(
      SubscriptionLimitError
    );

    await prisma.project.delete({ where: { id: first.id } });

    // The slot is genuinely back — not merely un-refused.
    await makeProject(tenant, "Replacement");
    expect(await projectCount(tenant.orgId)).toBe(allowance);
  });
});
