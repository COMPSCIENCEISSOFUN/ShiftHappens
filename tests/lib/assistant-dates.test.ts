/**
 * Reading a day out of a question.
 *
 * The assistant's design is that the model chooses an INTENT and touches
 * nothing else. Dates are the one remaining thing that decides what gets
 * fetched, so they are parsed by rule — and a misread day produces a rota for
 * the wrong day, rendered exactly like a rota for the right one.
 *
 * `now` is injected everywhere below. A test that read the clock would be a
 * claim about the day it ran on, which is the same defect as the fixed sleeps
 * and would surface as a suite that fails on a Tuesday.
 */
import { describe, it, expect } from "vitest";
import { parseAssistantDay } from "@/lib/assistant-dates";

/*
 * Monday 10 August 2026, 09:00 Singapore — stated as UTC so the fixture cannot
 * drift with the machine. 01:00Z is 09:00 in +08:00.
 */
const MONDAY_MORNING = new Date("2026-08-10T01:00:00.000Z");

/*
 * The same instant, but late at night in Singapore and therefore still the
 * PREVIOUS day in UTC. Everything that resolves "today" has to agree with the
 * organisation's calendar rather than the server's — this is the fixture that
 * proves it does.
 */
const MONDAY_NIGHT = new Date("2026-08-10T15:30:00.000Z"); // 23:30 SGT

describe("relative days", () => {
  it.each([
    ["is anyone on today", "2026-08-10"],
    ["who is on tonight", "2026-08-10"],
    ["who is on tomorrow", "2026-08-11"],
    ["name all members working tmr", "2026-08-11"],
    ["whos working tmrw", "2026-08-11"],
    ["who was on yesterday", "2026-08-09"],
    ["who is on the day after tomorrow", "2026-08-12"],
  ])("%j resolves to %s", (question, expected) => {
    expect(parseAssistantDay(question, MONDAY_MORNING)?.date).toBe(expected);
  });

  /*
   * The timezone case, and the reason this parser exists rather than a call to
   * `new Date()`. At 23:30 in Singapore the server's UTC clock still says
   * Sunday, so a naive "tomorrow" would answer about Monday — the day that is
   * already ending for the person asking.
   */
  it("uses the organisation's calendar, not the server's", () => {
    expect(parseAssistantDay("who is on today", MONDAY_NIGHT)?.date).toBe(
      "2026-08-10"
    );
    expect(parseAssistantDay("who is on tomorrow", MONDAY_NIGHT)?.date).toBe(
      "2026-08-11"
    );
  });

  it("prefers the longer phrase", () => {
    // "the day after tomorrow" contains "tomorrow", and the shorter match must
    // not win.
    expect(
      parseAssistantDay("who is on the day after tomorrow", MONDAY_MORNING)?.date
    ).toBe("2026-08-12");
  });
});

describe("weekdays", () => {
  it.each([
    ["who is working saturday", "2026-08-15"],
    ["whos on sat", "2026-08-15"],
    ["who is on wednesday", "2026-08-12"],
    ["who works fri", "2026-08-14"],
  ])("%j resolves to %s", (question, expected) => {
    expect(parseAssistantDay(question, MONDAY_MORNING)?.date).toBe(expected);
  });

  /*
   * "Monday" asked on a Monday means today; "next Monday" means the one after.
   * Both readings exist in ordinary speech and the difference is a week of
   * rota, so the word is honoured rather than normalised away.
   */
  it("reads a bare weekday as the soonest one, including today", () => {
    expect(parseAssistantDay("who is on monday", MONDAY_MORNING)?.date).toBe(
      "2026-08-10"
    );
  });

  it("reads 'next' as the one after that", () => {
    expect(parseAssistantDay("who is on next monday", MONDAY_MORNING)?.date).toBe(
      "2026-08-17"
    );
    expect(parseAssistantDay("who is on next saturday", MONDAY_MORNING)?.date).toBe(
      "2026-08-15"
    );
  });
});

describe("explicit dates", () => {
  it.each([
    ["name all task on 13th august", "2026-08-13"],
    ["who is on 13 august", "2026-08-13"],
    ["who is on august 13", "2026-08-13"],
    ["who is on 13 aug", "2026-08-13"],
    ["who is on aug 13th", "2026-08-13"],
    ["who is on the 13th of august", "2026-08-13"],
    ["who is on 2026-08-13", "2026-08-13"],
  ])("%j resolves to %s", (question, expected) => {
    expect(parseAssistantDay(question, MONDAY_MORNING)?.date).toBe(expected);
  });

  /*
   * The year nobody says out loud, and the wrong answer is silent. Asked in
   * August about "13 February", the reader means next February — a rota for a
   * date six months gone is not a plausible request, and answering with one
   * looks exactly like answering correctly.
   */
  it("rolls an already-passed month forward to next year", () => {
    expect(parseAssistantDay("who is on 13 february", MONDAY_MORNING)?.date).toBe(
      "2027-02-13"
    );
  });

  it("keeps a month still to come in this year", () => {
    expect(parseAssistantDay("who is on 1 december", MONDAY_MORNING)?.date).toBe(
      "2026-12-01"
    );
  });

  it("honours a stated year over both", () => {
    expect(
      parseAssistantDay("who is on 13 august 2028", MONDAY_MORNING)?.date
    ).toBe("2028-08-13");
  });

  /*
   * A date that does not exist is not a date. Rolling 31 February over into 3
   * March is what `new Date` does, and it would answer confidently about a day
   * nobody asked for.
   */
  it("refuses a day that does not exist", () => {
    expect(parseAssistantDay("who is on 31 february", MONDAY_MORNING)).toBeNull();
    expect(parseAssistantDay("who is on 2026-02-30", MONDAY_MORNING)).toBeNull();
  });
});

describe("no day at all", () => {
  /*
   * Null, and the caller asks back. Defaulting to today would be a guess
   * wearing an answer's clothes — and wrong most of the time somebody bothers
   * to type the question, because people ask about days they are planning for.
   */
  it.each([
    ["who is working"],
    ["whos on"],
    ["name all members"],
    [""],
  ])("returns nothing for %j", (question) => {
    expect(parseAssistantDay(question, MONDAY_MORNING)).toBeNull();
  });

  it("does not mistake a headcount for a date", () => {
    expect(parseAssistantDay("who is on the 2 person shift", MONDAY_MORNING))
      .toBeNull();
  });
});

describe("what it says back", () => {
  /*
   * The phrasing is echoed so the reader can check they were understood.
   * Handing back "2026-08-11" makes them do the verifying; handing back "tmr"
   * lets them see it at a glance.
   */
  it("repeats the words the question used", () => {
    expect(parseAssistantDay("who is on tmr", MONDAY_MORNING)?.said).toBe("tmr");
    expect(parseAssistantDay("who is working saturday", MONDAY_MORNING)?.said)
      .toBe("saturday");
  });
});
