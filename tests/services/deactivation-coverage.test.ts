/**
 * What happens to somebody's future shifts when they are deactivated.
 *
 * Deactivation used to change the membership row and nothing else. The member
 * list said inactive, the rota said Tuesday 9am was staffed, and because the
 * shift still LOOKED full none of the shortfall machinery fired — no manager
 * found out until nobody turned up.
 *
 * The assertion that matters is not "the assignment was cancelled". It is that
 * the shift becomes honestly short, because every existing alert is downstream
 * of that. The tests are written against the roster, not against the release
 * function, for that reason.
 *
 * The mirror case is tested too: reactivating must NOT put anybody back on a
 * shift, since those assignments were cancelled and somebody else may hold them
 * now.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { UserManagementService } from "@/services/user-management.service";
import { TaskService } from "@/services/task.service";
import { OrganizationRepository } from "@/repositories/organization.repository";
import { UserRepository } from "@/repositories/user.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { declareOpenWeek } from "../helpers/fixtures";
import { todaySgtAt } from "../helpers/time";

vi.mock("@/services/email.service", () => ({
  EmailService: class {
    sendVerificationEmail = vi.fn().mockResolvedValue(undefined);
    sendPasswordResetEmail = vi.fn().mockResolvedValue(undefined);
    sendInvitationEmail = vi.fn().mockResolvedValue(undefined);
  },
}));

const userMgmt = new UserManagementService();
const taskService = new TaskService();
const orgRepo = new OrganizationRepository();
const userRepo = new UserRepository();

let orgId: string;
let adminUserId: string;
let deptId: string;
/** The person who gets deactivated. */
let leaverUserId: string;
let leaverMembershipId: string;
/** A second staff member, so a replacement is possible. */
let coverMembershipId: string;

/**
 * Far enough out that `isShortNotice` (48 hours) does not divert to the
 * "arrange cover directly" branch. Automation is what these tests are about.
 */
const SHIFT_DAY_OFFSET = 5;

async function setUp(allocationMode: string) {
  await cleanDatabase();

  const admin = await userRepo.create({
    name: "Admin",
    email: "admin@example.com",
    hashedPassword: "hash",
  });
  adminUserId = admin.id;

  const org = await orgRepo.create({ name: "Acme", slug: "acme" }, admin.id);
  orgId = org.id;

  // Enterprise, for the reason given in auto-schedule.service.test: the column
  // defaults to "free", and Free excludes the engine these tests drive.
  await prisma.organization.update({
    where: { id: orgId },
    data: { subscriptionTier: "enterprise" },
  });

  // Stated, never inherited — the column default moved once already and
  // silently put test tenants into auto-allocation.
  //
  // The TIER above is stated for the same reason and is now load-bearing too:
  // `allocationMode: "auto"` only produces auto-allocation on a plan that
  // includes it, so a Free tenant would take the manual branch instead.
  await prisma.companySettings.create({
    data: { organizationId: orgId, allocationMode, workingDayHours: 8 },
  });

  const dept = await prisma.department.create({
    data: { name: "Kitchen", organizationId: orgId, color: "#EF4444" },
  });
  deptId = dept.id;

  const made: string[] = [];
  for (const [index, name] of ["Leaver", "Cover"].entries()) {
    const user = await userRepo.create({
      name,
      email: `${name.toLowerCase()}@example.com`,
      hashedPassword: "hash",
    });
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: orgId,
        role: "staff",
        status: "active",
      },
    });
    await prisma.departmentMembership.create({
      data: { membershipId: membership.id, departmentId: deptId },
    });
    made.push(membership.id);
    if (index === 0) {
      leaverUserId = user.id;
      leaverMembershipId = membership.id;
    } else {
      coverMembershipId = membership.id;
    }
  }
  await declareOpenWeek(...made);
}

/** A future shift with the leaver on it. */
async function shiftHeldByLeaver(title = "Evening shift", startHour = 17) {
  const task = await taskService.create(
    {
      title,
      departmentId: deptId,
      scheduledStart: todaySgtAt(startHour, SHIFT_DAY_OFFSET).toISOString(),
      scheduledEnd: todaySgtAt(startHour + 2, SHIFT_DAY_OFFSET).toISOString(),
    },
    orgId,
    adminUserId
  );
  await taskService.assignStaff(
    task.id,
    orgId,
    [leaverMembershipId],
    adminUserId
  );
  return task;
}

/**
 * Put the organisation into auto mode once the shift already exists.
 *
 * Setting it up front does not work: `taskService.create` runs the allocation
 * engine in auto mode, so the shift arrives already staffed and the explicit
 * `assignStaff` in `shiftHeldByLeaver` is refused with "already has a record on
 * this task". Switching afterwards leaves the arrangement under test — a shift
 * held by the leaver, in an org that fills gaps automatically — without the
 * engine having had a say in building it.
 */
async function switchToAuto() {
  await prisma.companySettings.update({
    where: { organizationId: orgId },
    data: { allocationMode: "auto" },
  });
}

/** Assignments the leaver still counts as holding on a task. */
async function leaverCommitmentsOn(taskId: string) {
  return prisma.taskAssignment.findMany({
    where: {
      taskId,
      membershipId: leaverMembershipId,
      status: { notIn: ["cancelled"] },
    },
  });
}

