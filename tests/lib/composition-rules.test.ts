import { describe, it, expect } from "vitest";
import {
  MAX_COMPOSITION_RULES,
  candidateEffect,
  compositionRulesSchema,
  describeRule,
  evaluateComposition,
  infeasibilityMessage,
  matchesRule,
  parseCompositionRules,
  serialiseCompositionRules,
  type CompositionCandidate,
  type CompositionRule,
} from "@/lib/composition-rules";
import type { SeniorityLevel } from "@/lib/seniority";

function member(
  seniority: SeniorityLevel,
  extra: Partial<CompositionCandidate> = {}
): CompositionCandidate {
  return {
    membershipId: `m-${seniority}-${Math.round(Math.random() * 1e9)}`,
    seniority,
    certifications: [],
    employmentType: "casual",
    ...extra,
  };
}

const atMostOneJunior: CompositionRule = {
  kind: "seniority",
  value: "junior",
  comparator: "at_most",
  count: 1,
};

const atLeastOneFirstAid: CompositionRule = {
  kind: "certification",
  value: "First Aid",
  comparator: "at_least",
  count: 1,
};

describe("matchesRule — seniority", () => {
  it("at_least counts the level and everything above it", () => {
    const rule: CompositionRule = {
      kind: "seniority",
      value: "experienced",
      comparator: "at_least",
      count: 1,
    };

    expect(matchesRule(rule, member("senior"))).toBe(true);
    expect(matchesRule(rule, member("experienced"))).toBe(true);
    expect(matchesRule(rule, member("junior"))).toBe(false);
  });

  // The supervisor's rule. If the comparison ran the same direction as
  // at_least, "at most 1 junior" would match every staff member and block the
  // second assignment to any shift.
  it("at_most counts the level and everything below it", () => {
    expect(matchesRule(atMostOneJunior, member("junior"))).toBe(true);
    expect(matchesRule(atMostOneJunior, member("experienced"))).toBe(false);
    expect(matchesRule(atMostOneJunior, member("senior"))).toBe(false);
  });
});

describe("matchesRule — certification", () => {
  it("matches regardless of case and surrounding space", () => {
    expect(
      matchesRule(atLeastOneFirstAid, member("junior", { certifications: ["first aid"] }))
    ).toBe(true);
    expect(
      matchesRule(atLeastOneFirstAid, member("junior", { certifications: ["  First Aid  "] }))
    ).toBe(true);
  });

  it("does not match a different certificate", () => {
    expect(matchesRule(atLeastOneFirstAid, member("senior", { certifications: ["RSA"] }))).toBe(
      false
    );
  });

  it("does not match a partial name", () => {
    expect(
      matchesRule(atLeastOneFirstAid, member("senior", { certifications: ["First Aid Level 2"] }))
    ).toBe(false);
  });

  it("does not match someone holding nothing", () => {
    expect(matchesRule(atLeastOneFirstAid, member("senior"))).toBe(false);
  });
});

describe("matchesRule — employment type", () => {
  const rule: CompositionRule = {
    kind: "employment_type",
    value: "full_time",
    comparator: "at_least",
    count: 1,
  };

  it("matches the exact type", () => {
    expect(matchesRule(rule, member("junior", { employmentType: "full_time" }))).toBe(true);
    expect(matchesRule(rule, member("senior", { employmentType: "casual" }))).toBe(false);
  });

  it("does not match a member with no type recorded", () => {
    expect(matchesRule(rule, member("senior", { employmentType: null }))).toBe(false);
  });
});

describe("evaluateComposition — at_least", () => {
  it("is unsatisfied but still feasible while slots remain", () => {
    const result = evaluateComposition([atLeastOneFirstAid], [member("junior")], 2);

    expect(result.satisfied).toBe(false);
    expect(result.feasible).toBe(true);
  });

  // The reason feasibility is separate from satisfaction: a manager filling a
  // two-person shift one at a time must not be blocked on the first person for
  // a rule the second could still meet.
  it("becomes infeasible only when the last slot is taken", () => {
    const holder = member("junior", { certifications: ["First Aid"] });
    const other = member("junior");

    expect(evaluateComposition([atLeastOneFirstAid], [other], 2).feasible).toBe(true);
    expect(evaluateComposition([atLeastOneFirstAid], [other, other], 2).feasible).toBe(false);
    expect(evaluateComposition([atLeastOneFirstAid], [other, holder], 2).feasible).toBe(true);
  });

  it("is satisfied once the count is reached", () => {
    const rule: CompositionRule = { ...atLeastOneFirstAid, count: 2 };
    const holder = member("junior", { certifications: ["First Aid"] });

    expect(evaluateComposition([rule], [holder], 2).satisfied).toBe(false);
    expect(evaluateComposition([rule], [holder, holder], 2).satisfied).toBe(true);
  });

  it("stays satisfied past the count", () => {
    const holder = member("senior", { certifications: ["First Aid"] });
    expect(evaluateComposition([atLeastOneFirstAid], [holder, holder], 2).satisfied).toBe(true);
  });
});

