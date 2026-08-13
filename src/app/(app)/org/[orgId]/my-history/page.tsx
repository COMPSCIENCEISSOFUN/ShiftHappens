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
  PencilLine,
  Search,
  Star,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";
import {
  OUTCOME_LABEL,
  OUTCOME_NOTE,
  SHIFT_OUTCOMES,
  type ShiftOutcome,
} from "@/lib/shift-outcome";
import { reasonLabel } from "@/lib/decline-reasons";
import { ShiftRating } from "@/components/tasks/shift-rating";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/api-error";

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
  clockCorrectedAt: string | null;
  clockCorrectionReason: string | null;
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
  /** Departments this member has worked in — see the repository. */
  departments: { id: string; name: string; color: string | null }[];
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
            <h4 className="truncate text-sm font-semibold">{row.task.title}</h4>
            <StatusBadge
              value={row.outcome}
              palette="shiftOutcome"
              label={OUTCOME_LABEL[row.outcome]}
            />
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-foreground">
            <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            {shiftWhen(row.task.scheduledStart, row.task.scheduledEnd)}
          </p>
          {row.task.department && (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
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
          <p className="shrink-0 text-base font-semibold tabular-nums">
            {row.hoursWorked.toFixed(1)}h
          </p>
        )}
      </div>

      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}

      {/*
        Shown on the member's own row, not left to an audit screen their plan
        may not include. Somebody else changed the hours they are paid against;
        seeing that on the record is what lets them disagree.
      */}
      {row.clockCorrectedAt && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <PencilLine className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Times corrected by a manager
          {row.clockCorrectionReason ? ` — ${row.clockCorrectionReason}` : ""}
        </p>
      )}
      {reason && (
        <p className="mt-1 text-xs text-muted-foreground">
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
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
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
  const [outcome, setOutcome] = useState<ShiftOutcome | "">("");
  const [department, setDepartment] = useState("");
  /*
   * Two states for the search box: what is typed, and what has been asked for.
   *
   * A request per keystroke would be six round trips to spell "Saturday", each
   * recomputing unpaged totals over the whole range, with the answers free to
   * arrive out of order. The box submits on Enter or on the button, so `search`
   * only changes when the member has finished saying what they want.
   */
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
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
    if (outcome) query.set("outcome", outcome);
    if (department) query.set("department", department);
    if (search) query.set("search", search);

    void (async () => {
      try {
        const res = await fetch(`/api/organizations/${orgId}/my-history?${query}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(apiErrorMessage(body, "Could not load your history"));
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
  }, [orgId, range, page, outcome, department, search, reloadKey]);

  if (loading && !data) return <PageLoading />;

  const summary = data?.summary;
  const filtered = Boolean(outcome || department || search);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">My History</h1>
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
              "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
              range === option.key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input bg-background text-foreground hover:bg-accent"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/*
        Every control resets to page one. Staying on page 4 of a set that now
        has two would show an empty list under a total saying otherwise — and
        the reader would blame the filter rather than the pager.
      */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          aria-label="Outcome"
          value={outcome}
          onChange={(e) => {
            setLoading(true);
            setOutcome(e.target.value as ShiftOutcome | "");
            setPage(1);
          }}
          // bg-background and text-foreground are the point: without them a
          // native select renders light-on-light in dark mode.
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
        >
          <option value="">Any outcome</option>
          {SHIFT_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABEL[o]}
            </option>
          ))}
        </select>

        {/*
          Only worth showing when there is a choice to make. One department is
          not a filter, it is a label — and an organisation with a single
          department would get a control that can only ever do nothing.
        */}
        {data && data.departments.length > 1 && (
          <select
            aria-label="Department"
            value={department}
            onChange={(e) => {
              setLoading(true);
              setDepartment(e.target.value);
              setPage(1);
            }}
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="">All departments</option>
            {data.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}

        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (searchDraft.trim() === search) return;
            setLoading(true);
            setSearch(searchDraft.trim());
            setPage(1);
          }}
        >
          <Input
            aria-label="Search shifts"
            placeholder="Search by shift name"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            className="h-9 text-sm"
          />
          <button type="submit" className={SECONDARY_BUTTON}>
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            Search
          </button>
        </form>

        {(outcome || department || search) && (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => {
              setLoading(true);
              setOutcome("");
              setDepartment("");
              setSearch("");
              setSearchDraft("");
              setPage(1);
            }}
          >
            Clear filters
          </button>
        )}
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
        {/*
          Three empty states below, because three different things are true and
          only one of them is about the member. "You have worked no shifts" is a
          claim about their record; "nothing matches these filters" is a claim
          about the controls they just set — and telling somebody the first when
          the second is true reads as the system losing their history.
        */}
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
            title={filtered ? "Nothing matches" : "Nothing here yet"}
            description={
              filtered
                ? "No shifts in this period match those filters. Try clearing one."
                : range === "all"
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
          <p className="text-sm text-muted-foreground">
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
