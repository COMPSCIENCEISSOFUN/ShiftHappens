/**
 * Availability means two different things, and the difference is contractual.
 *
 * A CASUAL member's availability is an offer: they decide when they are willing
 * to work and the business fits around it, so an override of theirs binds the
 * moment they save it. A FULL-TIME member is contracted for their days, so an
 * absence is not a declaration but a request — written `pending`, ignored by the
 * roster, and binding only once a manager approves.
 *
 * The single most important assertion in this file is that a PENDING request
 * does not make anybody unavailable. Without that, a full-timer could take
 * themselves off the roster unilaterally, which is exactly what the approval
 * step exists to prevent — and the failure would be silent, because the row
 * would be sitting there looking like it had worked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted — must be declared in the test file itself, not in a helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { PATCH as reviewLeave } from "@/app/api/organizations/[orgId]/leave/[overrideId]/route";
import { GET as listLeave } from "@/app/api/organizations/[orgId]/leave/route";
import { asUser } from "../helpers/session";
import { ctx, req, jsonReq, bodyOf } from "../helpers/route";
import { AvailabilityService } from "@/services/availability.service";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const service = new AvailabilityService();
const repo = new AvailabilityRepository();

const DATE = "2026-08-14T00:00:00.000Z";
/** Friday 14 August 2026, 10:00 Singapore time. */
const SHIFT_DAY = new Date("2026-08-14T10:00:00+08:00");

let tenant: Tenant;
let fullTimer: string;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("leave");

  // The fixture's staff member is casual by default; a second one is contracted.
  const user = await prisma.user.create({
    data: { name: "Full Timer", email: "ft@leave.test", hashedPassword: "h" },
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: tenant.orgId,
      role: "staff",
      status: "active",
      employmentType: "full_time",
    },
  });
  await prisma.departmentMembership.create({
    data: { membershipId: membership.id, departmentId: tenant.departmentId },
  });
  fullTimer = membership.id;

  // Both are contracted/available Fridays 09:00–17:00.
  for (const id of [fullTimer, tenant.staff.membershipId]) {
    await prisma.availability.create({
      data: {
        membershipId: id,
        dayOfWeek: 5,
        startTime: "09:00",
        endTime: "17:00",
        isAvailable: true,
      },
    });
  }
});

function askForLeave(membershipId: string) {
  return service.createOverride(membershipId, {
    date: DATE,
    isAvailable: false,
    reason: "Medical appointment",
  });
}

describe("who has to ask", () => {
  it("writes a casual member's override as approved", async () => {
    const created = await askForLeave(tenant.staff.membershipId);
    expect(created.status).toBe("approved");
  });

  it("writes a full-time member's as pending", async () => {
    const created = await askForLeave(fullTimer);
    expect(created.status).toBe("pending");
  });

  /*
   * Read from the membership, never from the request body. A client that could
   * name its own status would make the whole distinction advisory — a
   * full-timer would simply post "approved".
   */
  it("decides from the membership, not from anything the caller sends", async () => {
    await prisma.membership.update({
      where: { id: fullTimer },
      data: { employmentType: "casual" },
    });

    const created = await askForLeave(fullTimer);
    expect(created.status).toBe("approved");
  });
});

describe("what a pending request does to the roster", () => {
  // The assertion the whole feature rests on.
  it("nothing — the member is still available", async () => {
    await askForLeave(fullTimer);

    const check = await repo.isAvailableAt(fullTimer, SHIFT_DAY, "10:00", "14:00");
    expect(check.available).toBe(true);
  });

  it("but a casual member's identical override takes effect at once", async () => {
    await askForLeave(tenant.staff.membershipId);

    const check = await repo.isAvailableAt(
      tenant.staff.membershipId,
      SHIFT_DAY,
      "10:00",
      "14:00"
    );
    expect(check.available).toBe(false);
  });

  it("approving it is what makes them unavailable", async () => {
    const request = await askForLeave(fullTimer);

    await service.reviewLeave(request.id, "approved", tenant.admin.userId);

    const check = await repo.isAvailableAt(fullTimer, SHIFT_DAY, "10:00", "14:00");
    expect(check.available).toBe(false);
  });

  // A rejected row is inert in the same way a pending one is — it must not
  // linger as a half-applied absence.
  it("rejecting leaves them on the roster", async () => {
    const request = await askForLeave(fullTimer);

    await service.reviewLeave(request.id, "rejected", tenant.admin.userId);

    const check = await repo.isAvailableAt(fullTimer, SHIFT_DAY, "10:00", "14:00");
    expect(check.available).toBe(true);
  });
});

