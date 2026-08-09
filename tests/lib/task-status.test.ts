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
  acceptsAssignments,
  assignmentRefusalFor,
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
