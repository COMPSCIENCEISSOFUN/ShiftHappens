/**
 * Composition constraints — rules about the SET of people on a shift.
 *
 * ## Why the eligibility engine could not do this
 *
 * `checkEligibilityForTask` asks one question per candidate, in isolation:
 * are they free, are they under their hours, do they hold the certificate. Two
 * people can each pass every check and still be the wrong pair — "they cannot
 * both be junior" is not a fact about either of them. No amount of per-person
 * checking reaches it, which is why this is a separate mechanism rather than a
 * sixth eligibility check.
 *
 * ## The three dimensions, and why exactly three
 *
 * They answer different questions and carry different weight, and the UI
 * always names which is in use so nobody mistakes one for another:
 *
 *   - **certification** — *is this person allowed to?* Verified by a manager,
 *     expires on a date. The strongest guarantee here; the system can stand
 *     behind it.
 *   - **seniority** — *has this person done it enough times?* Derived from
 *     completed shifts (see lib/seniority.ts). The supervisor's actual
 *     request; nothing else in the system expressed it.
 *   - **employment_type** — *what are they contracted as?* Already on the
 *     membership, costs one comparison.
 *
 * Free-text tags were considered and deliberately left out. A Certification
 * row is only a name, so an organisation wanting "Keyholder" can create and
 * verify one — the same capability with expiry and an audit trail attached.
 * A fourth kind with weaker guarantees would have been a second place to look
 * for the same thing.
 *
 * ## Why both `at_least` and `at_most`
 *
 * "They cannot both be junior" is a **maximum**. It is only interchangeable
 * with "at least one non-junior" when the headcount is exactly two: on a
 * four-person shift, "at most 1 junior" and "at least 1 senior" are entirely
 * different rules. Supporting only minimums would have quietly mistranslated
 * the requirement everywhere except the example it came from.
 *
 * The two also fail differently, which is what `evaluate` below is really
 * about — see `feasible`.
 */
import { z } from "zod";
import { EMPLOYMENT_TYPE_KEYS, EMPLOYMENT_TYPE_LABELS } from "@/lib/role-config";
import {
  SENIORITY_LEVELS,
  isAtLeast,
  isAtMost,
  seniorityLabel,
  type SeniorityLevel,
} from "@/lib/seniority";

export const COMPOSITION_KINDS = [
  "certification",
  "seniority",
  "employment_type",
] as const;

export type CompositionKind = (typeof COMPOSITION_KINDS)[number];

export const COMPARATORS = ["at_least", "at_most"] as const;

export type Comparator = (typeof COMPARATORS)[number];

export interface CompositionRule {
  kind: CompositionKind;
  /** Certificate name, seniority level, or employment type key. */
  value: string;
  comparator: Comparator;
  count: number;
}

/**
 * Ten is not a technical limit — the evaluation is linear and the JSON is
 * tiny. It is a usability one: a shift needing eleven simultaneous structural
 * rules is a shift nobody can staff, and the manager should hit a message
 * saying so rather than a blocked assignment they cannot explain.
 */
export const MAX_COMPOSITION_RULES = 10;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * `superRefine` rather than a discriminated union, because the constraint is
 * across two fields — which `value`s are legal depends on `kind`, and which
 * `count`s are legal depends on `comparator`. A union would validate each
 * branch's shape but not the relationship.
 */
export const compositionRuleSchema = z
  .object({
    kind: z.enum(COMPOSITION_KINDS),
    value: z.string().min(1).max(200),
    comparator: z.enum(COMPARATORS),
    count: z.number().int().min(0).max(100),
  })
  .superRefine((rule, ctx) => {
    if (rule.kind === "seniority" && !SENIORITY_LEVELS.includes(rule.value as SeniorityLevel)) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `Seniority must be one of: ${SENIORITY_LEVELS.join(", ")}`,
      });
    }
    if (rule.kind === "employment_type" && !EMPLOYMENT_TYPE_KEYS.includes(rule.value)) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `Employment type must be one of: ${EMPLOYMENT_TYPE_KEYS.join(", ")}`,
      });
    }
    // "At least 0 of anything" is satisfied by every possible roster, so it is
    // not a rule — it is a rule the author thinks they have written. Rejected
    // rather than stored, because a constraint that can never bite is worse
    // than no constraint: it reads on the task as though it is protecting
    // something.
    if (rule.comparator === "at_least" && rule.count < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["count"],
        message: "An 'at least' rule needs a count of 1 or more",
      });
    }
  });

