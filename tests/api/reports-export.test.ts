// @vitest-environment node
/**
 * The export route, and the plan check that used to sit in the wrong place.
 *
 * This endpoint enforced its plan itself, AFTER `requirePermission` had already
 * answered. The order mattered: a Free member who also lacked `reports:export`
 * was told "Forbidden" and sent looking for a permissions problem, when the real
 * answer was that no one in that organisation could export anything at any
 * level of permission. `permission-guard` exists to make the plan speak first
 * for exactly this reason, and the permission was kept OUT of its map on the
 * grounds that a CSV path served every plan — a CSV path that does not exist.
 *
 * What is pinned here is the mapping and its consequences: the plan answers
 * first and in its own words, the permission still refuses on its own, and the
 * PDF a manager receives is scoped to their departments.
 *
 * The document's CONTENTS are `pdf-report.service.test.ts`; the scoping rule
 * itself is `manager-scope-leaks.test.ts`. This file is about the boundary.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET } from "@/app/api/organizations/[orgId]/reports/export/route";
import { PdfReportService } from "@/services/pdf-report.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { asUser } from "../helpers/session";
import { ctx, req, bodyOf } from "../helpers/route";
import { eventuallyMatching } from "../helpers/settle";

function exportEntries(orgId: string) {
  return prisma.auditLog.findMany({
    where: { organizationId: orgId, action: "report.exported" },
  });
}

async function exportFor(userId: string, tenant: Tenant) {
  asUser(userId);
  return GET(req(), ctx({ orgId: tenant.orgId }));
}

beforeEach(async () => {
  await cleanDatabase();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("a plan that includes the feature", () => {
  let tenant: Tenant;

  beforeEach(async () => {
    tenant = await createTenant("exp-pro", { subscriptionTier: "pro" });
  });

  it("returns a PDF to an admin", async () => {
    const res = await exportFor(tenant.admin.userId, tenant);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");

    // The bytes, not just the header. A route that returned JSON with a PDF
    // content type would satisfy every other assertion here.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("%PDF");
  });

  /**
   * The filename carries the date. Asserted because it is the only thing
   * distinguishing one download from the next in a folder, and because the
   * component parses this header rather than building a name of its own — so a
   * change here silently changes what the browser saves.
   */
  it("names the file with the date it was generated", async () => {
    const res = await exportFor(tenant.admin.userId, tenant);

    expect(res.headers.get("Content-Disposition")).toMatch(
      /attachment; filename="workforce-report-\d{4}-\d{2}-\d{2}\.pdf"/
    );
  });

  it("refuses a member who does not hold reports:export", async () => {
    const res = await exportFor(tenant.staff.userId, tenant);

    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error).toBe("Forbidden");
  });

  /**
   * Scope is passed from the route, not decided by the service.
   *
   * `manager-scope-leaks` proves the service honours a scope it is given; this
   * proves the boundary gives it one. Between them there is no gap — without
   * this test, deleting `departmentScopeFor(membership)` from the call would
   * leave every service test green while every manager downloaded the whole
   * company's staff hours and rejection history, in a file they keep.
   */
  it("scopes a manager's report to their own departments", async () => {
    const generate = vi
      .spyOn(PdfReportService.prototype, "generateReport")
      .mockResolvedValue(new ArrayBuffer(8));

    await exportFor(tenant.manager.userId, tenant);

    /*
     * The fourth argument is who asked, and asserting the ACTUAL id rather than
     * `any(String)` is the point: the service records it as the author of the
     * export, so a route passing the org owner, the assigner or anything else
     * to hand would attribute the download to the wrong person and nothing else
     * would notice.
     */
    expect(generate).toHaveBeenCalledWith(
      tenant.orgId,
      expect.any(String),
      [tenant.departmentId],
      tenant.manager.userId
    );
  });

  /**
   * The only audited action that records an EXTRACTION rather than a change.
   *
   * Everything else in the log describes a row somebody can still go and look
   * at. This describes a file that has left the product — no permission change,
   * deactivation or downgrade can reach it again — and until now nothing
   * recorded that it had happened at all.
   */
  it("records the export, and how wide it was", async () => {
    await exportFor(tenant.admin.userId, tenant);

    const entries = await eventuallyMatching(
      () => exportEntries(tenant.orgId),
      () => true
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBe(tenant.admin.userId);
    expect(entries[0].entityType).toBe("report");
    // `scope` is the field worth having: after the fact, a manager's
    // department PDF and an admin's whole-company one are the same artefact
    // unless the log says which was taken.
    expect((entries[0].details as { scope?: unknown })?.scope).toBe("org-wide");
  });

  it("names the departments when a manager exports", async () => {
    await exportFor(tenant.manager.userId, tenant);

    const entries = await eventuallyMatching(
      () => exportEntries(tenant.orgId),
      () => true
    );

    expect((entries[0].details as { scope?: unknown })?.scope).toEqual([
      tenant.departmentId,
    ]);
  });

  it("leaves an admin's report unrestricted", async () => {
    const generate = vi
      .spyOn(PdfReportService.prototype, "generateReport")
      .mockResolvedValue(new ArrayBuffer(8));

    await exportFor(tenant.admin.userId, tenant);

    expect(generate).toHaveBeenCalledWith(
      tenant.orgId,
      expect.any(String),
      null,
      tenant.admin.userId
    );
  });
});

describe("a plan that does not", () => {
  let tenant: Tenant;

  beforeEach(async () => {
    tenant = await createTenant("exp-free", { subscriptionTier: "free" });
  });

  /**
   * The message is the point, not the status.
   *
   * Both gates answer 403, so a test asserting only the code would pass with
   * the plan check removed entirely — the permission would refuse a staff
   * member anyway and nobody would notice the plan had stopped being consulted.
   * An admin holds every permission, which is what makes them the right caller
   * here: the ONLY thing that can refuse them is the plan.
   */
  it("refuses an admin in the plan's own words", async () => {
    const res = await exportFor(tenant.admin.userId, tenant);

    expect(res.status).toBe(403);
    const error = String((await bodyOf(res)).error);
    expect(error).not.toBe("Forbidden");
    expect(error).toMatch(/not available on the Free plan/);
    expect(error).toMatch(/Upgrade to Pro/);
  });

  /**
   * The ordering, stated as its own case.
   *
   * A member with neither the plan nor the permission is told about the PLAN.
   * With the check in its old place — permission first, plan second — this same
   * caller got "Forbidden", which is true and useless: it sends an admin to the
   * Roles screen to grant a permission that would change nothing.
   */
  it("tells a member without the permission about the plan, not the permission", async () => {
    const res = await exportFor(tenant.staff.userId, tenant);

    expect(res.status).toBe(403);
    expect(String((await bodyOf(res)).error)).toMatch(/Upgrade to Pro/);
  });

  it("does not build a PDF it is going to refuse", async () => {
    const generate = vi.spyOn(PdfReportService.prototype, "generateReport");

    await exportFor(tenant.admin.userId, tenant);

    expect(generate).not.toHaveBeenCalled();
  });
});
