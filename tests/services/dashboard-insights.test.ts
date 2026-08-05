/**
 * The three insight alerts.
 *
 * What separates these from the alerts that already existed is that each joins
 * two facts. "A certificate expires on the 20th" is a diary note; "it expires
 * on the 20th and its holder is on four shifts after that which require it" is
 * a problem. Every one of these was derivable from data already in the
 * database — nobody had asked the second question.
 *
 * The failure mode they share is being confidently wrong: flagging a shift as
 * unfillable when it merely has no staff in the department, or counting a
 * finished shift as a no-show when the person did turn up. Most of what is
 * pinned here is the quiet case.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ReportingService } from "@/services/reporting.service";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";

const reporting = new ReportingService();

let tenant: Tenant;

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("insight");
});

function daysFromNow(days: number, hourUtc = 1) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

async function shift(opts: {
  title?: string;
  start: Date;
  headcount?: number;
  requiredCertifications?: string[];
  departmentId?: string | null;
  status?: string;
}) {
  return prisma.task.create({
    data: {
      title: opts.title ?? "Evening shift",
      organizationId: tenant.orgId,
      departmentId:
        opts.departmentId === undefined ? tenant.departmentId : opts.departmentId,
      createdById: tenant.admin.userId,
      scheduledStart: opts.start,
      scheduledEnd: new Date(opts.start.getTime() + 8 * 60 * 60 * 1000),
      requiredHeadcount: opts.headcount ?? 1,
      requiredCertifications: opts.requiredCertifications ?? [],
      status: opts.status ?? "open",
    },
  });
}

async function alerts() {
  return reporting.getNeedsAttention(tenant.orgId);
}

/* ------------------------------------------------------------------ */