describe("evaluateComposition — at_most", () => {
  it("is satisfied while under the limit", () => {
    const result = evaluateComposition([atMostOneJunior], [member("junior")], 2);
    expect(result.satisfied).toBe(true);
    expect(result.feasible).toBe(true);
  });

  // An at_most rule cannot be repaired by assigning more people, so exceeded
  // and infeasible are the same moment. This is what makes the two comparators
  // genuinely different rather than one expressed two ways.
  it("is infeasible the instant it is exceeded, with slots still free", () => {
    const result = evaluateComposition([atMostOneJunior], [member("junior"), member("junior")], 5);

    expect(result.satisfied).toBe(false);
    expect(result.feasible).toBe(false);
  });

  it("allows a count of zero, meaning none at all", () => {
    const none: CompositionRule = { ...atMostOneJunior, count: 0 };

    expect(evaluateComposition([none], [member("experienced")], 2).satisfied).toBe(true);
    expect(evaluateComposition([none], [member("junior")], 2).satisfied).toBe(false);
  });
});

describe("evaluateComposition — edges", () => {
  it("treats no rules as satisfied and feasible", () => {
    const result = evaluateComposition([], [member("junior")], 1);
    expect(result.satisfied).toBe(true);
    expect(result.feasible).toBe(true);
    expect(result.rules).toEqual([]);
  });

  it("reports an empty at_least shift as feasible when the headcount allows", () => {
    expect(evaluateComposition([atLeastOneFirstAid], [], 1).feasible).toBe(true);
  });

  it("reports an at_least rule on a zero-headcount task as unreachable", () => {
    expect(evaluateComposition([atLeastOneFirstAid], [], 0).feasible).toBe(false);
  });

  // Over-filling must not produce negative remaining slots. Without a floor at
  // zero the shortfall is subtracted from a rule that is already met, and an
  // over-filled shift reports its satisfied rules as unreachable.
  it("does not let an over-filled shift produce negative slots", () => {
    const rule: CompositionRule = { ...atLeastOneFirstAid, count: 2 };
    const holder = member("senior", { certifications: ["First Aid"] });
    const result = evaluateComposition([rule], [holder, holder, holder], 1);

    expect(result.rules[0].matched).toBe(3);
    expect(result.satisfied).toBe(true);
    expect(result.feasible).toBe(true);
  });

  it("requires every rule to hold, not just one", () => {
    const rules = [atMostOneJunior, atLeastOneFirstAid];
    const result = evaluateComposition(rules, [member("junior"), member("junior")], 2);

    expect(result.rules.filter((r) => r.satisfied)).toHaveLength(0);
    expect(result.satisfied).toBe(false);
  });

  it("reports matched counts per rule", () => {
    const result = evaluateComposition(
      [atMostOneJunior],
      [member("junior"), member("junior"), member("senior")],
      3
    );
    expect(result.rules[0].matched).toBe(2);
  });
});

describe("infeasibilityMessage", () => {
  it("is null when nothing is broken", () => {
    expect(infeasibilityMessage(evaluateComposition([atMostOneJunior], [member("senior")], 2))).toBeNull();
  });

  it("names the exceeded rule and the count reached", () => {
    const message = infeasibilityMessage(
      evaluateComposition([atMostOneJunior], [member("junior"), member("junior")], 4)
    );

    expect(message).toContain("At most 1 assignee at Junior or below");
    expect(message).toContain("would be 2");
  });

  it("explains an unreachable at_least rule in terms of slots", () => {
    const message = infeasibilityMessage(
      evaluateComposition([atLeastOneFirstAid], [member("junior")], 1)
    );

    expect(message).toContain("First Aid");
    expect(message).toContain("no slots left");
  });
});

describe("describeRule", () => {
  it("spells out the direction of a seniority bound", () => {
    expect(describeRule(atMostOneJunior)).toBe("At most 1 assignee at Junior or below");
    expect(
      describeRule({ kind: "seniority", value: "senior", comparator: "at_least", count: 2 })
    ).toBe("At least 2 assignees at Senior or above");
  });

  it("names the certificate", () => {
    expect(describeRule(atLeastOneFirstAid)).toBe("At least 1 assignee holding First Aid");
  });

  it("uses the employment type's label rather than its key", () => {
    expect(
      describeRule({ kind: "employment_type", value: "full_time", comparator: "at_least", count: 1 })
    ).toBe("At least 1 assignee who is Full-time");
  });

  it("agrees the verb with the count", () => {
    expect(
      describeRule({ kind: "employment_type", value: "casual", comparator: "at_most", count: 2 })
    ).toBe("At most 2 assignees who are Casual");
  });
});

