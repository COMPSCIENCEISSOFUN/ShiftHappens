/**
 * The leave register: history, filters, and the one thing filters can break.
 *
 * The page used to list only what was awaiting a decision, which made "was
 * Sam's July leave approved, and by whom" answerable nowhere but the audit log.
 * Showing decided requests makes the list unusable without filters, and adding
 * a DEPARTMENT filter to a department-scoped endpoint is precisely the shape
 * the 2026-08-05 audit found four times: a scope taken from the query string.
 *
 * So the assertions here are in two groups. What the filters return, and — the
 * ones that matter — that a filter can only ever narrow what the reader was
 * already allowed to see.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { AvailabilityService } from "@/services/availability.service";
import { overrideDateKey } from "@/repositories/availability.repository";
import { prisma } from "@/lib/prisma";
import { cleanDatabase } from "../helpers/cleanup";
import { createTenant, type Tenant } from "../helpers/fixtures";
import { todaySgtAt } from "../helpers/time";

const service = new AvailabilityService();

let tenant: Tenant;
let kitchen: string;
let bar: string;
/** A full-timer in Kitchen and one in Bar, so scope has something to separate. */
let kitchenStaff: string;
let barStaff: string;

async function member(name: string, departmentId: string) {
  const user = await prisma.user.create({
    data: { name, email: `${name.toLowerCase()}@reg.test`, hashedPassword: "h" },
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
    data: { membershipId: membership.id, departmentId },
  });
  return membership.id;
}

beforeEach(async () => {
  await cleanDatabase();
  tenant = await createTenant("register");
  kitchen = tenant.departmentId;
  const other = await prisma.department.create({
    data: { name: "Bar", organizationId: tenant.orgId, color: "#F59E0B" },
  });
  bar = other.id;
  kitchenStaff = await member("Sarah", kitchen);
  barStaff = await member("Dana", bar);
});

/**
 * A calendar day, as the filters take them.
 *
 * `parseDateRange` accepts `YYYY-MM-DD` and nothing else, so a bare
 * `toISOString()` is refused — correctly. A timestamp in a day filter has to be
 * resolved against SOME timezone, and choosing one silently is the bug the
 * whole date-range rule exists to stop. Slicing here rather than at each call
 * site so the next test cannot make the same mistake.
 */
const day = (dayOffset: number) =>
  todaySgtAt(12, dayOffset).toISOString().slice(0, 10);

function row(
  membershipId: string,
  dayOffset: number,
  status: string,
  reviewed = false
) {
  return prisma.availabilityOverride.create({
    data: {
      membershipId,
      date: overrideDateKey(todaySgtAt(12, dayOffset)),
      isAvailable: false,
      reason: "Away",
      status,
      reviewedById: reviewed ? tenant.admin.userId : null,
    },
  });
}

describe("what each view returns", () => {
  it("separates the live pile from the lapsed one", async () => {
    await row(kitchenStaff, 5, "pending");
    await row(barStaff, -5, "pending");

    const live = await service.getLeaveRegister(tenant.orgId, null, {
      view: "awaiting",
    });
    const lapsed = await service.getLeaveRegister(tenant.orgId, null, {
      view: "lapsed",
    });
    const both = await service.getLeaveRegister(tenant.orgId, null, {
      view: "pending",
    });

    expect(live.total).toBe(1);
    expect(lapsed.total).toBe(1);
    expect(both.total).toBe(2);
  });

  /*
   * The distinction the whole register turns on.
   *
   * A casual member's override is written `approved` the instant they save it,
   * with no reviewer — it is availability, not a decision. Counting those as
   * approved leave would bury every real verdict under everybody's ordinary
   * schedule edits, and the count beside the list would be a count of the wrong
   * thing entirely.
   */
  it("counts only reviewed rows as approved leave", async () => {
    await row(kitchenStaff, -3, "approved", true); // a manager approved this
    await row(barStaff, -3, "approved", false); // a casual just saved this

    const approved = await service.getLeaveRegister(tenant.orgId, null, {
      view: "approved",
    });

    expect(approved.total).toBe(1);
    expect(approved.rows[0].membership.id).toBe(kitchenStaff);
  });

  it("leaves an unreviewed override out of the register entirely", async () => {
    await row(barStaff, -3, "approved", false);

    const all = await service.getLeaveRegister(tenant.orgId, null, {
      view: "all",
    });

    expect(all.total).toBe(0);
  });

  it("finds a person by name, case-insensitively", async () => {
    await row(kitchenStaff, 5, "pending");
    await row(barStaff, 5, "pending");

    const found = await service.getLeaveRegister(tenant.orgId, null, {
      view: "pending",
      search: "sarah",
    });

    expect(found.rows.map((r) => r.membership.id)).toEqual([kitchenStaff]);
  });

  /*
   * A date range must NARROW a view, never widen it. "Lapsed" is already
   * bounded to dates before today; a range ending next month must not pull
   * future requests into it, which is what a naively spread `date` clause does
   * — the second key silently replaces the first.
   */
  it("keeps a view's own date bound when a range is added", async () => {
    await row(kitchenStaff, -5, "pending");
    await row(barStaff, 20, "pending");

    const lapsed = await service.getLeaveRegister(tenant.orgId, null, {
      view: "lapsed",
      to: day(40),
    });

    expect(lapsed.rows.map((r) => r.membership.id)).toEqual([kitchenStaff]);
  });
});

