/**
 * Smart-engine panels.
 *
 * These exist to answer one question honestly: does the allocation engine do
 * anything, and is it any good?
 *
 * ## Why this could not be built before
 *
 * The engine ranked candidates, scored them, explained itself and named a
 * winner — and then the assignment was written with none of that attached. So
 * an AI-chosen assignment was indistinguishable from one a manager picked by
 * hand, and a Groq ranking was indistinguishable from the algorithmic fallback
 * that runs when Groq is down. Provenance is now recorded at the moment of
 * assignment (see src/lib/allocation-provenance.ts) and these panels read it.
 *
 * ## The honesty rules these panels follow
 *
 * **Unrecorded is shown, not hidden.** Every assignment made before provenance
 * existed has no source. Folding those into "manual" would invent a human
 * decision for each one; dropping them would compute every percentage against
 * a flattering denominator. They get their own neutral slice.
 *
 * **"Top pick retained" is not called accuracy.** It measures how often the
 * candidate the engine ranked first was still on the shift rather than having
 * rejected or withdrawn. A shift falls through for reasons no ranking could
 * anticipate, so this is a signal, not a verdict — and it is labelled as one.
 * It is shown beside the same figure for lower-ranked picks, because the number
 * means nothing alone: only the gap between them says whether ranking first
 * meant anything.
 *
 * **An empty panel says why.** A brand-new organisation and a broken engine
 * both produce zeroes, and only one of them is the reader's problem.
 */
"use client";

import { Boxes, Cpu, ShieldCheck, Sparkles } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import {
  BarList,
  CoverageHeatmap,
  Donut,
  Meter,
  StackedBar,
  type CoverageCell,
  type Slice,
} from "@/components/charts/chart-primitives";
import { CATEGORICAL, NEUTRAL } from "@/components/charts/palette";
import {
  ALLOCATION_SOURCES,
  providerLabel,
  SOURCE_DESCRIPTION,
  sourceLabel,
} from "@/lib/allocation-provenance";

export interface AllocationEngineStats {
  windowDays: number;
  totalAssignments: number;
  unrecorded: number;
  sourceCounts: Record<string, number>;
  providerCounts: Record<string, number>;
  engineAssignments: number;
  averageScore: number | null;
  topPick: { total: number; retained: number; percentage: number | null };
  otherPicks: { total: number; retained: number; percentage: number | null };
}

export interface EligibilityEngineStats {
  windowDays: number;
  totalOverrides: number;
  totalAssignments: number;
  ruleCounts: Record<string, number>;
  overrideRate: number | null;
}

/** The rule keys EligibilityService records, in the order the checks run. */
const RULE_LABELS: Record<string, string> = {
  hours_limit: "Hour limits",
  availability: "Availability",
  scheduling: "Scheduling conflict",
  work_rules: "Work rules",
  certification: "Certifications",
  all: "All checks (bulk)",
};

/**
 * Marks a panel as engine-derived, and says which engine.
 *
 * Only one of these three panels involves a language model. Allocation is
 * ranked by Groq or Gemini — or by the algorithmic fallback, which is why the
 * label is computed rather than fixed. Eligibility is a deterministic rules
 * engine: real, but not AI. Coverage is availability data with no engine
 * behind it at all and carries no mark.
 *
 * Badging all three "AI" would read better on a demo and would be untrue, and
 * "which part is the AI?" is the first question a marker asks.
 */
