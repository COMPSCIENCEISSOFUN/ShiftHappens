/**
 * The composition-rule builder on the task form.
 *
 * ## Why a builder rather than a text field
 *
 * `requiredCertifications` next door is a comma-separated box, and that works
 * because it has one shape: a list of names. A composition rule has four parts
 * and two of them constrain each other — the legal values of `value` depend on
 * `kind`, and a seniority rule reads in opposite directions under the two
 * comparators. Typed free-hand, most attempts would be a 400 the author cannot
 * interpret.
 *
 * ## Why every rule is echoed back in plain English
 *
 * "At most 1 Junior" is ambiguous on a screen in a way it is not in code: does
 * it mean people at exactly that level, or that level and below? The preview
 * says "At most 1 assignee at Junior or below" using the same `describeRule`
 * the refusal message uses, so what the author reads while writing the rule is
 * word-for-word what a blocked manager reads later.
 *
 * ## Why rules are added rather than edited in place
 *
 * A rule is four small choices. Editing one in place needs per-row state,
 * validation and a save affordance; removing and re-adding needs none of it,
 * and the whole interaction is under five seconds either way.
 */
"use client";

import { useState } from "react";
import { Plus, Users, X } from "lucide-react";
import {
  COMPARATORS,
  COMPOSITION_KINDS,
  MAX_COMPOSITION_RULES,
  compositionRuleSchema,
  describeRule,
  type Comparator,
  type CompositionKind,
  type CompositionRule,
} from "@/lib/composition-rules";
import { SENIORITY_LEVELS, SENIORITY_LABEL } from "@/lib/seniority";
import { EMPLOYMENT_TYPE_KEYS, EMPLOYMENT_TYPE_LABELS } from "@/lib/role-config";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<CompositionKind, string> = {
  certification: "Certification",
  seniority: "Seniority",
  employment_type: "Employment type",
};

/** Named so the difference in strength is visible at the point of choosing. */
const KIND_HINT: Record<CompositionKind, string> = {
  certification: "Verified and expiry-checked — the strongest kind",
  seniority: "Derived from completed shifts in this department",
  employment_type: "How the member is contracted",
};

const COMPARATOR_LABEL: Record<Comparator, string> = {
  at_least: "At least",
  at_most: "At most",
};

const SELECT_CLASS =
  "rounded-lg border border-border bg-background px-2 py-1.5 text-xs focus:border-indigo-400 focus:outline-none";

export function CompositionRulesEditor({
  rules,
  onChange,
  disabled,
}: {
  rules: CompositionRule[];
  onChange: (rules: CompositionRule[]) => void;
  disabled?: boolean;
}) {
  const [kind, setKind] = useState<CompositionKind>("seniority");
  const [comparator, setComparator] = useState<Comparator>("at_most");
  const [value, setValue] = useState<string>("junior");
  const [count, setCount] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const atCapacity = rules.length >= MAX_COMPOSITION_RULES;

  /** Each kind carries its own sensible starting value. */
  function changeKind(next: CompositionKind) {
    setKind(next);
    setError(null);
    if (next === "seniority") setValue("junior");
    else if (next === "employment_type") setValue(EMPLOYMENT_TYPE_KEYS[0]);
    else setValue("");
  }

  function add() {
    const candidate = { kind, value: value.trim(), comparator, count };
    const parsed = compositionRuleSchema.safeParse(candidate);

    if (!parsed.success) {
      // The schema's own message, not a rewritten one. It is the same text the
      // API would return, so a rule refused here and a rule refused there
      // cannot say two different things.
      setError(parsed.error.issues[0]?.message ?? "That rule is not valid");
      return;
    }

    // Silently adding a duplicate leaves the author staring at a list that did
    // not change, wondering whether the button worked.
    const exists = rules.some(
      (r) =>
        r.kind === parsed.data.kind &&
        r.comparator === parsed.data.comparator &&
        r.value.toLowerCase() === parsed.data.value.toLowerCase()
    );
    if (exists) {
      setError("That rule is already on this shift");
      return;
    }

    setError(null);
    onChange([...rules, parsed.data]);
    if (kind === "certification") setValue("");
  }

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        Team composition
        <span className="font-normal">Optional</span>
      </p>
      <p className="text-xs text-muted-foreground">
        Rules about the group rather than about each person — &ldquo;not both
        junior&rdquo;, &ldquo;someone with First Aid&rdquo;. Checked when staff are
        assigned; a manager can override with a reason.
      </p>

      {rules.length > 0 && (
        <ul className="space-y-1.5">
          {rules.map((rule, i) => (
            <li
              key={`${rule.kind}-${rule.value}-${rule.comparator}-${i}`}
              className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5"
            >
              <span className="flex-1 text-xs">{describeRule(rule)}</span>
              <span className="rounded-full bg-background px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                {KIND_LABEL[rule.kind]}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(rules.filter((_, index) => index !== i))}
                aria-label={`Remove rule: ${describeRule(rule)}`}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-red-600 dark:hover:text-red-400"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {atCapacity ? (
        <p className="text-xs text-muted-foreground">
          {MAX_COMPOSITION_RULES} rules is the limit. A shift needing more than
          that is one nobody can staff.
        </p>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              aria-label="Comparator"
              value={comparator}
              disabled={disabled}
              onChange={(e) => setComparator(e.target.value as Comparator)}
              className={SELECT_CLASS}
            >
              {COMPARATORS.map((c) => (
                <option key={c} value={c}>
                  {COMPARATOR_LABEL[c]}
                </option>
              ))}
            </select>

            <input
              type="number"
              aria-label="How many assignees"
              min={comparator === "at_least" ? 1 : 0}
              max={50}
              value={count}
              disabled={disabled}
              onChange={(e) => setCount(Number(e.target.value))}
              className={cn(SELECT_CLASS, "w-16")}
            />

            <select
              aria-label="Rule type"
              value={kind}
              disabled={disabled}
              onChange={(e) => changeKind(e.target.value as CompositionKind)}
              className={SELECT_CLASS}
            >
              {COMPOSITION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>

            {kind === "seniority" && (
              <select
                aria-label="Seniority level"
                value={value}
                disabled={disabled}
                onChange={(e) => setValue(e.target.value)}
                className={SELECT_CLASS}
              >
                {SENIORITY_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {SENIORITY_LABEL[level]}
                    {comparator === "at_least" ? " or above" : " or below"}
                  </option>
                ))}
              </select>
            )}

            {kind === "employment_type" && (
              <select
                aria-label="Employment type"
                value={value}
                disabled={disabled}
                onChange={(e) => setValue(e.target.value)}
                className={SELECT_CLASS}
              >
                {EMPLOYMENT_TYPE_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {EMPLOYMENT_TYPE_LABELS[key]}
                  </option>
                ))}
              </select>
            )}

            {kind === "certification" && (
              <input
                type="text"
                aria-label="Certification name"
                value={value}
                disabled={disabled}
                onChange={(e) => setValue(e.target.value)}
                placeholder="e.g. First Aid"
                className={cn(SELECT_CLASS, "min-w-[8rem] flex-1")}
              />
            )}

            <button
              type="button"
              onClick={add}
              disabled={disabled}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-indigo-400"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add
            </button>
          </div>

          <p className="mt-1.5 text-xs text-muted-foreground">
            {KIND_HINT[kind]}
          </p>

          {error && (
            <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
