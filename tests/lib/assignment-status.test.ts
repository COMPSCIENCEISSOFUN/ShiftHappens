/**
 * The slot-occupancy rule.
 *
 * This module exists because the same question — does this assignment still
 * hold a seat on the shift? — was answered by seven hand-written status lists,
 * and three of them disagreed. The tests below pin the rule itself; the tests
 * that pin the pages and queries using it live beside those.
 */
import { describe, it, expect } from "vitest";
import {
  ASSIGNMENT_STATUSES,
  OCCUPYING_STATUSES,
  RELEASED_STATUSES,
  canHoldClockTimes,
  countOccupied,
  occupiesSlot,
  occupyingStatusFilter,
  remainingFromOccupied,
  remainingSlots,
} from "@/lib/assignment-status";

describe("canHoldClockTimes", () => {
  /*
   * The bug: the tasks page gated "Add times" on the permission alone, so it
   * appeared beside a REJECTED assignment. A manager could record hours for
   * somebody who was never on the shift, against the column every hours total
   * and capacity figure is built from.
   */
  it("refuses the three statuses that were never accepted", () => {
    expect(canHoldClockTimes("pending")).toBe(false);
    expect(canHoldClockTimes("rejected")).toBe(false);
    expect(canHoldClockTimes("decline_requested")).toBe(false);
  });

  it("allows the ones that follow an acceptance", () => {
    expect(canHoldClockTimes("accepted")).toBe(true);
    expect(canHoldClockTimes("clocked_out")).toBe(true);
    expect(canHoldClockTimes("completed")).toBe(true);
    expect(canHoldClockTimes("withdrawal_requested")).toBe(true);
  });

  /*
   * Withdrawn releases the slot but still allows correction, which is the one
   * place this predicate and `occupiesSlot` deliberately disagree: a member can
   * clock in and then ask to leave, so the times exist. Asserted explicitly so
   * the divergence reads as a decision rather than an oversight.
   */
  it("allows a withdrawn assignment, unlike occupiesSlot", () => {
    expect(canHoldClockTimes("withdrawn")).toBe(true);
    expect(occupiesSlot("withdrawn")).toBe(false);
  });

  /*
   * Every status in the lifecycle is decided one way or the other. A status
   * added later without a decision here would default to allowed, so this is
   * the test that notices.
   */
  it("has an answer for every status in the lifecycle", () => {
    for (const status of ASSIGNMENT_STATUSES) {
      expect(typeof canHoldClockTimes(status)).toBe("boolean");
    }
    const allowed = ASSIGNMENT_STATUSES.filter(canHoldClockTimes);
    expect(allowed).toHaveLength(ASSIGNMENT_STATUSES.length - 3);
  });

  // Unknown statuses are allowed, matching `occupiesSlot`'s reasoning: the
  // safe direction is offering a manager a control they do not need rather
  // than hiding one they do.
  it("allows an unrecognised status", () => {
    expect(canHoldClockTimes("something_new")).toBe(true);
  });
});

describe("occupiesSlot", () => {
  it("releases the slot only for rejected and withdrawn", () => {
    expect(occupiesSlot("rejected")).toBe(false);
    expect(occupiesSlot("withdrawn")).toBe(false);
  });

  it("holds the slot for everything else in the lifecycle", () => {
    for (const status of ["pending", "accepted", "clocked_out", "completed"]) {
      expect(occupiesSlot(status)).toBe(true);
    }
  });

  /**
   * Both request states hold the seat. A request is a question put to a
   * manager, not an answer — freeing the slot would let the engine offer it to
   * someone else while the original assignee is still expected to turn up.
   */
  it("holds the slot while a decision is pending", () => {
    expect(occupiesSlot("decline_requested")).toBe(true);
    expect(occupiesSlot("withdrawal_requested")).toBe(true);
  });

  // Statuses arrive from res.json() and from Prisma as plain strings, so an
  // unrecognised one is reachable. It counts, which is the safe direction:
  // over-counting shows a shift as full and prompts someone to look, while
  // under-counting silently invites a double-booking.
  it("treats an unknown status as occupying", () => {
    expect(occupiesSlot("something_new")).toBe(true);
  });
});

