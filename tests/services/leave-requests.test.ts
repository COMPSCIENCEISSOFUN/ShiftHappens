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
import { eventually, pauseForAbsence } from "../helpers/settle";
import { atHourSgt, nextWeekdaySgt } from "../helpers/time";

const service = new AvailabilityService();
const repo = new AvailabilityRepository();

/*
 * A Friday, derived rather than named.
 *
 * This file was built on the literal 14 August 2026 — a Friday, matched by the
 * `dayOfWeek: 5` availability rows below. `createOverride` refuses a date
 * already past, so every test here that asks for leave would have started
 * failing on 15 August 2026 and kept failing, with an error message about
 * validation that says nothing about the calendar.
 *
 * The weekday still has to BE Friday, because the availability fixtures are
 * keyed on it. `nextWeekdaySgt(5)` gives the next one in the organisation's
 * timezone, so the fixture and the rule agree on which day that is at every
 * hour of every run.
 */
const FRIDAY = nextWeekdaySgt(5);
const DATE = atHourSgt(FRIDAY, 12).toISOString();
/** That Friday, 10:00 Singapore time. */
const SHIFT_DAY = atHourSgt(FRIDAY, 10);
/** The Saturday after it — the second day of an overnight Friday shift. */
const NEXT_DAY = atHourSgt(FRIDAY, 36).toISOString();

/** Singapore wall-clock hours on the fixture's Friday, as ISO instants. */
const at = (hour: number) => atHourSgt(FRIDAY, hour).toISOString();
/** The same hours a week later, for "a different day" assertions. */
const weekLater = (hour: number) =>
  atHourSgt(new Date(FRIDAY.getTime() + 7 * 86_400_000), hour).toISOString();

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

/*
 * The two directions are not symmetrical.
 *
 * Asking for time off is an exception to a contract. Asking to work a day you
 * are not contracted for is asking to CHANGE the contract, and that belongs to
 * whoever sets the contracted days — not to a form the member fills in.
 */
/*
 * Proving the request belongs to the reviewer used to happen in the ROUTE,
 * which read AvailabilityRepository and MembershipRepository directly to do it
 * — Boundary reaching Entity. Moved into the service, so these assert where the
 * rule now lives rather than at the one endpoint that happened to enforce it.
 */
describe("whose leave a reviewer may answer", () => {
  it("refuses a request belonging to another organisation", async () => {
    const request = await askForLeave(fullTimer);
    const other = await createTenant("leave-other");

    await expect(
      service.reviewLeave(request.id, "approved", other.admin.userId, other.orgId)
    ).rejects.toThrow("Leave request not found");
  });

  it("refuses a member outside the reviewer's departments", async () => {
    const request = await askForLeave(fullTimer);
    const elsewhere = await prisma.department.create({
      data: { name: "Elsewhere", organizationId: tenant.orgId },
    });

    await expect(
      service.reviewLeave(request.id, "approved", tenant.manager.userId, tenant.orgId, [
        elsewhere.id,
      ])
    ).rejects.toThrow("Leave request not found");
  });

  it("allows a reviewer whose scope covers them", async () => {
    const request = await askForLeave(fullTimer);

    const reviewed = await service.reviewLeave(
      request.id,
      "approved",
      tenant.manager.userId,
      tenant.orgId,
      [tenant.departmentId]
    );
    expect(reviewed.status).toBe("approved");
  });

  /*
   * Reachable only because a MANAGER can be full-time. Full-timers must request
   * time off, managers hold the permission to grant it, and a manager reviewing
   * their own request passes every other gate — same organisation, and they are
   * trivially inside their own department scope. The request-and-approve flow
   * collapsed into a formality with extra steps for exactly the people senior
   * enough to need watching.
   */
  it("refuses a manager approving their own request", async () => {
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { employmentType: "full_time" },
    });
    const request = await askForLeave(tenant.manager.membershipId);

    await expect(
      service.reviewLeave(
        request.id,
        "approved",
        tenant.manager.userId,
        tenant.orgId,
        [tenant.departmentId]
      )
    ).rejects.toThrow(/your own leave/);
  });

  // Rejecting it is the same act of judgement on the same request.
  it("refuses them rejecting it either", async () => {
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { employmentType: "full_time" },
    });
    const request = await askForLeave(tenant.manager.membershipId);

    await expect(
      service.reviewLeave(
        request.id,
        "rejected",
        tenant.manager.userId,
        tenant.orgId,
        [tenant.departmentId]
      )
    ).rejects.toThrow(/your own leave/);
  });

  it("leaves the request untouched when it refuses", async () => {
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { employmentType: "full_time" },
    });
    const request = await askForLeave(tenant.manager.membershipId);

    await service
      .reviewLeave(request.id, "approved", tenant.manager.userId, tenant.orgId, [
        tenant.departmentId,
      ])
      .catch(() => {});

    const row = await prisma.availabilityOverride.findUnique({
      where: { id: request.id },
    });
    expect(row?.status).toBe("pending");
    expect(row?.reviewedById).toBeNull();
  });

  /*
   * And it never deadlocks. Every organisation has at least one company admin —
   * whoever created it became one — so a sole manager still has somebody to ask.
   */
  it("still lets an admin answer that same request", async () => {
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { employmentType: "full_time" },
    });
    const request = await askForLeave(tenant.manager.membershipId);

    const reviewed = await service.reviewLeave(
      request.id,
      "approved",
      tenant.admin.userId,
      tenant.orgId,
      null
    );
    expect(reviewed.status).toBe("approved");
  });

  // An unscoped reviewer is a company admin.
  it("allows an unscoped reviewer", async () => {
    const request = await askForLeave(fullTimer);

    const reviewed = await service.reviewLeave(
      request.id,
      "approved",
      tenant.admin.userId,
      tenant.orgId,
      null
    );
    expect(reviewed.status).toBe("approved");
  });

  it("leaves the request pending when it refuses", async () => {
    const request = await askForLeave(fullTimer);
    const other = await createTenant("leave-other2");

    await service
      .reviewLeave(request.id, "approved", other.admin.userId, other.orgId)
      .catch(() => {});

    const after = await prisma.availabilityOverride.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.status).toBe("pending");
  });
});

