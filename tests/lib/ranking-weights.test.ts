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
  WEIGHT_KEYS,
  asPercentages,
  describeWeightsForPrompt,
  normaliseWeights,
  parseWeights,
  rebalanceWeights,
  type RankingWeights,
  weightsProblem,
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

/**
 * Keeping the four sliders at 100%.
 *
 * The weights are ratios and the ranker normalises them, so a total of 100 is
 * not required for correctness. It is required for the screen to be readable:
 * with four independent sliders, dragging workload from 30 to 60 cut
 * availability's real share from 25% to 19% while its own slider still read 25,
 * so the number an admin was looking at was not the thing they were setting.
 */
describe("rebalanceWeights", () => {
  it("keeps the total at exactly 100", () => {
    for (const value of [0, 5, 33, 50, 70, 100]) {
      const next = rebalanceWeights(DEFAULT_WEIGHTS, "workload", value);
      const total = WEIGHT_KEYS.reduce((sum, k) => sum + next[k], 0);
      expect(total, `total after setting workload to ${value}`).toBe(100);
    }
  });

  it("sets the moved dimension to what was asked for", () => {
    expect(rebalanceWeights(DEFAULT_WEIGHTS, "availability", 40).availability).toBe(40);
  });

  /*
   * Clamped at the same ceiling `weightsProblem` refuses, so the screen cannot
   * compose a set it will then reject on save. Dragging to the end gives you
   * the highest legal value rather than an error afterwards.
   */
  it("clamps at MAX_SHARE rather than letting the slider reach 100", () => {
    const next = rebalanceWeights(DEFAULT_WEIGHTS, "workload", 100);
    expect(next.workload).toBe(Math.round(MAX_SHARE * 100));
    expect(weightsProblem(next)).toBeNull();
  });

  /*
   * The others keep their RELATIVE order. Splitting the remainder equally would
   * be simpler and would quietly flatten priorities somebody had deliberately
   * set — availability mattering more than department is information.
   */
  it("preserves the ordering of the dimensions it did not move", () => {
    const start: RankingWeights = {
      workload: 10,
      availability: 40,
      certifications: 30,
      department: 20,
    };
    const next = rebalanceWeights(start, "workload", 40);

    expect(next.availability).toBeGreaterThan(next.certifications);
    expect(next.certifications).toBeGreaterThan(next.department);
  });

  it("keeps the proportions between them, not just the order", () => {
    const start: RankingWeights = {
      workload: 40,
      availability: 30,
      certifications: 20,
      department: 10,
    };
    const next = rebalanceWeights(start, "workload", 40);

    // availability:certifications was 3:2 and should still be
    expect(next.availability / next.certifications).toBeCloseTo(1.5, 1);
  });

  /*
   * Nothing to be proportional to, so the remainder is spread evenly. The only
   * case where this invents a preference, and the alternatives are worse: a
   * total below 100, or refusing a drag the admin is entitled to make.
   */
  it("spreads evenly when every other dimension is at zero", () => {
    const start: RankingWeights = {
      workload: 100,
      availability: 0,
      certifications: 0,
      department: 0,
    };
    const next = rebalanceWeights(start, "workload", 40);

    expect(next.availability).toBe(20);
    expect(next.certifications).toBe(20);
    expect(next.department).toBe(20);
  });

  // Rounding is settled on the last key rather than by rounding each share,
  // so four independent rounds cannot leave the total at 99 or 101.
  it("totals 100 even where the split does not divide evenly", () => {
    const start: RankingWeights = {
      workload: 25,
      availability: 25,
      certifications: 25,
      department: 25,
    };
    const next = rebalanceWeights(start, "workload", 35);
    expect(WEIGHT_KEYS.reduce((sum, k) => sum + next[k], 0)).toBe(100);
  });

  it("never produces a negative weight", () => {
    for (const value of [0, 15, 70]) {
      const next = rebalanceWeights(DEFAULT_WEIGHTS, "department", value);
      for (const key of WEIGHT_KEYS) expect(next[key]).toBeGreaterThanOrEqual(0);
    }
  });

  // The result is what the ranker will actually be given, so it has to survive
  // the same validation the save path applies.
  it("always produces a set the validator accepts", () => {
    for (const key of WEIGHT_KEYS) {
      for (const value of [0, 5, 25, 50, 70]) {
        expect(weightsProblem(rebalanceWeights(DEFAULT_WEIGHTS, key, value))).toBeNull();
      }
    }
  });
});
