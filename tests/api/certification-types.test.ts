// @vitest-environment node
/**
 * The endpoints behind the organisation's certificate list.
 *
 * Two things here are not obvious from the manifest sweep, which only proves
 * that a route enforces what it declares.
 *
 * The first is that GET needs only MEMBERSHIP. Every other read on this subject
 * is gated on `certifications:review`, and copying that here would have been
 * the natural thing to type — but the staff member's own screen shows this list
 * as suggestions, and that half is what stops the two vocabularies drifting
 * apart. A permission-gated read would have left the feature half-built in a
 * way nothing else would notice.
 *
 * The second is the status codes. Both refusals carry a sentence the caller
 * needs — which name clashed, how many shifts still require this one — and a
 * 500 would discard it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import {
  GET as listTypes,
  POST as addType,
} from "@/app/api/organizations/[orgId]/certification-types/route";
import { DELETE as removeType } from "@/app/api/organizations/[orgId]/certification-types/[typeId]/route";
import { prisma } from "@/lib/prisma";
import { CertificationTypeService } from "@/services/certification-type.service";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, createTask, type Tenant } from "../helpers/fixtures";
import { asUser } from "../helpers/session";
import { ctx, req, jsonReq, bodyOf } from "../helpers/route";

const service = new CertificationTypeService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("certtypeapi");
  vi.clearAllMocks();
});

describe("reading the list", () => {
  /*
   * The one that would have been got wrong. A staff member has no
   * `certifications:review` and every other certification read demands it — but
   * they are shown this list when recording a certificate of their own, and
   * that is the half that keeps the two vocabularies in agreement.
   */
  it("is open to a plain staff member", async () => {
    await service.create(tenant.orgId, "Food Safety");
    asUser(tenant.staff.userId);

    const res = await listTypes(req(), ctx({ orgId: tenant.orgId }));

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it("refuses somebody outside the organisation", async () => {
    const outsider = await createTenant("certtypeapi-other");
    asUser(outsider.admin.userId);

    const res = await listTypes(req(), ctx({ orgId: tenant.orgId }));

    expect(res.status).toBe(403);
  });

  it("does not leak another organisation's list", async () => {
    const other = await createTenant("certtypeapi-other");
    await service.create(other.orgId, "Forklift");
    asUser(tenant.admin.userId);

    const res = await listTypes(req(), ctx({ orgId: tenant.orgId }));

    expect(await res.json()).toEqual([]);
  });
});

describe("adding a name", () => {
  it("creates it for a reviewer", async () => {
    asUser(tenant.admin.userId);

    const res = await addType(
      jsonReq("POST", { name: "Food Safety" }),
      ctx({ orgId: tenant.orgId })
    );

    expect(res.status).toBe(201);
    expect((await bodyOf(res)).name).toBe("Food Safety");
  });

  // The write side is NOT open, unlike the read. Deciding what the organisation
  // recognises is the same judgement as verifying a submission.
  it("refuses a plain staff member", async () => {
    asUser(tenant.staff.userId);

    const res = await addType(
      jsonReq("POST", { name: "Food Safety" }),
      ctx({ orgId: tenant.orgId })
    );

    expect(res.status).toBe(403);
  });

  // 400: the reader fixes this by typing something.
  it("answers 400 for an empty name", async () => {
    asUser(tenant.admin.userId);

    const res = await addType(
      jsonReq("POST", { name: "   " }),
      ctx({ orgId: tenant.orgId })
    );

    expect(res.status).toBe(400);
  });

  it("answers 400 when the field is missing entirely", async () => {
    asUser(tenant.admin.userId);

    const res = await addType(jsonReq("POST", {}), ctx({ orgId: tenant.orgId }));

    expect(res.status).toBe(400);
  });

  /*
   * 409 and not 400: the request is well formed and the organisation's current
   * state refuses it. Case-insensitively, which is stricter than the database
   * index — eligibility lower-cases both sides, so two spellings would be two
   * ways to require one certificate.
   */
  it("answers 409 for one that differs only in case", async () => {
    await service.create(tenant.orgId, "Food Safety");
    asUser(tenant.admin.userId);

    const res = await addType(
      jsonReq("POST", { name: "food safety" }),
      ctx({ orgId: tenant.orgId })
    );

    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toMatch(/already on the list/);
  });
});

describe("removing a name", () => {
  it("removes one nothing requires", async () => {
    const type = await service.create(tenant.orgId, "Forklift");
    asUser(tenant.admin.userId);

    const res = await removeType(
      req(),
      ctx({ orgId: tenant.orgId, typeId: type.id })
    );

    expect(res.status).toBe(200);
  });

  /*
   * 409 with the count, which is the whole value of the message. Removing a
   * name breaks nothing today — the requirement is a stored string and
   * eligibility keeps enforcing it — but the next person to edit one of those
   * shifts would silently drop a requirement the picker can no longer
   * represent.
   */
  it("answers 409 while a task still requires it", async () => {
    const type = await service.create(tenant.orgId, "Food Safety");
    const task = await createTask(tenant);
    await prisma.task.update({
      where: { id: task.id },
      data: { requiredCertifications: ["Food Safety"] },
    });
    asUser(tenant.admin.userId);

    const res = await removeType(
      req(),
      ctx({ orgId: tenant.orgId, typeId: type.id })
    );

    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toMatch(/1 task still requires/);
  });

  it("answers 404 for another organisation's", async () => {
    const other = await createTenant("certtypeapi-other");
    const type = await service.create(other.orgId, "Forklift");
    asUser(tenant.admin.userId);

    const res = await removeType(
      req(),
      ctx({ orgId: tenant.orgId, typeId: type.id })
    );

    expect(res.status).toBe(404);
  });

  it("refuses a plain staff member", async () => {
    const type = await service.create(tenant.orgId, "Forklift");
    asUser(tenant.staff.userId);

    const res = await removeType(
      req(),
      ctx({ orgId: tenant.orgId, typeId: type.id })
    );

    expect(res.status).toBe(403);
  });
});
