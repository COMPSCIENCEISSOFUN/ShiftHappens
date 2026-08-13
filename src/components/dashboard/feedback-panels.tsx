/**
 * Staff response and satisfaction panels.
 *
 * These answer the two questions the dashboard could not previously ask,
 * because the data to answer them was being overwritten or never collected:
 *
 *   - **Are people answering, and how fast?** Every status change overwrote
 *     `updatedAt`, so by the time a shift was worked there was no record of
 *     when it had been accepted.
 *   - **Were the shifts any good?** The system recorded in detail why people
 *     said no and nothing at all about the shifts they said yes to and worked.
 *
 * ## The honesty rules, same as the engine panels next door
 *
 * **Denominators are shown, not hidden.** "4.6" from eight responses is not
 * the same finding as "4.6" from four hundred, so the count is never far from
 * the average.
 *
 * **Populations that mean different things stay apart.** An auto-accepted
 * assignment nobody responded to is not a fast response; a pending one is not
 * a refusal. Averaging over all three would produce a flattering number nobody
 * earned, which is exactly the kind of chart that survives a demo and fails a
 * question.
 *
 * **Nothing carries an AI mark.** Neither panel involves a model or an
 * engine — this is recorded fact, and badging it "smart" to match its
 * neighbours would be the dishonesty the engine marks were designed to avoid.
 */
"use client";

import { Clock, MessageSquare, Star } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { BarList, Meter, StackedBar, type Slice } from "@/components/charts/chart-primitives";
import { CATEGORICAL, NEUTRAL } from "@/components/charts/palette";
import { StarRatingDisplay, RATING_LABEL } from "@/components/ui/star-rating";

export interface ResponseStats {
  windowDays: number;
  totalOffered: number;
  answered: number;
  awaiting: number;
  unanswered: number;
  accepted: number;
  declined: number;
  acceptanceRate: number | null;
  medianResponseHours: number | null;
  withinFourHours: number;
  withdrawals: { count: number; medianNoticeHours: number | null; underOneDay: number };
}

export interface SatisfactionStats {
  windowDays: number;
  responses: number;
  rateable: number;
  average: number | null;
  distribution: Record<number, number>;
  byDepartment: { departmentId: string | null; name: string; average: number; responses: number }[];
  engineComparison: {
    topPickAverage: number | null;
    topPickResponses: number;
    otherAverage: number | null;
    otherResponses: number;
  };
  recentComments: { rating: number; comment: string; taskTitle: string; ratedAt: string }[];
}