describe("candidateEffect", () => {
  it("flags a candidate who advances an unmet at_least rule", () => {
    const evaluation = evaluateComposition([atLeastOneFirstAid], [member("junior")], 2);
    const effect = candidateEffect(
      evaluation,
      member("junior", { certifications: ["First Aid"] })
    );

    expect(effect.helps).toHaveLength(1);
    expect(effect.breaks).toHaveLength(0);
  });

  it("says nothing about a rule already met", () => {
    const holder = member("senior", { certifications: ["First Aid"] });
    const evaluation = evaluateComposition([atLeastOneFirstAid], [holder], 3);

    expect(candidateEffect(evaluation, holder).helps).toHaveLength(0);
  });

  // The warning that stops a manager picking someone who will then be refused.
  it("flags a candidate who would push an at_most rule over", () => {
    const evaluation = evaluateComposition([atMostOneJunior], [member("junior")], 3);
    const effect = candidateEffect(evaluation, member("junior"));

    expect(effect.breaks).toHaveLength(1);
    expect(effect.helps).toHaveLength(0);
  });

  it("stays quiet about an at_most rule with room left", () => {
    const rule: CompositionRule = { ...atMostOneJunior, count: 2 };
    const evaluation = evaluateComposition([rule], [member("junior")], 3);

    expect(candidateEffect(evaluation, member("junior")).breaks).toHaveLength(0);
  });

  it("ignores rules the candidate does not match at all", () => {
    const evaluation = evaluateComposition([atLeastOneFirstAid], [], 2);
    const effect = candidateEffect(evaluation, member("senior"));

    expect(effect.helps).toHaveLength(0);
    expect(effect.breaks).toHaveLength(0);
  });
});

describe("validation", () => {
  it("accepts a well-formed rule", () => {
    expect(compositionRulesSchema.safeParse([atMostOneJunior]).success).toBe(true);
  });

  it("rejects a seniority value that is not a level", () => {
    const result = compositionRulesSchema.safeParse([
      { kind: "seniority", value: "principal", comparator: "at_least", count: 1 },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects an employment type that is not one of the known keys", () => {
    const result = compositionRulesSchema.safeParse([
      { kind: "employment_type", value: "contractor", comparator: "at_least", count: 1 },
    ]);
    expect(result.success).toBe(false);
  });

  // "At least 0" is met by every possible roster, so storing it would put a
  // constraint on the task that can never bite while reading as protection.
  it("rejects an at_least rule with a count of zero", () => {
    const result = compositionRulesSchema.safeParse([{ ...atLeastOneFirstAid, count: 0 }]);
    expect(result.success).toBe(false);
  });

  it("accepts an at_most rule with a count of zero", () => {
    const result = compositionRulesSchema.safeParse([{ ...atMostOneJunior, count: 0 }]);
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const result = compositionRulesSchema.safeParse([
      { kind: "tag", value: "keyholder", comparator: "at_least", count: 1 },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects an empty value", () => {
    const result = compositionRulesSchema.safeParse([{ ...atLeastOneFirstAid, value: "" }]);
    expect(result.success).toBe(false);
  });

  it("rejects a fractional count", () => {
    const result = compositionRulesSchema.safeParse([{ ...atLeastOneFirstAid, count: 1.5 }]);
    expect(result.success).toBe(false);
  });

  it("caps the number of rules", () => {
    const many = Array.from({ length: MAX_COMPOSITION_RULES + 1 }, () => atMostOneJunior);
    expect(compositionRulesSchema.safeParse(many).success).toBe(false);
  });
});

describe("storage", () => {
  it("stores null rather than an empty array", () => {
    expect(serialiseCompositionRules([])).toBeNull();
  });

  it("round-trips a rule set", () => {
    const rules = [atMostOneJunior, atLeastOneFirstAid];
    expect(parseCompositionRules(serialiseCompositionRules(rules))).toEqual(rules);
  });

  it("reads an absent column as no rules", () => {
    expect(parseCompositionRules(null)).toEqual([]);
    expect(parseCompositionRules(undefined)).toEqual([]);
    expect(parseCompositionRules("")).toEqual([]);
  });

  // Failing open loses a safeguard; failing closed loses the shift. A task
  // nobody can assign to because of a stray character is the worse outcome.
  it("degrades malformed JSON to no rules instead of throwing", () => {
    expect(parseCompositionRules("{not json")).toEqual([]);
    expect(parseCompositionRules("null")).toEqual([]);
    expect(parseCompositionRules('{"kind":"seniority"}')).toEqual([]);
  });

  it("discards a stored rule that no longer validates", () => {
    const stored = JSON.stringify([{ kind: "tag", value: "keyholder", comparator: "at_least", count: 1 }]);
    expect(parseCompositionRules(stored)).toEqual([]);
  });
});