describe("which direction a contracted member may ask for", () => {
  it("refuses a full-time member asking to work a day", async () => {
    await expect(
      service.createOverride(fullTimer, {
        date: DATE,
        isAvailable: true,
        reason: "Happy to cover",
      })
    ).rejects.toThrow("Contracted days are set by your organisation");
  });

  it("writes nothing when it refuses", async () => {
    await service
      .createOverride(fullTimer, { date: DATE, isAvailable: true })
      .catch(() => {});

    const rows = await prisma.availabilityOverride.findMany({
      where: { membershipId: fullTimer },
    });
    expect(rows).toHaveLength(0);
  });

  it("still allows them to ask for the day off", async () => {
    const created = await askForLeave(fullTimer);
    expect(created.status).toBe("pending");
  });

  // A casual's availability is an offer, so widening it is theirs to do.
  it("lets a casual member widen their own availability", async () => {
    const created = await service.createOverride(tenant.staff.membershipId, {
      date: DATE,
      isAvailable: true,
      reason: "Free that day",
    });
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

    await service.reviewLeave(request.id, "approved", tenant.admin.userId, tenant.orgId);

    const check = await repo.isAvailableAt(fullTimer, SHIFT_DAY, "10:00", "14:00");
    expect(check.available).toBe(false);
  });

  // A rejected row is inert in the same way a pending one is — it must not
  // linger as a half-applied absence.
  it("rejecting leaves them on the roster", async () => {
    const request = await askForLeave(fullTimer);

    await service.reviewLeave(request.id, "rejected", tenant.admin.userId, tenant.orgId);

    const check = await repo.isAvailableAt(fullTimer, SHIFT_DAY, "10:00", "14:00");
    expect(check.available).toBe(true);
  });
});

describe("reviewing", () => {
  it("records who decided", async () => {
    const request = await askForLeave(fullTimer);
    await service.reviewLeave(request.id, "approved", tenant.admin.userId, tenant.orgId);

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
    await service.reviewLeave(request.id, "approved", tenant.admin.userId, tenant.orgId);

    await expect(
      service.reviewLeave(request.id, "rejected", tenant.admin.userId, tenant.orgId)
    ).rejects.toThrow(/already been reviewed/);
  });

  /*
   * Re-submitting clears the old verdict. A member who is told no, and asks
   * again for the same date with a better reason, must not be carrying a
   * rejection that was about the first attempt.
   */
  it("resets a rejected request to pending when it is asked again", async () => {
    const request = await askForLeave(fullTimer);
    await service.reviewLeave(request.id, "rejected", tenant.admin.userId, tenant.orgId);

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
    // Absence, so this has to be a pause — see helpers/settle.
    await pauseForAbsence(300);

    const theirs = await prisma.notification.count({
      where: { userId: outsider.id, type: "leave_requested" },
    });
    expect(theirs).toBe(0);
  });

  // Admins are unscoped — `departmentScopeFor` returns null for them — so they
  // can approve anything and must always hear about it.
  it("always notifies an admin", async () => {
    await askForLeave(fullTimer);

    const theirs = await eventually(
      () =>
        prisma.notification.count({
          where: { userId: tenant.admin.userId, type: "leave_requested" },
        }),
      (count) => count >= 1
    );
    expect(theirs).toBe(1);
  });
});