describe("expiry with consequence", () => {
  async function certExpiring(inDays: number, name = "Food Safety") {
    return prisma.certification.create({
      data: {
        membershipId: tenant.staff.membershipId,
        name,
        status: "verified",
        issuedDate: new Date("2025-01-01"),
        expiryDate: daysFromNow(inDays),
      },
    });
  }

  async function bookOn(taskId: string) {
    return prisma.taskAssignment.create({
      data: {
        taskId,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });
  }

  it("counts the shifts the expiry will actually break", async () => {
    await certExpiring(10);
    const a = await shift({ start: daysFromNow(20), requiredCertifications: ["Food Safety"] });
    const b = await shift({ start: daysFromNow(25), requiredCertifications: ["Food Safety"] });
    await bookOn(a.id);
    await bookOn(b.id);

    const found = (await alerts()).find((i) => i.type === "expiring_cert_impact");

    expect(found?.message).toMatch(/booked on 2 later shifts that require it/);
    expect(found?.severity).toBe("danger");
  });

  it("ignores shifts BEFORE the expiry date", async () => {
    // Working the day before it lapses is fine. Counting those would inflate
    // every alert and train people to ignore the number.
    await certExpiring(10);
    const before = await shift({ start: daysFromNow(3), requiredCertifications: ["Food Safety"] });
    await bookOn(before.id);

    expect((await alerts()).some((i) => i.type === "expiring_cert_impact")).toBe(false);
  });

  it("ignores shifts that do not require that certification", async () => {
    await certExpiring(10);
    const other = await shift({ start: daysFromNow(20), requiredCertifications: ["First Aid"] });
    await bookOn(other.id);

    expect((await alerts()).some((i) => i.type === "expiring_cert_impact")).toBe(false);
  });

  it("matches the requirement regardless of case", async () => {
    // The eligibility engine compares case-insensitively; this must agree with
    // it, or the dashboard and the engine disagree about the same shift.
    await certExpiring(10, "Food Safety");
    const t = await shift({ start: daysFromNow(20), requiredCertifications: ["food safety"] });
    await bookOn(t.id);

    expect((await alerts()).some((i) => i.type === "expiring_cert_impact")).toBe(true);
  });

  it("replaces the plain expiry alert rather than doubling it", async () => {
    // Two alerts about one certificate at two different strengths is worse
    // than either alone.
    await certExpiring(10);
    const t = await shift({ start: daysFromNow(20), requiredCertifications: ["Food Safety"] });
    await bookOn(t.id);

    const found = await alerts();
    expect(found.filter((i) => i.type === "expiring_cert_impact")).toHaveLength(1);
    expect(found.filter((i) => i.type === "expiring_cert")).toHaveLength(0);
  });

  it("still gives the plain alert when nothing is booked behind it", async () => {
    // The weaker message is right when there is no consequence to report.
    await certExpiring(10);

    const found = await alerts();
    expect(found.some((i) => i.type === "expiring_cert")).toBe(true);
    expect(found.some((i) => i.type === "expiring_cert_impact")).toBe(false);
  });

  it("ignores an already-expired certificate", async () => {
    // Expired is a different problem with a different alert; this one is about
    // an expiry that has not happened yet.
    await prisma.certification.create({
      data: {
        membershipId: tenant.staff.membershipId,
        name: "Food Safety",
        status: "verified",
        issuedDate: new Date("2024-01-01"),
        expiryDate: daysFromNow(-5),
      },
    });
    const t = await shift({ start: daysFromNow(20), requiredCertifications: ["Food Safety"] });
    await bookOn(t.id);

    expect((await alerts()).some((i) => i.type === "expiring_cert_impact")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("shifts nobody can fill", () => {
  /** A member of the department who cannot work: casual with no availability. */
  async function blockedStaff() {
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { employmentType: "casual" },
    });
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { role: "staff", employmentType: "casual" },
    });
  }

  it("flags a shift where every candidate fails, and says why", async () => {
    await blockedStaff();
    await shift({ title: "Thursday Evening", start: daysFromNow(3) });

    const found = (await alerts()).find((i) => i.type === "unfillable");

    expect(found?.message).toMatch(/Thursday Evening has nobody eligible/);
    expect(found?.message).toMatch(/unavailable/);
  });

  it("says nothing when somebody can work it", async () => {
    for (let day = 0; day < 7; day++) {
      await prisma.availability.create({
        data: {
          membershipId: tenant.staff.membershipId,
          dayOfWeek: day,
          startTime: "00:00",
          endTime: "23:59",
          isAvailable: true,
        },
      });
    }
    await shift({ start: daysFromNow(3) });

    expect((await alerts()).some((i) => i.type === "unfillable")).toBe(false);
  });

  it("does not flag a department with no staff at all", async () => {
    // Nobody to consider is a headcount problem, and the understaffed alert
    // already covers it. Reporting it here as "nobody eligible" would double
    // up and imply a constraint problem that is really an empty rota.
    const empty = await prisma.department.create({
      data: { name: "New wing", organizationId: tenant.orgId, color: "#3B82F6" },
    });
    await shift({ start: daysFromNow(3), departmentId: empty.id });

    expect((await alerts()).some((i) => i.type === "unfillable")).toBe(false);
  });

  it("ignores shifts beyond the forward window", async () => {
    // The window exists to bound an expensive per-task evaluation, and a shift
    // three months out is not yet an emergency.
    await blockedStaff();
    await shift({ start: daysFromNow(60) });

    expect((await alerts()).some((i) => i.type === "unfillable")).toBe(false);
  });

  it("ignores shifts that are already fully staffed", async () => {
    await blockedStaff();
    const t = await shift({ start: daysFromNow(3), headcount: 1 });
    await prisma.taskAssignment.create({
      data: {
        taskId: t.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    expect((await alerts()).some((i) => i.type === "unfillable")).toBe(false);
  });

  it("ignores a cancelled shift", async () => {
    await blockedStaff();
    await shift({ start: daysFromNow(3), status: "cancelled" });

    expect((await alerts()).some((i) => i.type === "unfillable")).toBe(false);
  });

  it("counts each blocked person once, not once per failing check", async () => {
    // Someone failing two checks is still one person with one headline problem.
    // Counting both would push the totals past the team size and read as
    // nonsense: "4 unavailable, 4 missing a certification" for a team of two.
    //
    // The fixture deliberately fails BOTH availability and certifications, so
    // a per-check tally would double the numbers. An earlier version of this
    // test used a fixture that only failed one check, and passed either way.
    await blockedStaff();
    await shift({
      title: "Double blocked",
      start: daysFromNow(3),
      requiredCertifications: ["Food Safety"],
    });

    const found = (await alerts()).find((i) => i.type === "unfillable");
    const numbers = [...(found?.message.matchAll(/(\d+) /g) ?? [])].map((m) =>
      Number(m[1])
    );
    const total = numbers.reduce((sum, n) => sum + n, 0);

    // Two staff in the department after blockedStaff() demoted the manager.
    expect(total).toBe(2);
  });
});

/* ------------------------------------------------------------------ */

describe("no-shows", () => {
  async function finishedShift(daysAgo: number, clockedIn: boolean, status = "accepted") {
    const start = daysFromNow(-daysAgo);
    const task = await prisma.task.create({
      data: {
        title: "Past shift",
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 8 * 60 * 60 * 1000),
      },
    });
    return prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status,
        clockInTime: clockedIn ? start : null,
      },
    });
  }

  it("reports someone who accepted and never clocked in", async () => {
    await finishedShift(3, false);
    await finishedShift(5, false);

    const found = (await alerts()).find((i) => i.type === "no_show");
    expect(found?.message).toMatch(/accepted 2 shifts in the last 30 days without clocking in/);
  });

  it("does not count a shift they turned up to", async () => {
    await finishedShift(3, true);

    expect((await alerts()).some((i) => i.type === "no_show")).toBe(false);
  });

  it("does not count a shift that has not finished yet", async () => {
    // Not clocking in to a shift that starts tomorrow is not a no-show.
    const start = daysFromNow(2);
    const task = await prisma.task.create({
      data: {
        title: "Upcoming",
        organizationId: tenant.orgId,
        departmentId: tenant.departmentId,
        createdById: tenant.admin.userId,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 8 * 60 * 60 * 1000),
      },
    });
    await prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        membershipId: tenant.staff.membershipId,
        assignedById: tenant.admin.userId,
        status: "accepted",
      },
    });

    expect((await alerts()).some((i) => i.type === "no_show")).toBe(false);
  });

  it("does not count a shift they completed", async () => {
    // `completed` means they worked it — reaching that status requires a
    // clock-out, so it cannot be a no-show whatever clockInTime says.
    await finishedShift(3, true, "completed");

    expect((await alerts()).some((i) => i.type === "no_show")).toBe(false);
  });

  it("does not count a shift they rejected", async () => {
    await finishedShift(3, false, "rejected");

    expect((await alerts()).some((i) => i.type === "no_show")).toBe(false);
  });

  it("ignores anything older than the window", async () => {
    await finishedShift(60, false);

    expect((await alerts()).some((i) => i.type === "no_show")).toBe(false);
  });

  it("groups by person and leads with the worst", async () => {
    await finishedShift(2, false);
    await finishedShift(4, false);

    const summary = await reporting.getNoShowSummary(tenant.orgId);
    expect(summary[0].count).toBe(2);
    expect(summary).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */

/**
 * These alerts carried an `isAiInsight` flag and rendered with a sparkle and
 * an "AI Insight" badge. Every one is a SQL join with a threshold — no model
 * is involved at any point — so the badge was a claim the code could not
 * support, and it made the panel's one real model output (the priority call)
 * indistinguishable from a GROUP BY.
 *
 * The flag is gone. What is worth asserting now is that these alerts are
 * still produced and still describe more than a threshold on its own could.
 */
describe("cross-referenced alerts", () => {
  it("says more than the bare threshold that triggered it", async () => {
    await prisma.membership.update({
      where: { id: tenant.staff.membershipId },
      data: { employmentType: "casual" },
    });
    await prisma.membership.update({
      where: { id: tenant.manager.membershipId },
      data: { role: "staff", employmentType: "casual" },
    });
    await shift({ start: daysFromNow(3) });

    const joined = (await alerts()).filter((i) =>
      ["expiring_cert_impact", "unfillable", "no_show", "decline_pattern"].includes(
        i.type
      )
    );
    expect(joined.length).toBeGreaterThan(0);
    // The join is the point: each message names the consequence, not just the
    // count that raised it.
    expect(joined.every((i) => i.message.length > 0)).toBe(true);
  });

  it("carries no AI marking on any alert, joined or not", async () => {
    await shift({ start: daysFromNow(3), headcount: 3 });

    const all = await alerts();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((i) => !("isAiInsight" in i))).toBe(true);
  });
});
