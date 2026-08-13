// @vitest-environment node
/**
 * Deleting a project.
 *
 * The assertion that carries the weight is that the WORK ITEMS SURVIVE. A work
 * item here is a real shift — it has a time, it has people assigned to it, and
 * some of them have already worked it. Cascading the delete would cancel
 * somebody's roster and erase completed hours because an admin tidied up a
 * grouping, so `Task.project` is declared `onDelete: SetNull` and these tests
 * exist to stop that being "simplified" to a cascade later.
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

describe("deleting a project", () => {
  it("removes the project", async () => {
    const project = await makeProject(tenant);

    await projects.remove(project.id, tenant.orgId, tenant.admin.userId);

    expect(
      await prisma.project.findUnique({ where: { id: project.id } })
    ).toBeNull();
  });

  it("keeps the work items, unlinked", async () => {
    // The promise the whole feature rests on. These are shifts, not folders.
    const project = await makeProject(tenant);
    const task = await workItem(tenant, project.id, "Stock check");

    await projects.remove(project.id, tenant.orgId, tenant.admin.userId);

    const survivor = await prisma.task.findUnique({ where: { id: task.id } });
    expect(survivor).not.toBeNull();
    expect(survivor?.projectId).toBeNull();
    expect(survivor?.title).toBe("Stock check");
  });

  it("does not touch the assignments on those work items", async () => {
    /*
     * Somebody is rostered on this. Losing the row would take the shift off
     * their schedule with no notification and no audit entry — the exact
     * phantom-coverage failure that deactivation was fixed for, arrived at
     * from the other direction.
     */
    const project = await makeProject(tenant);
    const task = await workItem(tenant, project.id, "Saturday close");
    const assignment = await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.admin.membershipId,
        status: "accepted",
        assignedById: tenant.admin.userId,
      },
    });

    await projects.remove(project.id, tenant.orgId, tenant.admin.userId);

    const survivor = await prisma.taskAssignment.findUnique({
      where: { id: assignment.id },
    });
    expect(survivor?.status).toBe("accepted");
  });

  it("reports how many work items it unlinked", async () => {
    const project = await makeProject(tenant);
    await workItem(tenant, project.id, "One");
    await workItem(tenant, project.id, "Two");

    const result = await projects.remove(
      project.id,
      tenant.orgId,
      tenant.admin.userId
    );

    expect(result.unlinkedTasks).toBe(2);
  });

  it("records it, since the project row is the thing that just vanished", async () => {
    const project = await makeProject(tenant, "Weekend service");
    await workItem(tenant, project.id, "One");

    await projects.remove(project.id, tenant.orgId, tenant.admin.userId);

    const [entry] = await prisma.auditLog.findMany({
      where: { organizationId: tenant.orgId, action: "project.deleted" },
    });
    expect(entry).toBeTruthy();
    expect(entry.details).toMatchObject({
      title: "Weekend service",
      unlinkedTasks: 1,
    });
  });

  it("refuses a project belonging to another organisation", async () => {
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