export const compositionRulesSchema = z
  .array(compositionRuleSchema)
  .max(MAX_COMPOSITION_RULES);

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/** `null` for an empty list, so a task with no rules stores no JSON at all. */
export function serialiseCompositionRules(rules: CompositionRule[]): string | null {
  return rules.length === 0 ? null : JSON.stringify(rules);
}

/**
 * Parse defensively. The column is TEXT written by an earlier version of this
 * app, a seed script, or a direct database edit, so it can be malformed in
 * ways the API would never allow.
 *
 * A bad value degrades to "no rules" rather than throwing. The alternative is
 * a task that cannot be opened, assigned to or completed because of a stray
 * character in a column that only adds constraints — failing open loses a
 * safeguard, failing closed loses the shift.
 */
export function parseCompositionRules(raw: string | null | undefined): CompositionRule[] {
  if (!raw) return [];
  try {
    const parsed = compositionRulesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/**
 * One assignee, reduced to only what the rules look at.
 *
 * `certifications` are the names of *currently valid* certificates — verified
 * and not expired. Filtering happens in the service, so this module has no
 * opinion about dates and stays pure.
 */
export interface CompositionCandidate {
  membershipId: string;
  memberName?: string;
  seniority: SeniorityLevel;
  certifications: string[];
  employmentType: string | null;
}

/**
 * Certificate names are compared case- and space-insensitively. They are typed
 * by hand in two places — on the certificate and in the rule — so "First Aid"
 * and "first aid" will occur and must not be treated as different requirements.
 */
function normalise(value: string): string {
  return value.trim().toLowerCase();
}

export function matchesRule(rule: CompositionRule, candidate: CompositionCandidate): boolean {
  switch (rule.kind) {
    case "certification":
      return candidate.certifications.some((c) => normalise(c) === normalise(rule.value));

    case "seniority":
      // The comparison runs in opposite directions for the two comparators:
      // "at least 1 Senior" counts senior-and-above, "at most 1 Junior" counts
      // junior-and-below. Anything else makes "at most 1 Junior" silently mean
      // "at most 1 person of any level".
      return rule.comparator === "at_least"
        ? isAtLeast(candidate.seniority, rule.value as SeniorityLevel)
        : isAtMost(candidate.seniority, rule.value as SeniorityLevel);

    case "employment_type":
      return candidate.employmentType === rule.value;
  }
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

export interface RuleStatus {
  rule: CompositionRule;
  /** Assignees currently matching the rule's subject. */
  matched: number;
  /** Holds right now, given who is assigned. */
  satisfied: boolean;
  /**
   * Can still hold once the remaining slots are filled.
   *
   * The two comparators fail at different moments, and this is the difference:
   *
   *   - an `at_least` rule is unsatisfied but perfectly fine while empty slots
   *     remain — it only becomes impossible when the slots run out;
   *   - an `at_most` rule cannot be repaired by assigning more people, since
   *     every further assignment can only hold the count steady or raise it.
   *     Exceeded is final.
   *
   * `satisfied` is what the task view shows. `feasible` is what blocks an
   * assignment, so a manager filling a shift one person at a time is not
   * stopped on the first one for a rule the second one would have met.
   */
  feasible: boolean;
  description: string;
}

export interface CompositionEvaluation {
  rules: RuleStatus[];
  /** Every rule holds as things stand. */
  satisfied: boolean;
  /** No rule has been put beyond reach. */
  feasible: boolean;
}

export function describeRule(rule: CompositionRule): string {
  const comparator = rule.comparator === "at_least" ? "At least" : "At most";
  const people = rule.count === 1 ? "1 assignee" : `${rule.count} assignees`;

  switch (rule.kind) {
    case "certification":
      return `${comparator} ${people} holding ${rule.value}`;
    case "seniority":
      // Spelled out rather than left to the reader. "At most 1 Junior" is
      // ambiguous on the page in a way it is not in the code, and a manager
      // blocked by a rule needs to know which way it reads.
      return rule.comparator === "at_least"
        ? `At least ${people} at ${seniorityLabel(rule.value)} or above`
        : `At most ${people} at ${seniorityLabel(rule.value)} or below`;
    case "employment_type":
      return `${comparator} ${people} who ${rule.count === 1 ? "is" : "are"} ${
        EMPLOYMENT_TYPE_LABELS[rule.value] ?? rule.value
      }`;
  }
}

/**
 * Evaluate every rule against a proposed set of assignees.
 *
 * `requiredHeadcount` is what makes `feasible` meaningful — without it there is
 * no way to know whether an unmet `at_least` rule still has room to be met.
 * Passing a headcount below the number already assigned yields zero remaining
 * slots rather than a negative count, so an over-filled shift reports rules as
 * unreachable instead of arithmetic nonsense.
 */
export function evaluateComposition(
  rules: CompositionRule[],
  candidates: CompositionCandidate[],
  requiredHeadcount: number
): CompositionEvaluation {
  const slotsRemaining = Math.max(0, requiredHeadcount - candidates.length);

  const statuses: RuleStatus[] = rules.map((rule) => {
    const matched = candidates.filter((c) => matchesRule(rule, c)).length;

    const satisfied =
      rule.comparator === "at_least" ? matched >= rule.count : matched <= rule.count;

    const feasible =
      rule.comparator === "at_least"
        ? matched + slotsRemaining >= rule.count
        : matched <= rule.count;

    return { rule, matched, satisfied, feasible, description: describeRule(rule) };
  });

  return {
    rules: statuses,
    satisfied: statuses.every((s) => s.satisfied),
    feasible: statuses.every((s) => s.feasible),
  };
}

/**
 * Why an assignment was refused, in a sentence a manager can act on.
 *
 * Reports the first infeasible rule rather than all of them: the manager
 * changes one thing and tries again, and a list of four failures invites
 * them to give up and override instead of swapping one person.
 */
export function infeasibilityMessage(evaluation: CompositionEvaluation): string | null {
  const broken = evaluation.rules.find((s) => !s.feasible);
  if (!broken) return null;

  if (broken.rule.comparator === "at_most") {
    return `This would break a composition rule: ${broken.description} (would be ${broken.matched})`;
  }
  return `This would leave no room for a composition rule: ${broken.description} (${broken.matched} so far, and no slots left)`;
}

/**
 * Does adding this person move an unmet rule forward, or break a met one?
 *
 * Drives the annotations on the candidate list, so a manager choosing between
 * two eligible people can see which one the shift actually needs — and is
 * warned before picking the one that will be refused.
 */
export function candidateEffect(
  evaluation: CompositionEvaluation,
  candidate: CompositionCandidate
): { helps: string[]; breaks: string[] } {
  const helps: string[] = [];
  const breaks: string[] = [];

  for (const status of evaluation.rules) {
    if (!matchesRule(status.rule, candidate)) continue;

    if (status.rule.comparator === "at_least") {
      if (!status.satisfied) helps.push(status.description);
    } else if (status.matched + 1 > status.rule.count) {
      breaks.push(status.description);
    }
  }

  return { helps, breaks };
}

/**
 * The assign panel's whole composition view, for one moment in the manager's
 * selection.
 *
 * Recomputed on every tick rather than fetched, so it stays a frame ahead of
 * the manager rather than a request behind. Pure, which is the point — this is
 * the part of the panel worth testing, and testing it does not need a rendered
 * page.
 *
 * `effects` deliberately omits anyone already ticked. They are part of the
 * roster the evaluation was computed over, so asking what adding them would do
 * counts them twice — and a manager does not need to be told what the person
 * they just chose would do.
 */
export function annotateSelection(input: {
  rules: CompositionRule[];
  members: CompositionCandidate[];
  assignedMembershipIds: string[];
  selectedMembershipIds: string[];
  requiredHeadcount: number;
}): {
  evaluation: CompositionEvaluation | null;
  effects: Record<string, { helps: string[]; breaks: string[] }>;
} {
  if (input.rules.length === 0) return { evaluation: null, effects: {} };

  const byId = new Map(input.members.map((m) => [m.membershipId, m]));
  const selected = new Set(input.selectedMembershipIds);

  const roster = [...input.assignedMembershipIds, ...input.selectedMembershipIds]
    .map((id) => byId.get(id))
    .filter((c): c is CompositionCandidate => Boolean(c));

  const evaluation = evaluateComposition(
    input.rules,
    roster,
    input.requiredHeadcount
  );

  const effects: Record<string, { helps: string[]; breaks: string[] }> = {};
  for (const member of input.members) {
    if (selected.has(member.membershipId)) continue;
    const effect = candidateEffect(evaluation, member);
    // Only members the rules have something to say about. A badge on everybody
    // is a badge nobody reads.
    if (effect.helps.length > 0 || effect.breaks.length > 0) {
      effects[member.membershipId] = effect;
    }
  }

  return { evaluation, effects };
}

/* ------------------------------------------------------------------ */
/* Admitting people one at a time                                      */
/* ------------------------------------------------------------------ */

/**
 * A task's composition rules, applied to a stream of proposed assignees.
 *
 * ## Why this exists
 *
 * `assignStaff` judges a whole batch at once and throws — right for a manager
 * who picked three people and can be told why the set is wrong. The two batch
 * writers cannot behave that way: the auto-scheduler is filling a week, and
 * discarding twenty legal rows because the twenty-first breaks a rule is worse
 * than writing the twenty. They need to admit what fits and skip what does not,
 * which means asking the question once per person against the set accepted so
 * far.
 *
 * ## The test is the same one `assignStaff` applies
 *
 * A person is admitted when the roster INCLUDING them is still feasible — an
 * `at_most` rule not yet exceeded, an `at_least` rule still reachable in the
 * slots that remain. Deliberately identical, so the generated path cannot write
 * a roster the manual path would refuse; that divergence is the bug this closes.
 *
 * Applying it incrementally is more permissive than applying it to the batch,
 * and that is intended. Two juniors proposed for a two-person shift needing one
 * senior: the batch test refuses both, this admits the first and skips the
 * second, leaving the slot the rule needs. The result is a partial roster rather
 * than none, and nothing illegal is written either way.
 *
 * ## Order
 *
 * Proposals are considered in the order given, which for both draft strategies
 * is the engine's own preference order. It matters — the first junior offered is
 * the one admitted — so callers should not reorder proposals casually.
 */
export interface CompositionGate {
  /**
   * Admit this person if the roster stays feasible with them on it.
   *
   * Records them on success, so the next call sees the fuller roster. Returns
   * false for a membership the gate was not built with: the safe direction when
   * the subject of a rule cannot be evaluated is to refuse.
   */
  admit(membershipId: string): boolean;
  /**
   * Record someone the caller is writing anyway — an assignment a manager has
   * already documented an override for.
   *
   * Without this the gate's picture of the roster would be wrong from that point
   * on, and it would go on judging later proposals against a set missing a
   * person who is really on the shift.
   */
  force(membershipId: string): void;
  /** How many proposals `admit` has turned away, for the caller's reporting. */
  readonly refused: number;
}

export function openCompositionGate(
  rules: CompositionRule[],
  /** Everyone already occupying a slot on the task. */
  assigned: CompositionCandidate[],
  requiredHeadcount: number,
  /** Every person the caller might propose, by membership id. */
  byMembership: Map<string, CompositionCandidate>
): CompositionGate {
  const accepted = [...assigned];
  let refused = 0;

  return {
    admit(membershipId: string): boolean {
      const candidate = byMembership.get(membershipId);
      if (!candidate) {
        refused++;
        return false;
      }

      const next = evaluateComposition(
        rules,
        [...accepted, candidate],
        requiredHeadcount
      );
      if (!next.feasible) {
        refused++;
        return false;
      }

      accepted.push(candidate);
      return true;
    },

    force(membershipId: string): void {
      const candidate = byMembership.get(membershipId);
      if (candidate) accepted.push(candidate);
    },

    get refused() {
      return refused;
    },
  };
}
