/**
 * My Shift History (Boundary Layer)
 *
 * The member's own record: what they worked, what they turned down, what was
 * called off, and how many hours the clock actually captured.
 *
 * ## Why this is not a tab on My Tasks
 *
 * My Tasks is a to-do list read standing up, on a phone, to answer "am I on
 * tonight". It already collapses finished work behind a count, which is right
 * for that question and wrong for this one — a history is read sitting down,
 * against a payslip or before a conversation with a manager, and it needs a
 * date range, totals, and every row rather than the last three.
 *
 * ## The totals are honest about what they cannot measure
 *
 * `hoursWorked` counts complete clock pairs only. A shift somebody clocked into
 * and never out of contributes nothing, and the tile says how many did that
 * rather than quietly filling the gap with the scheduled span — which would
 * produce a number that looks measured on exactly the rows where it is not.
 *
 * ## Not for admins
 *
 * The sidebar hides the link and the route returns 403, both from
 * `canBeRostered`. An admin cannot be put on a shift, so an empty page here
 * would give the wrong reason for being empty.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  History,
  Inbox,
  Star,
} from "lucide-react";

import { Panel } from "@/components/ui/panel";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { OUTCOME_LABEL, OUTCOME_NOTE, type ShiftOutcome } from "@/lib/shift-outcome";
import { reasonLabel } from "@/lib/decline-reasons";
import { ShiftRating } from "@/components/tasks/shift-rating";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface HistoryRow {
  id: string;
  status: string;
  outcome: ShiftOutcome;
  hoursWorked: number | null;
  clockInTime: string | null;
  clockOutTime: string | null;
  rejectionReason: string | null;
  rejectionNotes: string | null;
  withdrawalReason: string | null;
  withdrawalNotes: string | null;
  satisfactionRating: number | null;
  satisfactionComment: string | null;
  task: {
    id: string;
    title: string;
    status: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    department: { id: string; name: string; color: string | null } | null;
  };
}

interface HistoryResponse {
  rows: HistoryRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: {
    shiftsInRange: number;
    shiftsWorked: number;
    hoursWorked: number;
    shiftsMissingHours: number;
    ratedShifts: number;
    averageRating: number | null;
    unratedWorkedShifts: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Range options                                                      */
/* ------------------------------------------------------------------ */

/**
 * Fixed ranges rather than two date pickers.
 *
 * Nobody arrives here wanting 14 March to 2 June. They want "this month, for
 * my payslip" or "everything", and a pair of pickers makes the common case four
 * interactions and the rare case possible. `days: null` is everything.
 */
