/**
 * The rules that turn a dead column into a real setting.
 *
 * `CompanySettings.smartAllocationWeights` sat on the schema, readable and
 * writable, and no code anywhere consulted it — while `FallbackRanker`
 * hardcoded the four numbers it names. So the data model advertised a tunable
 * engine and the engine ignored it.
 *
 * Two properties matter most here. The weights are RELATIVE, so any set of
 * positive numbers behaves like the equivalent percentages and the UI never has
 * to force a total. And parsing is forgiving, because the column predates any
 * validation and a ranking engine that throws over a malformed settings row is
 * worse than one that quietly uses sensible numbers.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_WEIGHTS,
  MAX_SHARE,
  asPercentages,
  describeWeightsForPrompt,
  normaliseWeights,
  parseWeights,
  weightsProblem,
  type RankingWeights,
} from "@/lib/ranking-weights";

const EVEN: RankingWeights = {
  workload: 25,
  availability: 25,
  certifications: 25,
  department: 25,
};

describe("reading what is stored", () => {
  it("uses the previous hardcoded values when nothing is set", () => {
    expect(parseWeights(null)).toEqual(DEFAULT_WEIGHTS);
  });

  /*
   * Switching the feature on must not reshuffle anybody's roster. Every
   * organisation has a null column today, so the defaults have to be exactly
   * what the ranker used before it could be configured.
   */
  it("those defaults are what the ranker used before", () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      workload: 30,
      availability: 25,
      certifications: 25,
      department: 20,
    });
  });

  it("reads a stored set", () => {
    expect(parseWeights(JSON.stringify(EVEN))).toEqual(EVEN);
  });

  it("survives malformed JSON rather than throwing", () => {
    expect(parseWeights("{not json")).toEqual(DEFAULT_WEIGHTS);
  });

  it("survives a value that is not an object", () => {
    expect(parseWeights("42")).toEqual(DEFAULT_WEIGHTS);
  });

  /*
   * Per key, not all-or-nothing. A partial or half-migrated write should not
   * silently reset the three dimensions that were fine.
   */
  it("keeps the keys it can read and defaults the rest", () => {
    const parsed = parseWeights(JSON.stringify({ workload: 80, department: -5 }));
    expect(parsed.workload).toBe(80);
    expect(parsed.department).toBe(DEFAULT_WEIGHTS.department);
    expect(parsed.availability).toBe(DEFAULT_WEIGHTS.availability);
  });

  // Every candidate scoring zero makes the order arbitrary, so this is not a
  // configuration anybody meant.
  it("refuses an all-zero stored set", () => {
    const parsed = parseWeights(
      JSON.stringify({ workload: 0, availability: 0, certifications: 0, department: 0 })
    );
    expect(parsed).toEqual(DEFAULT_WEIGHTS);
  });
});

describe("relative, not absolute", () => {
  /*
   * THE property that lets the settings screen drop the "must total 100" rule.
   * Four sliders forced to sum to a constant make every adjustment an
   * arithmetic problem for the person moving them.
   */
  it("doubling everything changes nothing", () => {
    const doubled: RankingWeights = {
      workload: 60,
      availability: 50,
      certifications: 50,
      department: 40,
    };
    expect(normaliseWeights(doubled)).toEqual(normaliseWeights(DEFAULT_WEIGHTS));
  });

  it("normalises to fractions summing to one", () => {
    const n = normaliseWeights(EVEN);
    const total = n.workload + n.availability + n.certifications + n.department;
    expect(total).toBeCloseTo(1, 6);
  });

  it("shows each dimension's share, whatever the raw numbers", () => {
    expect(asPercentages({ ...EVEN, workload: 25 })).toEqual({
      workload: 25,
      availability: 25,
      certifications: 25,
      department: 25,
    });
  });

  it("falls back rather than dividing by zero", () => {
    const n = normaliseWeights({
      workload: 0,
      availability: 0,
      certifications: 0,
      department: 0,
    });
    expect(n).toEqual(normaliseWeights(DEFAULT_WEIGHTS));
  });
});

describe("what is refused", () => {
  it("accepts an ordinary set", () => {
    expect(weightsProblem(DEFAULT_WEIGHTS)).toBeNull();
  });

  it("refuses all zeroes", () => {
    expect(
      weightsProblem({ workload: 0, availability: 0, certifications: 0, department: 0 })
    ).toMatch(/above zero/);
  });

  it("refuses a negative", () => {
    expect(weightsProblem({ ...EVEN, workload: -1 })).toMatch(/zero or more/);
  });

  /*
   * The state somebody reaches by dragging one slider to the end without
   * noticing the other three stopped mattering. Named in the message, because
   * "invalid" would leave them guessing which one.
   */
  it("refuses one dimension deciding everything", () => {
    const problem = weightsProblem({
      workload: 90,
      availability: 5,
      certifications: 5,
      department: 5,
    });
    expect(problem).toMatch(/Workload balance/);
  });

  it("allows a dimension right at the limit", () => {
    // 70 of 100 total is exactly MAX_SHARE, which is permitted; above it is not.
    expect(
      weightsProblem({
        workload: 70,
        availability: 10,
        certifications: 10,
        department: 10,
      })
    ).toBeNull();
    expect(MAX_SHARE).toBe(0.7);
  });

  // Zero on one dimension is a legitimate choice — "I do not care about
  // certifications here" — as long as something else carries the ranking.
  it("allows a single dimension at zero", () => {
    expect(weightsProblem({ ...EVEN, certifications: 0 })).toBeNull();
  });
});

describe("what the AI is told", () => {
  it("lists the dimensions strongest first", () => {
    const sentence = describeWeightsForPrompt(DEFAULT_WEIGHTS);
    expect(sentence.indexOf("Workload balance")).toBeLessThan(
      sentence.indexOf("Department experience")
    );
  });

  it("carries the shares, so the ordering has a magnitude", () => {
    expect(describeWeightsForPrompt(DEFAULT_WEIGHTS)).toMatch(/30%/);
  });

  /*
   * A dimension weighted zero is omitted rather than listed as "0% important",
   * which reads to a model as a hint to consider it.
   */
  it("omits a dimension nobody wants counted", () => {
    const sentence = describeWeightsForPrompt({ ...EVEN, certifications: 0 });
    expect(sentence).not.toMatch(/Certification/);
    expect(sentence).toMatch(/Workload/);
  });
});