describe("the two sets", () => {
  it("partition the lifecycle exactly", () => {
    expect([...OCCUPYING_STATUSES, ...RELEASED_STATUSES].sort()).toEqual(
      [...ASSIGNMENT_STATUSES].sort()
    );
  });

  it("do not overlap", () => {
    const released = new Set<string>(RELEASED_STATUSES);
    expect(OCCUPYING_STATUSES.some((s) => released.has(s))).toBe(false);
  });

  // Prisma's generated types want a mutable string[]; handing it the frozen
  // constant would either fail to compile or expose it to mutation.
  it("hands the query layer a fresh array each time", () => {
    const a = occupyingStatusFilter();
    const b = occupyingStatusFilter();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("countOccupied", () => {
  /**
   * The bug that started this. The tasks page counted `assignments.length`, so
   * a shift both assignees had rejected rendered "2/3 staff" while the
   * dashboard read the same shift as "0/3 assigned".
   */
  it("does not count rejected assignments", () => {
    expect(
      countOccupied([{ status: "rejected" }, { status: "rejected" }])
    ).toBe(0);
  });

  it("counts a shift in progress as filled", () => {
    expect(
      countOccupied([{ status: "clocked_out" }, { status: "completed" }])
    ).toBe(2);
  });

  it("counts a pending decision, and stops counting once it is approved", () => {
    expect(countOccupied([{ status: "decline_requested" }])).toBe(1);
    expect(countOccupied([{ status: "rejected" }])).toBe(0);
  });

  it("returns zero for no assignments", () => {
    expect(countOccupied([])).toBe(0);
  });
});

/**
 * The assign panel's ceiling.
 *
 * It capped selection at `requiredHeadcount`, ignoring who was already on the
 * shift. On a shift needing 3 with 1 assigned it let a manager select 3 more,
 * and the AI picks auto-selected 3 — both of which `assignStaff` refuses, so
 * the panel proposed an over-selection and then reported the server's refusal.
 */
describe("remainingSlots", () => {
  it("subtracts the people already on the shift", () => {
    expect(
      remainingSlots(3, [{ status: "accepted" }, { status: "pending" }])
    ).toBe(1);
  });

  it("ignores people who gave the slot back", () => {
    expect(
      remainingSlots(3, [{ status: "rejected" }, { status: "withdrawn" }])
    ).toBe(3);
  });

  it("counts a pending decline against the seats", () => {
    expect(remainingSlots(2, [{ status: "decline_requested" }])).toBe(1);
  });

  it("is zero, not negative, on a shift whose headcount was cut below its roster", () => {
    // Legitimately reachable: assignStaff blocks over-assignment, but nothing
    // stops an admin editing requiredHeadcount downward afterwards. A negative
    // here would flow into a selection cap and a "need -1 more" badge.
    expect(
      remainingSlots(1, [{ status: "accepted" }, { status: "accepted" }])
    ).toBe(0);
  });

  it("is the full headcount when nobody is assigned", () => {
    expect(remainingSlots(4, [])).toBe(4);
  });
});

/*
 * The count-taking half, tested separately because it has callers of its own.
 *
 * Three screens hold the occupied count and not the rows — the calendar's
 * assign modal takes it as a prop, and the calendar's two "needs n more"
 * labels have already computed it. All three wrote `required - occupied` by
 * hand and all three dropped the clamp, so the same over-filled shift said
 * "needs -1 more" on the calendar and nothing on the tasks page. Only the last
 * test here fails if the clamp goes; the first two pin that routing this
 * through a helper did not change the arithmetic.
 */
describe("remainingFromOccupied", () => {
  it("subtracts an already-filtered count", () => {
    expect(remainingFromOccupied(3, 2)).toBe(1);
  });

  it("is the full headcount when nobody holds a slot", () => {
    expect(remainingFromOccupied(4, 0)).toBe(4);
  });

  it("is zero, not negative, when the roster outgrew the headcount", () => {
    expect(remainingFromOccupied(1, 2)).toBe(0);
  });
});
