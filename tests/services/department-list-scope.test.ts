// @vitest-environment node
/**
 * Which departments a caller may SEE listed.
 *
 * The permission gate on `GET /departments` answers "may you read departments
 * at all". It never answered "which ones", and this was the one list endpoint
 * in the product that did not ask the second question — so a Kitchen manager
 * was served Bar, Front of House and Marketing.
 *
 * ## Why this was never a security hole, and still had to be fixed
 *
 * Four screens build a department picker from this list: the task filter, the
 * task create form, the members filter and work rules. Every WRITE behind them
 * is scoped independently — `tasks` POST has always checked
 * `isDepartmentInScope` — so the manager could be offered Marketing and would
 * be refused on submit.
 *
 * That makes it a menu promising something the routes will not honour, plus
 * the names of departments the caller has no business knowing. Both are worth
 * closing, and neither would have shown up in a test of the write path, which
 * is where all the existing scope tests live.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DepartmentService } from "@/services/department.service";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor } from "@/lib/department-scope";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const departments = new DepartmentService();
const access = new AccessService();

let tenant: Tenant;
let barId: string;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("dept-scope");

  const bar = await prisma.department.create({
    data: { name: "Bar", color: "#3B82F6", organizationId: tenant.orgId },
  });
  barId = bar.id;
});

/** The scope the route resolves, from the membership the guard loaded. */
async function scopeFor(userId: string) {
  const membership = await access.getMembership(userId, tenant.orgId);
  return departmentScopeFor(membership!);
}

describe("listing departments", () => {
  it("gives a company admin every department", async () => {
    const list = await departments.getByOrganization(
      tenant.orgId,
      false,
      await scopeFor(tenant.admin.userId)
    );

    const names = list.map((d) => d.name);
    expect(names).toContain("Bar");
    expect(names.length).toBeGreaterThan(1);
  });

  /*
   * The manager is assigned to `tenant.departmentId` only. Bar is somebody
   * else's, and until this was fixed it appeared in their filter.
   */
  it("gives a manager only their own", async () => {
    const list = await departments.getByOrganization(
      tenant.orgId,
      false,
      await scopeFor(tenant.manager.userId)
    );

    expect(list.map((d) => d.id)).toEqual([tenant.departmentId]);
    expect(list.map((d) => d.name)).not.toContain("Bar");
  });

  /*
   * The case an optional parameter invites you to get wrong.
   *
   * `departmentScopeFor` returns `null` for an admin and `[]` for somebody
   * scoped to nothing. A guard written as `if (departmentIds?.length)` — the
   * natural thing to type — would treat those two identically and hand the
   * whole organisation to the member with no departments at all. The
   * repository checks `!= null` for exactly this reason.
   */
  it("gives a member with no departments nothing", async () => {
    await prisma.departmentMembership.deleteMany({
      where: { membershipId: tenant.manager.membershipId },
    });

    const list = await departments.getByOrganization(
      tenant.orgId,
      false,
      await scopeFor(tenant.manager.userId)
    );

    expect(list).toEqual([]);
  });

  /*
   * Omitting the argument entirely still means "everything", because two
   * callers do exactly that: the seed and the org-creation flow, neither of
   * which has a membership to scope by.
   */
  it("returns everything when no scope is supplied at all", async () => {
    const list = await departments.getByOrganization(tenant.orgId);
    expect(list.map((d) => d.name)).toContain("Bar");
  });

  it("still respects the archived filter within a scope", async () => {
    await prisma.department.update({
      where: { id: tenant.departmentId },
      data: { archivedAt: new Date() },
    });

    const active = await departments.getByOrganization(
      tenant.orgId,
      false,
      await scopeFor(tenant.manager.userId)
    );
    const all = await departments.getByOrganization(
      tenant.orgId,
      true,
      await scopeFor(tenant.manager.userId)
    );

    expect(active).toEqual([]);
    expect(all.map((d) => d.id)).toEqual([tenant.departmentId]);
  });
});

/*
 * The read behind the invite-import preview.
 *
 * That route held `DepartmentRepository` itself — the one endpoint in the
 * application reaching Entity without a service in between — so this query had
 * no coverage at the layer anything now calls it through.
 */
describe("active department names", () => {
  it("leaves out an archived department", async () => {
    const archived = await prisma.department.create({
      data: {
        organizationId: tenant.orgId,
        name: "Closed Kitchen",
        archivedAt: new Date(),
      },
    });

    const names = await departments.getActiveNames(tenant.orgId);

    expect(names.map((d) => d.id)).toContain(tenant.departmentId);
    expect(names.map((d) => d.id)).not.toContain(archived.id);
  });

  /*
   * A spreadsheet naming another company's department must not resolve. The
   * preview shows the row as matched, and the invitation then places somebody
   * into a department their organisation does not own.
   */
  it("does not reach into another organisation", async () => {
    const other = await createTenant("names-other");

    const names = await departments.getActiveNames(tenant.orgId);

    expect(names.map((d) => d.id)).not.toContain(other.departmentId);
  });

  /*
   * The empty-array trap, one more time. `null` is unrestricted; `[]` is
   * scoped to nothing. A check written `if (ids?.length)` hands a manager with
   * no departments the whole organisation, which is the bug this convention
   * exists to prevent.
   */
  it("treats an empty scope as nothing, not everything", async () => {
    expect(await departments.getActiveNames(tenant.orgId, [])).toEqual([]);
    expect(
      (await departments.getActiveNames(tenant.orgId, null)).map((d) => d.id)
    ).toContain(tenant.departmentId);
  });
});