/** Hours as something a person would say out loud. */
function formatHours(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xl font-bold tracking-tight">{value}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function ResponsePanel({ stats }: { stats: ResponseStats }) {
  const slices: Slice[] = [
    { key: "accepted", label: "Accepted", value: stats.accepted, colour: CATEGORICAL[0] },
    { key: "declined", label: "Declined", value: stats.declined, colour: CATEGORICAL[1] },
    { key: "awaiting", label: "Awaiting reply", value: stats.awaiting, colour: CATEGORICAL[2] },
    // Its own neutral slice for the same reason "Unrecorded" gets one on the
    // allocation panel: an auto-accepted shift is a real assignment and a
    // non-response, and folding it either way misstates one of the two.
    { key: "unanswered", label: "No reply recorded", value: stats.unanswered, colour: NEUTRAL },
  ];

  return (
    <Panel title="Staff response" icon={Clock}>
      <div className="space-y-4 p-4">
        <p className="text-xs text-muted-foreground">
          How the last {stats.windowDays} days of assignments were answered.
        </p>

        {stats.totalOffered === 0 ? (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            No assignments offered in this window, so there is nothing to
            measure yet.
          </p>
        ) : (
          <>
            <StackedBar slices={slices} emptyMessage="No assignments in this window." />

            <div className="grid gap-3 sm:grid-cols-2">
              <Stat
                label="Typical reply"
                value={formatHours(stats.medianResponseHours)}
                detail={`median of ${stats.answered} answered`}
              />
              <Stat
                label="Acceptance"
                value={stats.acceptanceRate === null ? "—" : `${stats.acceptanceRate}%`}
                detail="of assignments actually answered"
              />
            </div>

            {stats.answered > 0 && (
              <Meter
                label="Answered within 4 hours"
                percentage={Math.round((stats.withinFourHours / stats.answered) * 100)}
                detail={`${stats.withinFourHours} of ${stats.answered}`}
                emphasis
              />
            )}

            <p className="text-xs text-muted-foreground">
              The median, not the average — one person accepting after a
              fortnight&apos;s leave would move a mean by most of a day.
              {stats.unanswered > 0 && (
                <>
                  {" "}
                  {stats.unanswered} assignment
                  {stats.unanswered === 1 ? "" : "s"} had no reply recorded
                  (auto-accept, or predating this measurement) and are excluded
                  rather than counted as instant.
                </>
              )}
            </p>

            {stats.withdrawals.count > 0 && (
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Notice before dropping out
                </p>
                <p className="mt-1 text-xs">
                  {stats.withdrawals.count} withdrawal
                  {stats.withdrawals.count === 1 ? "" : "s"}, typically{" "}
                  <span className="font-semibold">
                    {formatHours(stats.withdrawals.medianNoticeHours)}
                  </span>{" "}
                  before the shift.
                  {stats.withdrawals.underOneDay > 0 && (
                    <>
                      {" "}
                      {stats.withdrawals.underOneDay} came with under a day&apos;s
                      warning.
                    </>
                  )}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */

export function SatisfactionPanel({ stats }: { stats: SatisfactionStats }) {
  const responseRate =
    stats.rateable > 0 ? Math.round((stats.responses / stats.rateable) * 100) : null;

  const rows = [5, 4, 3, 2, 1].map((score) => ({
    key: String(score),
    label: `${score} — ${RATING_LABEL[score]}`,
    value: stats.distribution[score] ?? 0,
  }));

  const comparison = stats.engineComparison;
  const bothSides = comparison.topPickAverage !== null && comparison.otherAverage !== null;

  return (
    <Panel title="Shift satisfaction" icon={Star}>
      <div className="space-y-4 p-4">
        <p className="text-xs text-muted-foreground">
          What staff thought of the shifts they worked in the last{" "}
          {stats.windowDays} days. Ratings are optional and given by the staff
          member, not the manager.
        </p>

        {stats.responses === 0 ? (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            Nobody has rated a shift in this window
            {stats.rateable > 0 && ` — ${stats.rateable} could have been rated`}.
            Ratings appear on a staff member&apos;s task list once a shift is
            clocked out of.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  Average
                </p>
                <p className="mt-0.5 text-xl font-bold tracking-tight">
                  {stats.average}
                </p>
                {stats.average !== null && (
                  <StarRatingDisplay value={Math.round(stats.average)} showLabel={false} />
                )}
              </div>
              <Stat
                label="Responses"
                value={String(stats.responses)}
                detail={
                  responseRate === null
                    ? undefined
                    : `${responseRate}% of ${stats.rateable} worked shifts`
                }
              />
            </div>

            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                How the scores fall
              </h4>
              <BarList rows={rows} emptyMessage="No ratings yet." />
            </div>

            {/*
              The join the allocation provenance work was recorded for.
              "The engine's top pick was accepted" and "the engine's top pick
              was a shift the person was glad to work" are different claims,
              and only the second is worth making.
            */}
            {bothSides && (
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Did the engine&apos;s top pick enjoy it more?
                </p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <Stat
                    label="Ranked first"
                    value={String(comparison.topPickAverage)}
                    detail={`${comparison.topPickResponses} responses`}
                  />
                  <Stat
                    label="Ranked lower"
                    value={String(comparison.otherAverage)}
                    detail={`${comparison.otherResponses} responses`}
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  A gap here is the strongest evidence the ranking means
                  something; no gap is worth knowing too, and is the honest
                  result to report.
                </p>
              </div>
            )}

            {!bothSides && (
              <p className="text-xs text-muted-foreground">
                Not enough rated engine-made assignments yet to compare the
                top-ranked pick against the rest. Shown only once both sides
                have enough responses to mean anything.
              </p>
            )}

            {stats.byDepartment.length > 0 && (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  By department, lowest first
                </h4>
                <BarList
                  rows={stats.byDepartment.map((d) => ({
                    key: d.departmentId ?? "none",
                    label: `${d.name} (${d.responses})`,
                    value: d.average,
                  }))}
                  emptyMessage=""
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Departments with too few responses are left out rather than
                  ranked — one bad night should not put a team at the bottom of
                  a list somebody acts on.
                </p>
              </div>
            )}

            {stats.recentComments.length > 0 && (
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <MessageSquare className="h-3 w-3" aria-hidden="true" />
                  What people said
                </h4>
                <ul className="space-y-2">
                  {stats.recentComments.map((c, i) => (
                    <li
                      key={`${c.taskTitle}-${i}`}
                      className="rounded-lg border border-border p-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <StarRatingDisplay value={c.rating} showLabel={false} />
                        <span className="truncate text-xs font-medium">
                          {c.taskTitle}
                        </span>
                      </div>
                      <p className="mt-1 text-xs italic text-muted-foreground">
                        &ldquo;{c.comment}&rdquo;
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
