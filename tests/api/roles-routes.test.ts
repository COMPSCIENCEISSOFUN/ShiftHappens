// @vitest-environment node
/**
 * The status codes the roles endpoints answer with.
 *
 * Two refusals in this pair of files reached the caller as an opaque 500, and
 * in both cases the sentence the service went to the trouble of composing was
 * discarded on the way out.
 *
 * The first is new: `assertMayGrantPermissions` refuses a role that reaches
 * past its author. It has to answer 403 rather than 400, matching what
 * `PATCH /members/[userId]` already returns for the identical message — the
 * request is well-formed and the caller simply may not make it, so "fix your
 * input" would be the wrong instruction.
 *
 * The second was there all along. `assertNoWorkRulesTargetRole` runs in
 * `delete` and nowhere else, and the 409 branch for it was written on PATCH,
 * where nothing can raise it. So the one refusal it exists for — the one whose
 * message names the work rules to retarget — was the one nobody ever saw.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import {
  POST as createRole,
  GET as listRoles,
} from "@/app/api/organizations/[orgId]/roles/route";
import {
  PATCH as patchRole,
  DELETE as deleteRole,
} from "@/app/api/organizations/[orgId]/roles/[roleId]/route";
import { prisma } from "@/lib/prisma";
import { UserManagementService } from "@/services/user-management.service";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { asUser } from "../helpers/session";
import { ctx, req, jsonReq, bodyOf } from "../helpers/route";

const members = new UserManagementService();

interface RoleRow {
  memberCount: number;
  heldByCaller: boolean;
}

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("roleroutes");
  vi.clearAllMocks();
});

/** The ids behind a set of permission names. */
async function ids(...names: string[]) {
  const found = await prisma.permission.findMany({
    where: { name: { in: names } },
    select: { id: true },
  });
  if (found.length !== names.length) {
    throw new Error(`seed missing one of: ${names.join(", ")}`);
  }
  return found.map((p) => p.id);
}

/** Builds a role and gives it to a member, as an admin would. */
async function wear(userId: string, names: string[], label = "Delegate") {
  const role = await prisma.role.create({
    data: {
      organizationId: tenant.orgId,
      name: label.toLowerCase(),
      displayLabel: label,
      rolePermissions: {
        create: (await ids(...names)).map((id) => ({ permissionId: id })),
      },
    },
  });
  await members.assignCustomRole(userId, tenant.orgId, role.id, tenant.admin.userId);
  return role;
}

describe("a role reaching past its author", () => {
  it("answers 403 on create, not 500", async () => {
    await wear(tenant.manager.userId, ["roles:manage"]);
    asUser(tenant.manager.userId);

    const res = await createRole(
      jsonReq("POST", {
        displayLabel: "Overreach",
        permissionIds: await ids("billing:manage"),
      }),
      ctx({ orgId: tenant.orgId })
    );

    expect(res.status).toBe(403);
  });

  // The message names the permission that was refused, which is the only part
  // of the response that tells the reader what to untick.
  it("passes the reason through rather than swallowing it", async () => {
    await wear(tenant.manager.userId, ["roles:manage"]);
    asUser(tenant.manager.userId);

    const res = await createRole(
      jsonReq("POST", {
        displayLabel: "Overreach",
        permissionIds: await ids("billing:manage"),
      }),
      ctx({ orgId: tenant.orgId })
    );

    expect((await bodyOf(res)).error).toMatch(/billing:manage/);
  });

  it("answers 403 on update too", async () => {
    const worn = await wear(tenant.manager.userId, ["roles:manage"]);
    asUser(tenant.manager.userId);

    const res = await patchRole(
      jsonReq("PATCH", {
        permissionIds: await ids("roles:manage", "billing:manage"),
      }),
      ctx({ orgId: tenant.orgId, roleId: worn.id })
    );

    expect(res.status).toBe(403);
  });

  // The positive control. A handler that answered 403 unconditionally would
  // satisfy both assertions above.
  it("still lets an admin create anything", async () => {
    asUser(tenant.admin.userId);

    const res = await createRole(
      jsonReq("POST", {
        displayLabel: "Everything",
        permissionIds: await ids("billing:manage", "audit:view"),
      }),
      ctx({ orgId: tenant.orgId })
    );

    expect(res.status).toBe(201);
  });

  it("still lets a delegate build within their means", async () => {
    await wear(tenant.manager.userId, ["roles:manage"]);
    asUser(tenant.manager.userId);

    const res = await createRole(
      jsonReq("POST", {
        displayLabel: "Helper",
        permissionIds: await ids("tasks:create"),
      }),
      ctx({ orgId: tenant.orgId })
    );

    expect(res.status).toBe(201);
  });
});