describe("what the assign screen is told", () => {
  async function shift(startISO: string, endISO: string) {
    return prisma.task.create({
      data: {
        title: "Evening service",
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
        status: "open",
        requiredHeadcount: 2,
        scheduledStart: new Date(startISO),
        scheduledEnd: new Date(endISO),
      },
    });
  }

  it("reports a pending request covering the shift's day", async () => {
    await askForLeave(fullTimer);
    // The fixture's Friday, 10:00–14:00 Singapore.
    const task = await shift(at(10), at(14));

    const flagged = await service.getPendingLeaveForTask(task.id, tenant.orgId);
    expect(flagged.map((f) => f.membershipId)).toEqual([fullTimer]);
  });

  it("says nothing about a different day", async () => {
    await askForLeave(fullTimer);
    const task = await shift(weekLater(10), weekLater(14));

    expect(await service.getPendingLeaveForTask(task.id, tenant.orgId)).toEqual([]);
  });

  // Decided requests are not warnings. An approved one already removes the
  // person from the roster, and a rejected one is inert.
  it("drops it once it has been decided", async () => {
    const request = await askForLeave(fullTimer);
    await service.reviewLeave(request.id, "rejected", tenant.admin.userId, tenant.orgId);
    const task = await shift(at(10), at(14));

    expect(await service.getPendingLeaveForTask(task.id, tenant.orgId)).toEqual([]);
  });

  /*
   * A shift crossing midnight occupies two calendar days and somebody can have
   * asked for either. The same reasoning as the overnight availability fix —
   * warning on only the start date would miss exactly the request that matters
   * for a closing shift.
   */
  it("covers the second day of a shift that crosses midnight", async () => {
    // Leave on the Saturday; the shift runs Friday 22:00 – Saturday 02:00
    // Singapore, so hour 26 is 02:00 on the second day.
    await service.createOverride(fullTimer, {
      date: NEXT_DAY,
      isAvailable: false,
      reason: "Away",
    });
    const task = await shift(at(22), at(26));

    const flagged = await service.getPendingLeaveForTask(task.id, tenant.orgId);
    expect(flagged.map((f) => f.membershipId)).toEqual([fullTimer]);
  });

  it("refuses another organisation's task", async () => {
    const other = await createTenant("leave-task-other");
    const theirs = await prisma.task.create({
      data: {
        title: "Theirs",
        organizationId: other.orgId,
        createdById: other.admin.userId,
        status: "open",
        scheduledStart: new Date(at(10)),
        scheduledEnd: new Date(at(14)),
      },
    });

    await expect(
      service.getPendingLeaveForTask(theirs.id, tenant.orgId)
    ).rejects.toThrow("Task not found");
  });
});

describe("the review endpoint", () => {
  it("lists what is waiting", async () => {
    await askForLeave(fullTimer);

    asUser(tenant.admin.userId);
    const res = await listLeave(req("GET"), ctx({ orgId: tenant.orgId }));
    const body = await bodyOf(res);

    expect(res.status).toBe(200);
    // `{ rows, total, counts, ... }` since the queue became a register.
    expect(body.rows).toHaveLength(1);
    // `toMatchObject` rather than reaching into `body.counts.awaiting`:
    // `bodyOf` returns Record<string, unknown>, so the second hop needs a cast,
    // and a cast in a test is a claim about a shape nothing is checking.
    expect(body.counts).toMatchObject({ awaiting: 1 });
  });

  // Approved and rejected rows are decided, not waiting. A list that kept them
  // would grow forever and stop being a to-do.
  it("stops listing one once it is decided", async () => {
    const request = await askForLeave(fullTimer);
    await service.reviewLeave(request.id, "approved", tenant.admin.userId, tenant.orgId);

    asUser(tenant.admin.userId);
    const res = await listLeave(req("GET"), ctx({ orgId: tenant.orgId }));

    // Gone from the DEFAULT view, which is what is awaiting a decision. The
    // register can still be asked for it — see the leave-register tests.
    expect((await bodyOf(res)).rows).toHaveLength(0);
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
