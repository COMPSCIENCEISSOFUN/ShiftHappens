/**
 * Which task states will take a person.
 *
 * `assignStaff` ran seven checks on the MEMBER — exists, active, right tenant,
 * not an admin, not already on the task, within headcount, no scheduling
 * conflict — and none on the task. So a cancelled shift still accepted people.
 *
 * That contradicts the reason cancelling exists at all: `TaskService.delete`
 * refuses a task that has assignments and cancels it instead, precisely so the
 * record survives as "this was real and is not happening".
 */
import { describe, it, expect } from "vitest";
import {
  TASK_STATUSES,
  CLOSED_TO_ASSIGNMENT,
  RELEASES_COMMITMENT,
  acceptsAssignments,
  assignmentRefusalFor,
  closedTaskStatusFilter,
  committedTaskStatusFilter,
} from "@/lib/task-status";

describe("acceptsAssignments", () => {
  it("refuses the two terminal states", () => {
    expect(acceptsAssignments("cancelled")).toBe(false);
    expect(acceptsAssignments("completed")).toBe(false);
  });

  it("allows an open shift", () => {
    expect(acceptsAssignments("open")).toBe(true);
  });

  /*
   * Cover arriving mid-shift is ordinary — somebody calls in sick two hours in
   * and a replacement is found. Refusing it would push real work off the
   * system, which is the argument that stopped full-time declines being blocked
   * outright.
   */
  it("allows a shift already in progress", () => {
    expect(acceptsAssignments("in_progress")).toBe(true);
  });

  /*
   * The opposite of `occupiesSlot`'s treatment of an unknown value, on purpose.
   * There, guessing wrong shows a shift as full and prompts somebody to look.
   * Here, guessing wrong refuses a manager the ability to staff a shift and
   * cites a status the product does not have — so a new status must not
   * silently make the roster unfillable.
   */
  it("allows a status nobody recognises", () => {
    expect(acceptsAssignments("archived")).toBe(true);
  });

  it("decides every status in the lifecycle", () => {
    const allowed = TASK_STATUSES.filter(acceptsAssignments);
    expect(allowed).toHaveLength(TASK_STATUSES.length - CLOSED_TO_ASSIGNMENT.length);
  });
});

describe("assignmentRefusalFor", () => {
  it("says nothing when the shift is assignable", () => {
    expect(assignmentRefusalFor("open")).toBeNull();
    expect(assignmentRefusalFor("in_progress")).toBeNull();
  });

  /*
   * Two different messages, because they are two different situations and the
   * fix differs. A generic "this task cannot be assigned" would leave a manager
   * guessing which of the two they are looking at.
   */
  it("names the reason, and tells the manager what to do about it", () => {
    expect(assignmentRefusalFor("cancelled")).toMatch(/cancelled/);
    expect(assignmentRefusalFor("completed")).toMatch(/completed/);
    expect(assignmentRefusalFor("cancelled")).not.toEqual(
      assignmentRefusalFor("completed")
    );
    for (const status of CLOSED_TO_ASSIGNMENT) {
      expect(assignmentRefusalFor(status)).toMatch(/reopen/i);
    }
  });
});

/*
 * The second question a task's status answers, and the reason it needs its own
 * constant: cancelling told a member they were no longer scheduled and left
 * them unschedulable at that hour, blocked by the shift that had been called
 * off.
 */
describe("who is still committed to a time", () => {
  it("releases a cancelled shift", () => {
    expect(committedTaskStatusFilter()).toContain("cancelled");
  });

  /*
   * The distinction that stops this collapsing into `CLOSED_TO_ASSIGNMENT`.
   * Both refuse new people; only one gives the existing people their hours
   * back. Somebody who worked 09:00 to 17:00 was not free at noon because the
   * shift has since been marked done.
   */
  it("does not release a completed one", () => {
    expect(committedTaskStatusFilter()).not.toContain("completed");
    expect(CLOSED_TO_ASSIGNMENT).toContain("completed");
  });

  it("names only statuses the product has", () => {
    for (const status of RELEASES_COMMITMENT) {
      expect(TASK_STATUSES).toContain(status);
    }
  });

  /*
   * Prisma's generated types want a mutable array, and handing out the constant
   * itself would let one caller's `.push` change the rule for every other.
   */
  it("hands out a copy rather than the constant", () => {
    const filter = committedTaskStatusFilter();
    filter.push("open");

    expect(committedTaskStatusFilter()).not.toContain("open");
  });
});

/*
 * Four queries wrote `["completed", "cancelled"]` by hand — three in reporting
 * and one in the plan-limit check, whose own comment argues that "a future
 * status would otherwise have to remember to be added here". They all now read
 * the constant, and these hold that.
 */
describe("closedTaskStatusFilter", () => {
  it("is the two terminal states", () => {
    expect(closedTaskStatusFilter().sort()).toEqual([...CLOSED_TO_ASSIGNMENT].sort());
  });

  /*
   * The two filters answer different questions and must not be allowed to
   * collapse into one. A completed shift takes no new people AND still owes its
   * hours; only cancelling does both.
   */
  it("is not the same set as the one that releases a commitment", () => {
    expect(closedTaskStatusFilter()).not.toEqual(committedTaskStatusFilter());
    expect(closedTaskStatusFilter()).toContain("completed");
    expect(committedTaskStatusFilter()).not.toContain("completed");
  });

  it("hands out a copy rather than the constant", () => {
    closedTaskStatusFilter().push("open");

    expect(closedTaskStatusFilter()).not.toContain("open");
  });
});