describe("deleting a role a work rule still targets", () => {
  /** A role with a work rule pointed at it, which is what blocks the delete. */
  async function targetedRole() {
    const role = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "targeted",
        displayLabel: "Targeted",
        rolePermissions: {
          create: (await ids("tasks:create")).map((id) => ({ permissionId: id })),
        },
      },
    });
    await prisma.workRule.create({
      data: {
        organizationId: tenant.orgId,
        name: "Night cover",
        type: "max_hours_weekly",
        maxHours: 38,
        roleId: role.id,
      },
    });
    return role;
  }

  it("answers 409 rather than 500", async () => {
    const role = await targetedRole();
    asUser(tenant.admin.userId);

    const res = await deleteRole(
      req(),
      ctx({ orgId: tenant.orgId, roleId: role.id })
    );

    expect(res.status).toBe(409);
  });

  /*
   * Names, not a count. "1 work rule targets this role" says there is a problem
   * and nothing about how to solve it — the service composes the list of names
   * precisely so the admin knows what to retarget, and a 500 threw it away.
   */
  it("names the work rule standing in the way", async () => {
    const role = await targetedRole();
    asUser(tenant.admin.userId);

    const res = await deleteRole(
      req(),
      ctx({ orgId: tenant.orgId, roleId: role.id })
    );

    expect((await bodyOf(res)).error).toMatch(/Night cover/);
  });

  it("deletes one nothing targets", async () => {
    const role = await prisma.role.create({
      data: {
        organizationId: tenant.orgId,
        name: "free",
        displayLabel: "Free",
        rolePermissions: {
          create: (await ids("tasks:create")).map((id) => ({ permissionId: id })),
        },
      },
    });
    asUser(tenant.admin.userId);

    const res = await deleteRole(
      req(),
      ctx({ orgId: tenant.orgId, roleId: role.id })
    );

    expect(res.status).toBe(200);
  });
});

/**
 * The list the roles page reads.
 *
 * `memberCount` and `heldByCaller` are what the delete confirmation is built
 * on, and neither can be worked out on the client: the page knows the caller's
 * permission NAMES and nothing else about who they are.
 */
describe("what the roles list carries", () => {
  it("counts the holders and marks the caller's own", async () => {
    // The role carries `roles:manage` because reading this list needs it — the
    // caller has to be somebody who can open the roles page at all.
    const worn = await wear(tenant.manager.userId, ["roles:manage"], "Worn");
    await members.assignCustomRole(
      tenant.staff.userId,
      tenant.orgId,
      worn.id,
      tenant.admin.userId
    );
    asUser(tenant.manager.userId);

    const res = await listRoles(req(), ctx({ orgId: tenant.orgId }));
    // The list endpoint answers an array; `bodyOf` is typed for the object
    // shape every other route returns.
    const [role] = (await res.json()) as RoleRow[];

    expect(role.memberCount).toBe(2);
    expect(role.heldByCaller).toBe(true);
  });

  it("does not mark it for somebody who does not wear it", async () => {
    await wear(tenant.staff.userId, ["tasks:create"], "Worn");
    asUser(tenant.admin.userId);

    const res = await listRoles(req(), ctx({ orgId: tenant.orgId }));
    // The list endpoint answers an array; `bodyOf` is typed for the object
    // shape every other route returns.
    const [role] = (await res.json()) as RoleRow[];

    expect(role.memberCount).toBe(1);
    expect(role.heldByCaller).toBe(false);
  });
});