describe("deactivating somebody releases their future shifts", () => {
  beforeEach(() => setUp("suggested"));

  it("takes them off a shift they were rostered on", async () => {
    const task = await shiftHeldByLeaver();
    expect(await leaverCommitmentsOn(task.id)).toHaveLength(1);

    await userMgmt.toggleMemberStatus(leaverUserId, orgId, adminUserId);

    expect(await leaverCommitmentsOn(task.id)).toHaveLength(0);
  });

  it("reports how many shifts it released", async () => {
    // The count is what the confirmation and the audit entry are built from —
    // "deactivated Alex" and "deactivated Alex and took them off two shifts"
    // are different events to anyone reading it back.
    // Different hours: two shifts at the same time are a scheduling conflict
    // and the second assignment would be refused before we got to the point.
    await shiftHeldByLeaver("First", 9);
    await shiftHeldByLeaver("Second", 17);

    const result = await userMgmt.toggleMemberStatus(
      leaverUserId,
      orgId,
      adminUserId
    );

    expect(result.releasedShifts).toBe(2);
  });

  it("records the count on the audit entry", async () => {
    await shiftHeldByLeaver();

    await userMgmt.toggleMemberStatus(leaverUserId, orgId, adminUserId);

    const [entry] = await prisma.auditLog.findMany({
      where: { organizationId: orgId, action: "member.deactivated" },
    });
    expect(entry.details).toMatchObject({ releasedShifts: 1 });
  });

  it("tells somebody the shift now needs cover", async () => {
    // The whole point. A released shift that nobody is told about is the same
    // silence the phantom coverage produced, arrived at differently.
    await shiftHeldByLeaver();

    await userMgmt.toggleMemberStatus(leaverUserId, orgId, adminUserId);

    const notifications = await prisma.notification.findMany({
      where: { organizationId: orgId },
    });
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.map((n) => n.message).join(" ")).toMatch(
      /deactivated and has come off/
    );
  });

  it("says deactivated, not that their leave was approved", async () => {
    // `findCover` opened every notification with "their leave was approved",
    // because leave was its only caller when it was written.
    await shiftHeldByLeaver();

    await userMgmt.toggleMemberStatus(leaverUserId, orgId, adminUserId);

    const bodies = (
      await prisma.notification.findMany({ where: { organizationId: orgId } })
    )
      .map((n) => n.message)
      .join(" ");
    expect(bodies).not.toMatch(/leave was approved/);
  });

  it("leaves shifts that have already happened alone", async () => {
    /*
     * A past shift was worked. Cancelling the assignment would rewrite history
     * — the hours are the basis of the completed-shift counts and of anything
     * built on them.
     */
    const past = await taskService.create(
      {
        title: "Last week",
        departmentId: deptId,
        scheduledStart: todaySgtAt(9, -7).toISOString(),
        scheduledEnd: todaySgtAt(13, -7).toISOString(),
      },
      orgId,
      adminUserId
    );
    await taskService.assignStaff(
      past.id,
      orgId,
      [leaverMembershipId],
      adminUserId
    );

    await userMgmt.toggleMemberStatus(leaverUserId, orgId, adminUserId);

    expect(await leaverCommitmentsOn(past.id)).toHaveLength(1);
  });
});

describe("in auto mode it offers the shift to somebody else", () => {
  beforeEach(() => setUp("suggested"));

  it("offers the released shift to the best replacement", async () => {
    const task = await shiftHeldByLeaver();
    await switchToAuto();

    await userMgmt.toggleMemberStatus(leaverUserId, orgId, adminUserId);

    const offered = await prisma.taskAssignment.findMany({
      where: { taskId: task.id, membershipId: coverMembershipId },
    });
    expect(offered).toHaveLength(1);
  });

  it("offers it rather than booking them in", async () => {
    // The engine finds the person; the person still chooses. Same rule the
    // leave path follows — nobody is put on a shift without agreeing to it.
    const task = await shiftHeldByLeaver();
    await switchToAuto();

    await userMgmt.toggleMemberStatus(leaverUserId, orgId, adminUserId);

    const [offer] = await prisma.taskAssignment.findMany({
      where: { taskId: task.id, membershipId: coverMembershipId },
    });
    expect(offer.status).not.toBe("accepted");
  });
});

describe("reactivating does not undo it", () => {
  beforeEach(() => setUp("suggested"));

  it("does not put them back on the shifts they were released from", async () => {
    /*
     * The assignments were cancelled and somebody else may hold them now.
     * Silently reclaiming them would overwrite a roster a manager has since
     * fixed by hand — and the person coming back is not necessarily available
     * for what they were booked on weeks ago.
     */
    const task = await shiftHeldByLeaver();
    await userMgmt.toggleMemberStatus(leaverUserId, orgId, adminUserId);

    await userMgmt.toggleMemberStatus(leaverUserId, orgId, adminUserId);

    expect(await leaverCommitmentsOn(task.id)).toHaveLength(0);
  });

  it("reports nothing released, because reactivating releases nothing", async () => {
    await shiftHeldByLeaver();
    await userMgmt.toggleMemberStatus(leaverUserId, orgId, adminUserId);

    const result = await userMgmt.toggleMemberStatus(
      leaverUserId,
      orgId,
      adminUserId
    );

    expect(result.releasedShifts).toBe(0);
    expect(result.status).toBe("active");
  });
});
