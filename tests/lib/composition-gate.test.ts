/**
 * Admitting proposed assignees one at a time.
 *
 * `assignStaff` judges a whole batch and throws. The batch writers cannot — a
 * week's roster must not be discarded because its last row breaks a rule — so
 * they ask the same question once per person against the set accepted so far.
 * These are pure tests of that decision; the database side is in
 * tests/services/auto-schedule-composition.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  openCompositionGate,
  type CompositionCandidate,
  type CompositionRule,
} from "@/lib/composition-rules";

const AT_MOST_ONE_JUNIOR: CompositionRule = {
  kind: "seniority",
  value: "junior",
  comparator: "at_most",
  count: 1,
};

const AT_LEAST_ONE_SENIOR: CompositionRule = {
  kind: "seniority",
  value: "senior",
  comparator: "at_least",
  count: 1,
};

function person(
  id: string,
  seniority: CompositionCandidate["seniority"]
): CompositionCandidate {
  return { membershipId: id, seniority, certifications: [], employmentType: null };
}

function pool(...people: CompositionCandidate[]) {
  return new Map(people.map((p) => [p.membershipId, p]));
}

describe("admitting people", () => {
  it("admits while the roster stays feasible", () => {
    const a = person("a", "senior");
    const b = person("b", "junior");
    const gate = openCompositionGate([AT_MOST_ONE_JUNIOR], [], 2, pool(a, b));

    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("b")).toBe(true);
    expect(gate.refused).toBe(0);
  });

  it("refuses the person who would exceed an at_most rule", () => {
    const gate = openCompositionGate(
      [AT_MOST_ONE_JUNIOR],
      [],
      3,
      pool(person("a", "junior"), person("b", "junior"))
    );

    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("b")).toBe(false);
    expect(gate.refused).toBe(1);
  });

  // The refusal is of that person, not of the task. A gate that stopped after
  // one rejection would leave slots empty that somebody legal could fill.
  it("keeps admitting after a refusal", () => {
    const gate = openCompositionGate(
      [AT_MOST_ONE_JUNIOR],
      [],
      3,
      pool(
        person("a", "junior"),
        person("b", "junior"),
        person("c", "experienced")
      )
    );

    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("b")).toBe(false);
    expect(gate.admit("c")).toBe(true);
  });

  /*
   * The case the whole mechanism exists for.
   *
   * Two juniors offered for a two-person shift that needs a senior: taking both
   * leaves the rule unreachable. The second is refused so the slot the rule
   * needs is still there — a partial roster rather than an illegal one.
   */
  it("reserves the last slot for a rule that is not yet met", () => {
    const gate = openCompositionGate(
      [AT_LEAST_ONE_SENIOR],
      [],
      2,
      pool(person("a", "junior"), person("b", "junior"))
    );

    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("b")).toBe(false);
  });

  it("admits into that reserved slot when the right person comes along", () => {
    const gate = openCompositionGate(
      [AT_LEAST_ONE_SENIOR],
      [],
      2,
      pool(person("a", "junior"), person("s", "senior"))
    );

    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("s")).toBe(true);
  });

  it("counts the people already on the shift", () => {
    const gate = openCompositionGate(
      [AT_MOST_ONE_JUNIOR],
      [person("existing", "junior")],
      3,
      pool(person("a", "junior"))
    );

    expect(gate.admit("a")).toBe(false);
  });

  it("admits everybody when the task has no rules", () => {
    const gate = openCompositionGate(
      [],
      [],
      2,
      pool(person("a", "junior"), person("b", "junior"))
    );

    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("b")).toBe(true);
  });

  // A membership the gate knows nothing about cannot be judged, and the safe
  // direction when the subject of a rule is missing is to refuse.
  it("refuses a membership it was not built with", () => {
    const gate = openCompositionGate([AT_MOST_ONE_JUNIOR], [], 2, pool());

    expect(gate.admit("stranger")).toBe(false);
    expect(gate.refused).toBe(1);
  });

  /*
   * Order decides who gets the contested slot, and both writers hand proposals
   * over in their engine's preference order. Asserted so a later refactor that
   * sorts or parallelises the loop has to face the consequence deliberately.
   */
  it("gives the contested slot to whoever is offered first", () => {
    const people = pool(person("first", "junior"), person("second", "junior"));

    const forwards = openCompositionGate([AT_MOST_ONE_JUNIOR], [], 3, people);
    expect(forwards.admit("first")).toBe(true);
    expect(forwards.admit("second")).toBe(false);

    const backwards = openCompositionGate([AT_MOST_ONE_JUNIOR], [], 3, people);
    expect(backwards.admit("second")).toBe(true);
    expect(backwards.admit("first")).toBe(false);
  });
});

describe("force", () => {
  /*
   * Used when a manager has documented an override: the row is written whatever
   * the rule says, so the gate has to know about it or it goes on judging later
   * proposals against a roster missing somebody who is really on the shift.
   */
  it("records someone the rule refused, so later proposals see them", () => {
    const gate = openCompositionGate(
      [AT_MOST_ONE_JUNIOR],
      [],
      4,
      pool(
        person("a", "junior"),
        person("b", "junior"),
        person("c", "junior")
      )
    );

    expect(gate.admit("a")).toBe(true);
    expect(gate.admit("b")).toBe(false);
    gate.force("b");

    // Without the force, "c" would be judged against a roster of one junior and
    // the count would be wrong rather than merely stricter.
    expect(gate.admit("c")).toBe(false);
  });

  it("ignores a membership it does not know", () => {
    const gate = openCompositionGate(
      [AT_MOST_ONE_JUNIOR],
      [],
      3,
      pool(person("a", "junior"))
    );

    gate.force("stranger");
    expect(gate.admit("a")).toBe(true);
  });

  it("does not count towards refused", () => {
    const gate = openCompositionGate(
      [AT_MOST_ONE_JUNIOR],
      [],
      3,
      pool(person("a", "junior"))
    );

    gate.force("a");
    expect(gate.refused).toBe(0);
  });
});
