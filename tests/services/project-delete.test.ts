// @vitest-environment node
/**
 * Deleting a project, and mostly refusing to.
 *
 * Projects became permanent on 2026-08-14: they cannot be archived, and only an
 * EMPTY one can be deleted. The rule exists because a project records why a set
 * of shifts was grouped, who owned it and over what period — and because the
 * plan quota counts projects, so a deletable project is a renewable slot and
 * the limit stops meaning anything.
 *
 * The exception is the one genuinely unfair case: a project created by mistake,
 * with nothing in it to audit, which would otherwise consume a permanent slot
 * forever and be remediable only by buying another.
 *
 * The tenant test is the other half: the project id arrives from a URL, and a
 * delete scoped only by id would remove another organisation's project.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ProjectService } from "@/services/project.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const projects = new ProjectService();

function makeProject(tenant: Tenant, title = "Bar improvement") {
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

/** A work item belonging to the project — an ordinary task with a projectId. */
async function workItem(tenant: Tenant, projectId: string, title: string) {
  return prisma.task.create({
    data: {
      title,
      organizationId: tenant.orgId,
      departmentId: tenant.departmentId,
      projectId,
      createdById: tenant.admin.userId,
      status: "open",
      priority: "medium",
      requiredHeadcount: 1,
    },
  });
}

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("proj-del", { subscriptionTier: "enterprise" });
});

describe("an empty project can be deleted", () => {
  it("removes it", async () => {
    // The mistake case: a typo in the title, nothing inside, no reason to keep
    // it and every reason not to charge somebody a permanent slot for it.
    const project = await makeProject(tenant);

    await projects.remove(project.id, tenant.orgId, tenant.admin.userId);

    expect(
      await prisma.project.findUnique({ where: { id: project.id } })
    ).toBeNull();
  });

  it("reports that it unlinked nothing", async () => {
    const project = await makeProject(tenant);

    const result = await projects.remove(
      project.id,
      tenant.orgId,
      tenant.admin.userId
    );

    expect(result.unlinkedTasks).toBe(0);
  });

  it("records it, since the project row is the thing that just vanished", async () => {
    const project = await makeProject(tenant, "Weekend service");

    await projects.remove(project.id, tenant.orgId, tenant.admin.userId);

    const [entry] = await prisma.auditLog.findMany({
      where: { organizationId: tenant.orgId, action: "project.deleted" },
    });
    expect(entry).toBeTruthy();
    expect(entry.details).toMatchObject({ title: "Weekend service" });
  });

  it("frees the slot it was occupying", async () => {
    // The quota counts projects, and an empty one that has been removed is not
    // one. This is the only route back under a limit, which is why it is
    // narrow.
    const project = await makeProject(tenant);
    const before = await prisma.project.count({
      where: { organizationId: tenant.orgId },
    });

    await projects.remove(project.id, tenant.orgId, tenant.admin.userId);

    expect(
      await prisma.project.count({ where: { organizationId: tenant.orgId } })
    ).toBe(before - 1);
  });
});

describe("a project holding work is permanent", () => {
  it("refuses to delete one with a work item", async () => {
    const project = await makeProject(tenant);
    await workItem(tenant, project.id, "Stock check");

    await expect(
      projects.remove(project.id, tenant.orgId, tenant.admin.userId)
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it("leaves the project and its work exactly as they were", async () => {
    /*
     * A refusal that had already deleted half of something would be worse than
     * no refusal at all. Asserted on both, because the guard sits before the
     * write and this is what proves it.
     */
    const project = await makeProject(tenant);
    const task = await workItem(tenant, project.id, "Saturday close");

    await expect(
      projects.remove(project.id, tenant.orgId, tenant.admin.userId)
    ).rejects.toThrow();

    expect(
      await prisma.project.findUnique({ where: { id: project.id } })
    ).not.toBeNull();
    const survivor = await prisma.task.findUnique({ where: { id: task.id } });
    expect(survivor?.projectId).toBe(project.id);
  });

  it("refuses even when the work item is cancelled", async () => {
    /*
     * Emptiness is about whether anything ever happened here, not about
     * whether it is still outstanding. If a cancelled item made a project
     * disposable, cancelling everything inside one would be the way to recycle
     * a permanent slot — which is the loophole the rule exists to close.
     */
    const project = await makeProject(tenant);
    const task = await workItem(tenant, project.id, "Called off");
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "cancelled" },
    });

    await expect(
      projects.remove(project.id, tenant.orgId, tenant.admin.userId)
    ).rejects.toThrow(/cannot be deleted/i);
  });
});

describe("whose project it is", () => {
  it("refuses one belonging to another organisation", async () => {
    // Scoped in the query, so the wrong tenant deletes nothing rather than
    // deleting somebody else's project.
    const other = await createTenant("proj-del-other", {
      subscriptionTier: "enterprise",
    });
    const project = await makeProject(tenant);

    await expect(
      projects.remove(project.id, other.orgId, other.admin.userId)
    ).rejects.toThrow("Project not found");

    expect(
      await prisma.project.findUnique({ where: { id: project.id } })
    ).not.toBeNull();
  });

  it("refuses an id that does not exist", async () => {
    await expect(
      projects.remove("nope", tenant.orgId, tenant.admin.userId)
    ).rejects.toThrow("Project not found");
  });
});