describe("a date range the server will not accept", () => {
  /*
   * Refused in the SERVICE, not only in the browser. The register component
   * blocks it before fetching — that is manners — but a hand-written URL
   * reaches this directly, and a reversed range applied silently returns an
   * empty page that reads as "there is no leave that month".
   */
  it("refuses a range that ends before it starts", async () => {
    await expect(
      service.getLeaveRegister(tenant.orgId, null, {
        view: "all",
        from: "2026-08-20",
        to: "2026-08-01",
      })
    ).rejects.toThrow(/end date is before/i);
  });

  it("refuses a day the calendar does not have", async () => {
    await expect(
      service.getLeaveRegister(tenant.orgId, null, {
        view: "all",
        from: "2026-02-31",
      })
    ).rejects.toThrow(/not a date/i);
  });

  it("still accepts one bound on its own", async () => {
    await row(kitchenStaff, 5, "pending");

    const out = await service.getLeaveRegister(tenant.orgId, null, {
      view: "pending",
      from: day(1),
    });

    expect(out.rows).toHaveLength(1);
  });
});

describe("a filter can only narrow the reader's scope", () => {
  it("returns nothing when a scoped reader names a department they do not hold", async () => {
    await row(barStaff, 5, "pending");

    // A Kitchen manager, asking for Bar.
    const out = await service.getLeaveRegister(tenant.orgId, [kitchen], {
      view: "pending",
      departmentId: bar,
    });

    expect(out.rows).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("still hides other departments when no filter is given", async () => {
    await row(kitchenStaff, 5, "pending");
    await row(barStaff, 5, "pending");

    const out = await service.getLeaveRegister(tenant.orgId, [kitchen], {
      view: "pending",
    });

    expect(out.rows.map((r) => r.membership.id)).toEqual([kitchenStaff]);
  });

  it("lets an unrestricted reader narrow to one department", async () => {
    await row(kitchenStaff, 5, "pending");
    await row(barStaff, 5, "pending");

    const out = await service.getLeaveRegister(tenant.orgId, null, {
      view: "pending",
      departmentId: bar,
    });

    expect(out.rows.map((r) => r.membership.id)).toEqual([barStaff]);
  });
});

describe("the badge count", () => {
  /*
   * `counts.awaiting` answers the sidebar, which is about the reader's whole
   * scope. Reading it off the filtered list would make the badge fall to zero
   * the moment a manager switched the page to "Approved" — a number going down
   * because somebody looked at something else, which is the most reassuring
   * possible way to be wrong.
   */
  it("does not move when the page is filtered", async () => {
    await row(kitchenStaff, 5, "pending");
    await row(barStaff, 5, "pending");

    const filtered = await service.getLeaveRegister(tenant.orgId, null, {
      view: "approved",
      departmentId: bar,
    });

    expect(filtered.rows).toHaveLength(0);
    expect(filtered.counts.awaiting).toBe(2);
  });

  it("counts live requests only, never lapsed ones", async () => {
    await row(kitchenStaff, 5, "pending");
    await row(barStaff, -5, "pending");

    const out = await service.getLeaveRegister(tenant.orgId, null, {
      view: "pending",
    });

    expect(out.total).toBe(2);
    expect(out.counts.awaiting).toBe(1);
    // Its own tile above the list, because lapsed requests are invisible by
    // nature: nobody goes looking for a filter they do not know has anything
    // behind it, and accumulating unseen is the defect this page answers.
    expect(out.counts.lapsed).toBe(1);
  });

  /*
   * The decided tiles come off the same `where` builder as the list. Counted by
   * hand they were two more copies of "what does approved mean here" — and the
   * answer is not `status = "approved"`, which is the trap this whole register
   * turns on.
   */
  it("counts the decided tiles the way the list defines them", async () => {
    await row(kitchenStaff, -4, "approved", true);
    await row(barStaff, -4, "approved", false); // casual, never reviewed
    await row(kitchenStaff, -6, "rejected", true);

    const out = await service.getLeaveRegister(tenant.orgId, null, {
      view: "all",
    });

    expect(out.counts.approved).toBe(1);
    expect(out.counts.declined).toBe(1);
  });

  it("is scoped like everything else", async () => {
    await row(barStaff, 5, "pending");

    const out = await service.getLeaveRegister(tenant.orgId, [kitchen], {
      view: "pending",
    });

    expect(out.counts.awaiting).toBe(0);
  });
});

describe("paging", () => {
  /*
   * `total` is a second query against the same filter, not `rows.length`. A
   * page reporting its own size would say "3 requests" over a filter matching
   * far more, which reads as complete coverage — the silent-cap failure.
   */
  it("reports the size of the match, not the size of the page", async () => {
    for (let i = 1; i <= 4; i++) await row(kitchenStaff, i, "pending");

    const page = await service.getLeaveRegister(tenant.orgId, null, {
      view: "pending",
    });

    expect(page.total).toBe(4);
    expect(page.pageSize).toBeGreaterThanOrEqual(4);
  });

  it("treats a nonsense page number as the first page", async () => {
    await row(kitchenStaff, 3, "pending");

    const out = await service.getLeaveRegister(tenant.orgId, null, {
      view: "pending",
      page: -7,
    });

    expect(out.page).toBe(1);
    expect(out.rows).toHaveLength(1);
  });
});