const RANGES = [
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 3 months", days: 90 },
  { key: "365", label: "Last year", days: 365 },
  { key: "all", label: "All time", days: null },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

/* ------------------------------------------------------------------ */
/*  Formatting                                                         */
/* ------------------------------------------------------------------ */

/** "Fri 3 Oct 2026, 17:00 — 21:00". The year matters in a history. */
function shiftWhen(start: string | null, end: string | null): string {
  if (!start) return "No date recorded";

  const from = new Date(start);
  const day = from.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const fromTime = from.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (!end) return `${day}, ${fromTime}`;

  const to = new Date(end);
  const toTime = to.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  // A shift crossing midnight needs its second date, or "23:00 — 07:00" reads
  // as a day running backwards.
  const sameDay = from.toDateString() === to.toDateString();
  return sameDay
    ? `${day}, ${fromTime} — ${toTime}`
    : `${day}, ${fromTime} — ${to.toLocaleDateString([], {
        weekday: "short",
        day: "numeric",
        month: "short",
      })}, ${toTime}`;
}

/** The member's own words about a shift they came off, whichever field holds them. */
function ownReason(row: HistoryRow): string | null {
  const reason = row.withdrawalReason ?? row.rejectionReason;
  if (!reason) return null;
  const notes = row.withdrawalNotes ?? row.rejectionNotes;
  return notes ? `${reasonLabel(reason)} — ${notes}` : reasonLabel(reason);
}

/* ------------------------------------------------------------------ */
/*  Row                                                                */
/* ------------------------------------------------------------------ */

function HistoryEntry({
  row,
  orgId,
  onRated,
}: {
  row: HistoryRow;
  orgId: string;
  onRated: () => void;
}) {
  const note = OUTCOME_NOTE[row.outcome];
  const reason = ownReason(row);

  return (
    <div className="px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {/* Truncates rather than wrapping the badge onto its own line. */}
            <h4 className="truncate text-[14px] font-semibold">{row.task.title}</h4>
            <StatusBadge
              value={row.outcome}
              palette="shiftOutcome"
              label={OUTCOME_LABEL[row.outcome]}
            />
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] text-foreground">
            <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            {shiftWhen(row.task.scheduledStart, row.task.scheduledEnd)}
          </p>
          {row.task.department && (
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: row.task.department.color ?? "#94a3b8" }}
              />
              {row.task.department.name}
            </p>
          )}
        </div>

        {row.hoursWorked !== null && (
          <p className="shrink-0 text-[15px] font-semibold tabular-nums">
            {row.hoursWorked.toFixed(1)}h
          </p>
        )}
      </div>

      {note && <p className="mt-2 text-[12px] text-muted-foreground">{note}</p>}
      {reason && (
        <p className="mt-1 text-[12px] text-muted-foreground">
          Your reason: {reason}
        </p>
      )}
      {/*
        Rating lives here now, not on My Tasks.
        
        It was on the to-do page, which shows a member the last three finished
        shifts behind a toggle — so "34 left to rate" pointed at a screen that
        would show three of them. Reflection on a shift belongs beside the
        record of it, with the date and the hours in view.

        Only worked shifts: `rate()` refuses anything else, and offering the
        stars on a shift somebody declined would invite an error the service is
        going to reject.
      */}
      {row.outcome === "worked" ? (
        <ShiftRating
          assignmentId={row.id}
          orgId={orgId}
          rating={row.satisfactionRating}
          comment={row.satisfactionComment}
          onSaved={onRated}
        />
      ) : (
        row.satisfactionRating !== null && (
          <p className="mt-1 flex items-center gap-1 text-[12px] text-muted-foreground">
            <Star className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
            You rated this {row.satisfactionRating}/5
            {row.satisfactionComment ? ` — ${row.satisfactionComment}` : ""}
          </p>
        )
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function MyHistoryPage() {
  const params = useParams();
  const orgId = params.orgId as string;

  const [data, setData] = useState<HistoryResponse | null>(null);
  const [range, setRange] = useState<RangeKey>("90");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /*
   * Bumped when a rating is saved. The summary tiles are derived server-side
   * over the whole range, so a rating changes "your average rating" and "left
   * to rate" — updating the row in place would leave both tiles disagreeing
   * with the list directly beneath them.
   */
  const [reloadKey, setReloadKey] = useState(0);

  /*
   * The spinner is switched on by whatever CAUSED the reload — the range and
   * page buttons below — rather than at the top of this effect. Setting it here
   * would be a synchronous setState inside an effect, which React flags as a
   * cascading render, and `loading` already starts true for the first load.
   *
   * `cancelled` matters more than it looks. Clicking through three ranges
   * quickly fires three requests, and without this the slowest to return wins
   * — the list showing one range's shifts under another range's heading, with
   * every total on the page agreeing with neither.
   */
  useEffect(() => {
    let cancelled = false;

    const days = RANGES.find((r) => r.key === range)?.days ?? null;
    const query = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (days !== null) {
      query.set("from", new Date(Date.now() - days * 86_400_000).toISOString());
    }

    void (async () => {
      try {
        const res = await fetch(`/api/organizations/${orgId}/my-history?${query}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Could not load your history");
        }
        const payload = await res.json();
        if (cancelled) return;
        setData(payload);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // The list is cleared alongside the error. Leaving the previous range's
        // rows under a message saying the load failed would show one range's
        // shifts under another range's heading.
        setData(null);
        setError(err instanceof Error ? err.message : "Could not load your history");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orgId, range, page, reloadKey]);

  if (loading && !data) return <PageLoading />;

  const summary = data?.summary;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">My History</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every shift you have finished with — worked, turned down, or called off.
        </p>
      </div>

      {error && <AlertBanner variant="error" message={error} />}

      {/* Range picker. Changing it resets to page one: staying on page 4 of a
          range that now has two pages would show an empty list under a total
          saying otherwise. */}
      <div className="flex flex-wrap gap-2">
        {RANGES.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => {
              if (option.key === range) return;
              setLoading(true);
              setRange(option.key);
              setPage(1);
            }}
            aria-pressed={range === option.key}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors",
              range === option.key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input bg-background text-foreground hover:bg-accent"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {/*
            "41" over "44 in this period" read as a contradiction — the detail
            line never said what the 44 counted, so the two numbers looked like
            two answers to the same question. They are not: 44 shifts entered
            this member's history, 41 of which were worked and the rest declined,
            cancelled or never clocked into.
          */}
          <StatTile
            label="Shifts worked"
            value={summary.shiftsWorked}
            detail={
              summary.shiftsInRange === summary.shiftsWorked
                ? "Every shift in this period"
                : `of ${summary.shiftsInRange} shifts in this period`
            }
            accentColour={STAT_ACCENT.green}
          />
          <StatTile
            label="Hours worked"
            value={`${summary.hoursWorked}h`}
            detail={
              summary.shiftsMissingHours > 0
                ? `${summary.shiftsMissingHours} shift${
                    summary.shiftsMissingHours === 1 ? "" : "s"
                  } not counted`
                : "From your clock in and out"
            }
            accentColour={STAT_ACCENT.blue}
            valueColour={
              summary.shiftsMissingHours > 0
                ? "text-amber-600 dark:text-amber-400"
                : undefined
            }
          />
          <StatTile
            label="Your average rating"
            // An unrated history has no average, and "0.0" would read as a
            // score rather than an absence.
            value={summary.averageRating === null ? "—" : `${summary.averageRating}/5`}
            detail={
              summary.ratedShifts === 0
                ? "You have not rated a shift yet"
                : `From ${summary.ratedShifts} rated shift${
                    summary.ratedShifts === 1 ? "" : "s"
                  }`
            }
            accentColour={STAT_ACCENT.amber}
          />
          <StatTile
            label="Left to rate"
            value={summary.unratedWorkedShifts}
            detail={
              summary.unratedWorkedShifts > 0
                ? "Rate them from My Tasks"
                : "Nothing waiting"
            }
            accentColour={STAT_ACCENT.slate}
          />
        </div>
      )}

      <Panel
        title="Shifts"
        icon={History}
        count={data?.total ?? 0}
        bodyClassName="divide-y divide-border"
        action={
          <Link href={`/org/${orgId}/my-tasks`} className={SECONDARY_BUTTON}>
            My Tasks
          </Link>
        }
      >
        {data && data.rows.length > 0 ? (
          data.rows.map((row) => (
            <HistoryEntry
              key={row.id}
              row={row}
              orgId={orgId}
              onRated={() => setReloadKey((k) => k + 1)}
            />
          ))
        ) : (
          <EmptyState
            icon={Inbox}
            title="Nothing here yet"
            description={
              range === "all"
                ? "Shifts appear here once they have finished, or once you turn one down."
                : "No finished shifts in this period. Try a wider range."
            }
          />
        )}
      </Panel>

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={data.page <= 1 || loading}
            onClick={() => {
              setLoading(true);
              setPage((p) => Math.max(1, p - 1));
            }}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Previous
          </button>
          <p className="text-[13px] text-muted-foreground">
            Page {data.page} of {data.totalPages}
          </p>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={data.page >= data.totalPages || loading}
            onClick={() => {
              setLoading(true);
              setPage((p) => p + 1);
            }}
          >
            Next
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