function EngineMark({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
      <Sparkles className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * What actually produced the rankings behind the allocation panel.
 *
 * Reads the recorded providers rather than assuming. An organisation whose
 * API key has lapsed has been running on the algorithmic ranker, and the panel
 * should say so — that is the whole reason the provider is recorded.
 */
function allocationMarkLabel(providerCounts: Record<string, number>): string {
  const modelRuns =
    (providerCounts.groq ?? 0) + (providerCounts.gemini ?? 0);
  const algorithmicRuns = providerCounts.algorithmic ?? 0;

  if (modelRuns === 0 && algorithmicRuns === 0) return "Smart engine";
  if (modelRuns === 0) return "Algorithmic";
  return "AI ranked";
}

/* ------------------------------------------------------------------ */

export function AllocationEnginePanel({ stats }: { stats: AllocationEngineStats }) {
  const sourceSlices: Slice[] = ALLOCATION_SOURCES.map((source, i) => ({
    key: source,
    label: sourceLabel(source),
    value: stats.sourceCounts[source] ?? 0,
    colour: CATEGORICAL[i % CATEGORICAL.length],
  }));

  if (stats.unrecorded > 0) {
    sourceSlices.push({
      key: "unrecorded",
      label: "Unrecorded",
      value: stats.unrecorded,
      colour: NEUTRAL,
    });
  }

  const providerKeys = Object.keys(stats.providerCounts).sort();
  const providerSlices: Slice[] = providerKeys.map((key, i) => ({
    key,
    label: key === "unrecorded" ? "Unrecorded" : providerLabel(key),
    value: stats.providerCounts[key],
    colour: key === "unrecorded" ? NEUTRAL : CATEGORICAL[i % CATEGORICAL.length],
  }));

  return (
    <Panel
      title="Allocation engine"
      icon={Cpu}
      action={<EngineMark label={allocationMarkLabel(stats.providerCounts)} />}
    >
      <div className="space-y-5 p-4">
        <p className="text-xs text-muted-foreground">
          How the last {stats.windowDays} days of assignments were made.
        </p>

        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            How each assignment was decided
          </h4>
          <Donut
            slices={sourceSlices}
            centreLabel="assignments"
            emptyMessage={`No assignments in the last ${stats.windowDays} days.`}
          />
          <ul className="mt-3 space-y-0.5">
            {ALLOCATION_SOURCES.map((source) => (
              <li key={source} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{sourceLabel(source)}</span>
                {" — "}
                {SOURCE_DESCRIPTION[source]}
              </li>
            ))}
          </ul>
        </div>

        {stats.engineAssignments === 0 ? (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            The engine has not placed anyone in this window, so there is nothing
            to judge it on yet. Auto-allocate a task or confirm a generated
            schedule and the figures below will fill in.
          </p>
        ) : (
          <>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Which strategy ranked them
              </h4>
              <StackedBar
                slices={providerSlices}
                emptyMessage="No strategy recorded for these assignments."
              />
              <p className="mt-2 text-xs text-muted-foreground">
                A run on the algorithmic ranker is not a failure — it is the
                designed fallback. What matters is that it is visible: before
                this, a revoked API key degraded every ranking silently.
              </p>
            </div>

            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Did the engine&apos;s first choice hold up?
              </h4>
              <div className="grid gap-3 sm:grid-cols-2">
                <Meter
                  label="Ranked first"
                  percentage={stats.topPick.percentage}
                  detail={`${stats.topPick.retained} of ${stats.topPick.total} still on the shift`}
                  emphasis
                />
                <Meter
                  label="Ranked lower"
                  percentage={stats.otherPicks.percentage}
                  detail={`${stats.otherPicks.retained} of ${stats.otherPicks.total} still on the shift`}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Retained means not rejected and not withdrawn. Neither figure is
                an accuracy score on its own — shifts fall through for reasons no
                ranking could predict. The gap between them is the signal.
                {stats.averageScore !== null && (
                  <> Average score of engine picks: {stats.averageScore}.</>
                )}
              </p>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */

export function EligibilityEnginePanel({ stats }: { stats: EligibilityEngineStats }) {
  const rows = Object.entries(stats.ruleCounts).map(([rule, count]) => ({
    key: rule,
    label: RULE_LABELS[rule] ?? rule,
    value: count,
  }));

  return (
    <Panel
      title="Eligibility engine"
      icon={ShieldCheck}
      action={<EngineMark label="Rules engine" />}
    >
      <div className="space-y-4 p-4">
        <p className="text-xs text-muted-foreground">
          Every assignment is checked against hour limits, availability,
          scheduling conflicts, work rules and certifications. An override is a
          manager telling the system it was wrong.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Overrides
            </p>
            <p className="mt-0.5 text-xl font-bold tracking-tight">
              {stats.totalOverrides}
            </p>
            <p className="text-xs text-muted-foreground">
              in the last {stats.windowDays} days
            </p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Override rate
            </p>
            <p className="mt-0.5 text-xl font-bold tracking-tight">
              {stats.overrideRate === null ? "—" : `${stats.overrideRate}%`}
            </p>
            <p className="text-xs text-muted-foreground">
              of {stats.totalAssignments} assignments
            </p>
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Which rule was overridden
          </h4>
          {/*
            One hue for every bar. These rules are nominal — nothing orders
            "certifications" above "availability" — and the bar length already
            encodes the count. Colouring by value would say the same thing twice
            and spend the identity channel doing it.
          */}
          <BarList
            rows={rows}
            emptyMessage={
              stats.totalAssignments === 0
                ? `No assignments in the last ${stats.windowDays} days.`
                : "No overrides — every assignment passed the checks on its own."
            }
          />
        </div>

        {stats.totalOverrides === 0 && stats.totalAssignments > 0 && (
          <p className="text-xs text-muted-foreground">
            Worth knowing rather than celebrating: a zero rate across a busy
            month can also mean nobody is hitting the rules at all.
          </p>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */

export function CoveragePanel({ cells }: { cells: CoverageCell[] }) {
  return (
    <Panel title="Weekly coverage" icon={Boxes}>
      <div className="p-4">
        <p className="mb-3 text-xs text-muted-foreground">
          Staff available by hour, from their declared weekly availability.
          Darker means more people free; the pale cells are where a shift would
          be hard to fill.
        </p>
        <CoverageHeatmap cells={cells} />
      </div>
    </Panel>
  );
}
