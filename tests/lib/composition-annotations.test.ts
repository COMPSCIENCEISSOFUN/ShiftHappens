/**
 * What the assign panel shows about composition while a manager is choosing.
 *
 * `candidateEffect` was written and tested when the rules shipped and then had
 * no caller for a fortnight — the manager's only feedback was the refusal AFTER
 * picking the wrong person, which tells them they were wrong without telling
 * them who is right. `annotateSelection` is the surface it was written for, and
 * it is pure so the interesting part is testable without rendering the page.
 */
import { describe, it, expect } from "vitest";
import {
  annotateSelection,
  type CompositionCandidate,
  type CompositionRule,
} from "@/lib/composition-rules";

const AT_MOST_ONE_JUNIOR: CompositionRule = {
  kind: "seniority",
  value: "junior",
  comparator: "at_most",
  count: 1,
};

const AT_LEAST_ONE_FIRST_AID: CompositionRule = {
  kind: "certification",
  value: "First Aid",
  comparator: "at_least",
  count: 1,
};

function person(
  membershipId: string,
  seniority: CompositionCandidate["seniority"],
  certifications: string[] = []
): CompositionCandidate {
  return { membershipId, seniority, certifications, employmentType: null };
}

const JUNIOR = person("junior", "junior");
const SENIOR = person("senior", "senior");
const MEDIC = person("medic", "experienced", ["First Aid"]);

function annotate(
  rules: CompositionRule[],
  members: CompositionCandidate[],
  selected: string[] = [],
  assigned: string[] = [],
  requiredHeadcount = 2
) {
  return annotateSelection({
    rules,
    members,
    assignedMembershipIds: assigned,
    selectedMembershipIds: selected,
    requiredHeadcount,
  });
}

describe("what each candidate would do", () => {
  it("says who fills an unmet rule", () => {
    const { effects } = annotate([AT_LEAST_ONE_FIRST_AID], [JUNIOR, MEDIC]);

    expect(effects.medic.helps).toHaveLength(1);
    expect(effects.medic.helps[0]).toContain("First Aid");
  });

  it("says who would break a rule", () => {
    const { effects } = annotate(
      [AT_MOST_ONE_JUNIOR],
      [JUNIOR, SENIOR],
      ["junior"],
      [],
      3
    );

    // A second junior, with one already ticked, is the one to warn about.
    const other = person("junior2", "junior");
    const { effects: withSecond } = annotate(
      [AT_MOST_ONE_JUNIOR],
      [JUNIOR, other, SENIOR],
      ["junior"],
      [],
      3
    );

    expect(effects.senior).toBeUndefined();
    expect(withSecond.junior2.breaks).toHaveLength(1);
  });

  // A badge on everybody is a badge nobody reads.
  it("says nothing about a candidate the rules do not touch", () => {
    const { effects } = annotate([AT_LEAST_ONE_FIRST_AID], [JUNIOR, MEDIC]);

    expect(effects.junior).toBeUndefined();
  });

  it("stops calling someone helpful once the rule is met", () => {
    const another = person("medic2", "experienced", ["First Aid"]);
    const { effects } = annotate(
      [AT_LEAST_ONE_FIRST_AID],
      [MEDIC, another],
      ["medic"],
      [],
      3
    );

    expect(effects.medic2).toBeUndefined();
  });

  /*
   * The reason this is recomputed rather than fetched: the answer changes with
   * every tick, and a manager mid-selection is exactly who needs it current.
   */
  it("changes as the selection changes", () => {
    const second = person("junior2", "junior");

    const before = annotate([AT_MOST_ONE_JUNIOR], [JUNIOR, second], [], [], 3);
    expect(before.effects.junior2).toBeUndefined();

    const after = annotate(
      [AT_MOST_ONE_JUNIOR],
      [JUNIOR, second],
      ["junior"],
      [],
      3
    );
    expect(after.effects.junior2.breaks).toHaveLength(1);
  });

  /*
   * A ticked member is part of the roster the evaluation was computed over, so
   * asking what adding them would do counts them twice — and an `at_most` rule
   * they are the last legal occupant of would then warn that the person already
   * chosen "would break" it.
   *
   * Worth stating why this arrangement: an `at_least` rule cannot show the bug,
   * because a ticked member who satisfies it produces an empty effect anyway and
   * the test passes with or without the skip. The first version of this test did
   * exactly that and survived its mutant.
   */
  it("does not warn about somebody already ticked", () => {
    const { effects } = annotate(
      [AT_MOST_ONE_JUNIOR],
      [JUNIOR, SENIOR],
      ["junior"],
      [],
      3
    );

    expect(effects.junior).toBeUndefined();
  });
});

describe("the roster the rules are judged against", () => {
  // People already on the shift count. Judging only the ticks would tell a
  // manager a rule is unmet when the person meeting it is already rostered.
  it("includes members already assigned", () => {
    const { evaluation } = annotate(
      [AT_LEAST_ONE_FIRST_AID],
      [MEDIC, JUNIOR],
      [],
      ["medic"]
    );

    expect(evaluation?.satisfied).toBe(true);
  });

  it("counts the assigned and the ticked together", () => {
    const second = person("junior2", "junior");
    const { evaluation } = annotate(
      [AT_MOST_ONE_JUNIOR],
      [JUNIOR, second],
      ["junior2"],
      ["junior"],
      3
    );

    expect(evaluation?.satisfied).toBe(false);
  });

  // An id with no matching member — a stale selection after the panel reloaded
  // — is dropped rather than counted as an unknown person.
  it("ignores an id it has no member for", () => {
    const { evaluation } = annotate(
      [AT_MOST_ONE_JUNIOR],
      [JUNIOR],
      ["vanished"],
      [],
      3
    );

    expect(evaluation?.rules[0].matched).toBe(0);
  });
});

describe("a task with no rules", () => {
  /*
   * Null rather than an empty evaluation, so the panel can hide the section
   * outright. An empty "Composition rules" heading over nothing reads as a
   * feature that failed to load.
   */
  it("has nothing to show", () => {
    const { evaluation, effects } = annotate([], [JUNIOR, MEDIC]);

    expect(evaluation).toBeNull();
    expect(effects).toEqual({});
  });
});