describe("reviewing", () => {
  it("records who decided", async () => {
    const request = await askForLeave(fullTimer);
    await service.reviewLeave(request.id, "approved", tenant.admin.userId);

    const after = await repo.getOverrideById(request.id);
    expect(after?.reviewedById).toBe(tenant.admin.userId);
  });

  /*
   * A second reviewer opening a stale list must not silently overturn the
   * first one's decision — and an approve-then-reject would leave the audit log
   * describing two contradictory outcomes for one request.
   */
  it("refuses a request that has already been decided", async () => {
    const request = await askForLeave(fullTimer);
    await service.reviewLeave(request.id, "approved", tenant.admin.userId);

    await expect(
      service.reviewLeave(request.id, "rejected", tenant.admin.userId)
    ).rejects.toThrow(/already been reviewed/);
  });

  /*
   * Re-submitting clears the old verdict. A member who is told no, and asks
   * again for the same date with a better reason, must not be carrying a
   * rejection that was about the first attempt.
   */
  it("resets a rejected request to pending when it is asked again", async () => {
    const request = await askForLeave(fullTimer);
    await service.reviewLeave(request.id, "rejected", tenant.admin.userId);

    const resubmitted = await service.createOverride(fullTimer, {
      date: DATE,
      isAvailable: false,
      reason: "Hospital appointment, rescheduled",
    });

    expect(resubmitted.status).toBe("pending");
    expect(resubmitted.reviewedById).toBeNull();
  });
});

describe("who gets told", () => {
  /*
   * The approve route is department-scoped and answers 404 to a manager whose
   * departments do not include the requester. Notifying every manager therefore
   * told Kitchen about a Front of House request, which they would click into
   * and be refused — a boundary presented as a bug. Audience and authority have
   * to be the same set.
   */
  it("does not notify a manager with no scope over the requester", async () => {
    const otherDept = await prisma.department.create({
      data: { name: "Front of House", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    const outsider = await prisma.user.create({
      data: { name: "FoH Manager", email: "foh@leave.test", hashedPassword: "h" },
    });
    const outsiderMembership = await prisma.membership.create({
      data: {
        userId: outsider.id,
        organizationId: tenant.orgId,
        role: "manager",
        status: "active",
      },
    });
    await prisma.departmentMembership.create({
      data: { membershipId: outsiderMembership.id, departmentId: otherDept.id },
    });

    await askForLeave(fullTimer);
    await new Promise((r) => setTimeout(r, 150)); // the fan-out is fire-and-forget

    const theirs = await prisma.notification.count({
      where: { userId: outsider.id, type: "leave_requested" },
    });
    expect(theirs).toBe(0);
  });

  // Admins are unscoped — `departmentScopeFor` returns null for them — so they
  // can approve anything and must always hear about it.
  it("always notifies an admin", async () => {
    await askForLeave(fullTimer);
    await new Promise((r) => setTimeout(r, 150));

    const theirs = await prisma.notification.count({
      where: { userId: tenant.admin.userId, type: "leave_requested" },
    });
    expect(theirs).toBe(1);
  });
});

describe("the review endpoint", () => {
  it("lists what is waiting", async () => {
    await askForLeave(fullTimer);

    asUser(tenant.admin.userId);
    const res = await listLeave(req("GET"), ctx({ orgId: tenant.orgId }));
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
  });

  // Approved and rejected rows are decided, not waiting. A list that kept them
  // would grow forever and stop being a to-do.
  it("stops listing one once it is decided", async () => {
    const request = await askForLeave(fullTimer);
    await service.reviewLeave(request.id, "approved", tenant.admin.userId);

    asUser(tenant.admin.userId);
    const res = await listLeave(req("GET"), ctx({ orgId: tenant.orgId }));

    expect(await bodyOf(res)).toHaveLength(0);
  });

  it("approves through the route", async () => {
    const request = await askForLeave(fullTimer);

    asUser(tenant.admin.userId);
    const res = await reviewLeave(
      jsonReq("PATCH", { decision: "approved" }),
      ctx({ orgId: tenant.orgId, overrideId: request.id })
    );

    expect(res.status).toBe(200);
    expect((await repo.getOverrideById(request.id))?.status).toBe("approved");
  });

  it("refuses a decision it does not recognise", async () => {
    const request = await askForLeave(fullTimer);

    asUser(tenant.admin.userId);
    const res = await reviewLeave(
      jsonReq("PATCH", { decision: "maybe" }),
      ctx({ orgId: tenant.orgId, overrideId: request.id })
    );

    expect(res.status).toBe(400);
    expect((await repo.getOverrideById(request.id))?.status).toBe("pending");
  });

  /*
   * The id arrives in a URL, so belonging to this organisation is a claim that
   * has to be proved. Answering 404 rather than 403 keeps the existence of
   * another tenant's request unconfirmed.
   */
  it("refuses another organisation's request", async () => {
    const other = await createTenant("leave-other");
    const otherMember = await prisma.membership.update({
      where: { id: other.staff.membershipId },
      data: { employmentType: "full_time" },
    });
    const theirs = await askForLeave(otherMember.id);

    asUser(tenant.admin.userId);
    const res = await reviewLeave(
      jsonReq("PATCH", { decision: "approved" }),
      ctx({ orgId: tenant.orgId, overrideId: theirs.id })
    );

    expect(res.status).toBe(404);
    expect((await repo.getOverrideById(theirs.id))?.status).toBe("pending");
  });
});
