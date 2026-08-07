/**
 * Turning a lifecycle status into what actually happened.
 *
 * The ordering inside `shiftOutcome` is the whole of it, and every test below
 * that pits two conditions against each other is guarding one specific way the
 * obvious order would be wrong.
 */
import { describe, it, expect } from "vitest";

import {
  shiftOutcome,
  workedHours,
  OUTCOME_LABEL,
  OUTCOME_NOTE,
  OUTCOME_TONE,
  SHIFT_OUTCOMES,
} from "@/lib/shift-outcome";

const IN = new Date("2026-07-01T09:00:00.000Z");
const OUT = new Date("2026-07-01T17:00:00.000Z");

function row(overrides: Partial<Parameters<typeof shiftOutcome>[0]> = {}) {
  return {
    status: "accepted",
    clockInTime: null,
    clockOutTime: null,
    task: { status: "completed" },
    ...overrides,
  };
}

describe("classifying a finished shift", () => {
  it("reads a completed assignment as worked", () => {
    expect(shiftOutcome(row({ status: "completed" }))).toBe("worked");
  });

  /*
   * Completion is a button somebody has to remember to press. The hours between
   * clocking in and out happened whether or not they did, which is the same
   * reasoning `WORKED_STATUSES` already applies to the delete guard.
   */
  it("reads clocked_out as worked too", () => {
    expect(shiftOutcome(row({ status: "clocked_out" }))).toBe("worked");
  });

  it("reads a complete clock pair as worked whatever the status says", () => {
    expect(
      shiftOutcome(row({ status: "accepted", clockInTime: IN, clockOutTime: OUT }))
    ).toBe("worked");
  });

  it("reads a rejection as declined", () => {
    expect(shiftOutcome(row({ status: "rejected" }))).toBe("declined");
  });

  it("reads a withdrawal as withdrew", () => {
    expect(shiftOutcome(row({ status: "withdrawn" }))).toBe("withdrawn");
  });

  it("reads a cancelled shift as cancelled", () => {
    expect(shiftOutcome(row({ task: { status: "cancelled" } }))).toBe("cancelled");
  });

  it("reads a clock-in with no clock-out as such", () => {
    expect(shiftOutcome(row({ clockInTime: IN }))).toBe("not_clocked_out");
  });

  it("reads an accepted shift nobody clocked into as no clock-in", () => {
    expect(shiftOutcome(row({ status: "accepted" }))).toBe("no_clock_in");
  });

  it("reads a pending shift that passed as never answered", () => {
    expect(shiftOutcome(row({ status: "pending" }))).toBe("unanswered");
  });

  /*
   * A decline the member asked for and no manager ever answered. Folding this
   * into "no clock-in" would put the omission on the member, when the record
   * shows they raised it and were left waiting.
   */
  it("reads an unanswered decline request as never answered", () => {
    expect(shiftOutcome(row({ status: "decline_requested" }))).toBe("unanswered");
  });

  it("reads an unanswered withdrawal request as no clock-in", () => {
    expect(shiftOutcome(row({ status: "withdrawal_requested" }))).toBe("no_clock_in");
  });
});

describe("when two conditions are both true", () => {
  /*
   * The precedence that pays people. A shift worked and then cancelled in the
   * task record is still hours the member stood there for, and a "Cancelled"
   * badge would drop them out of the total on the same page.
   */
  it("worked beats cancelled", () => {
    expect(
      shiftOutcome(
        row({ status: "completed", task: { status: "cancelled" } })
      )
    ).toBe("worked");
  });

  // Their decision came first and is the one that describes their history.
  it("declined beats cancelled", () => {
    expect(
      shiftOutcome(row({ status: "rejected", task: { status: "cancelled" } }))
    ).toBe("declined");
  });

  /*
   * The other way round: a shift that stopped existing is why nobody clocked
   * into it. Reporting "No clock-in" would flag the member for a shift that was
   * called off.
   */
  it("cancelled beats no clock-in", () => {
    expect(
      shiftOutcome(row({ status: "accepted", task: { status: "cancelled" } }))
    ).toBe("cancelled");
  });

  it("cancelled beats never answered", () => {
    expect(
      shiftOutcome(row({ status: "pending", task: { status: "cancelled" } }))
    ).toBe("cancelled");
  });
});

describe("hours from the clock", () => {
  it("measures a complete pair", () => {
    expect(workedHours({ clockInTime: IN, clockOutTime: OUT })).toBe(8);
  });

  it("says nothing when there is no clock-out", () => {
    expect(workedHours({ clockInTime: IN, clockOutTime: null })).toBeNull();
  });

  it("says nothing when there is no clock-in", () => {
    expect(workedHours({ clockInTime: null, clockOutTime: OUT })).toBeNull();
  });

  /*
   * Corrupt, not negative. Returning -8 would subtract from the member's total,
   * making the figure quietly wrong instead of visibly short — and the page
   * counts unmeasurable shifts separately so a short total is explainable.
   */
  it("refuses to measure a clock-out before the clock-in", () => {
    expect(workedHours({ clockInTime: OUT, clockOutTime: IN })).toBeNull();
  });

  it("accepts ISO strings, as they arrive from res.json()", () => {
    expect(
      workedHours({ clockInTime: IN.toISOString(), clockOutTime: OUT.toISOString() })
    ).toBe(8);
  });
});

describe("the vocabulary the UI draws from", () => {
  // Adding an outcome without its label ships a blank badge.
  it("has a label, a note and a tone for every outcome", () => {
    for (const outcome of SHIFT_OUTCOMES) {
      expect(OUTCOME_LABEL[outcome]).toBeTruthy();
      expect(OUTCOME_TONE[outcome]).toBeTruthy();
      expect(OUTCOME_NOTE[outcome]).toBeTypeOf("string");
    }
  });

  /*
   * "Worked" is the only outcome that needs no explanation, and giving it one
   * would put a line of text under every ordinary row.
   */
  it("explains every outcome except the uneventful one", () => {
    for (const outcome of SHIFT_OUTCOMES) {
      if (outcome === "worked") expect(OUTCOME_NOTE[outcome]).toBe("");
      else expect(OUTCOME_NOTE[outcome].length).toBeGreaterThan(0);
    }
  });

  // A member's own history should not read as a charge sheet for a manager's
  // decision they had no part in.
  it("does not treat a cancellation as the member's failing", () => {
    expect(OUTCOME_TONE.cancelled).toBe("neutral");
    expect(OUTCOME_TONE.declined).toBe("neutral");
  });
});
