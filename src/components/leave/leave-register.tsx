"use client";

/**
 * The leave register — every request that went through review, filtered.
 *
 */

import { useCallback, useEffect, useState } from "react";
import {
  CalendarOff,
  CalendarX,
  Check,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { DATE_RANGE_MESSAGE, parseDateRange } from "@/lib/date-range";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import {
  LEAVE_TILE_VIEWS,
  LEAVE_VIEWS,
  LEAVE_VIEW_EMPTY,
  LEAVE_VIEW_LABEL,
  DEFAULT_LEAVE_VIEW,
  type LeaveView,
} from "@/lib/leave-filters";
import type { LeaveDecision } from "@/components/dashboard/leave-requests-panel";
import { apiErrorMessage } from "@/lib/api-error";

export interface RegisterRow {
  id: string;
  date: string;
  isAvailable: boolean;
  reason: string | null;
  status: string;
  lapsed: boolean;
  /** Still answerable, but running out of time. Never true once lapsed. */
  closingSoon: boolean;
  membership: { id: string; user: { name: string | null; email: string } };
  reviewedBy: { name: string | null; email: string } | null;
  departments: { id: string; name: string; color: string | null }[];
}

interface Register {
  rows: RegisterRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Keyed by view, over the reader's whole scope — see `getLeaveRegister`. */
  counts: Record<string, number>;
  /** Waiting, and running out of time. A subset of `counts.awaiting`. */
  closingSoon: number;
}

const EMPTY: Register = {
  rows: [],
  total: 0,
  page: 1,
  pageSize: 50,
  counts: {},
  closingSoon: 0,
};

/**
 * How each tile is tinted, and when its number is worth colouring.
 *
 * Only the two open states get a coloured value. Approved and declined are
 * history — a figure that is neither good nor bad nor owed to anybody — and
 * colouring all four would leave nothing for the eye to land on.
 */
const TILE_STYLE: Record<
  (typeof LEAVE_TILE_VIEWS)[number],
  { accent: string; detail: string; colour?: (n: number) => string }
> = {
  awaiting: {
    accent: STAT_ACCENT.amber,
    detail: "waiting on a decision",
    colour: (n) => (n > 0 ? "text-amber-600 dark:text-amber-400" : ""),
  },
  lapsed: {
    accent: STAT_ACCENT.slate,
    detail: "never answered",
    colour: (n) => (n > 0 ? "text-red-600 dark:text-red-400" : ""),
  },
  approved: { accent: STAT_ACCENT.green, detail: "granted" },
  declined: { accent: STAT_ACCENT.red, detail: "not granted" },
};

/**
 * What a row says it is.
 *
 * Driven off `lapsed` before `status`, because a lapsed request IS pending —
 * the row's own column cannot tell the two apart, which is the whole reason
 * the flag exists.
 */
function rowState(row: RegisterRow) {
  if (row.status === "pending") {
    if (row.lapsed) return { label: "Lapsed", tone: "bg-muted text-muted-foreground" };
    /*
     * Three states, not two, because "unanswered" and "unanswered and running
     * out of time" are different problems. Without this a request for tomorrow
     * and one for October read identically — same label, same weight — and the
     * one about to become a failure is invisible among the ones that are fine.
     *
     * Says nothing about whether the reviewers have been chased. A row must not
     * stop looking urgent because a reminder went out.
     */
    if (row.closingSoon) {
      return {
        label: "Closing soon",
        tone: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
      };
    }
    return {
      label: "Awaiting decision",
      tone: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    };
  }
  if (row.status === "approved") {
    return { label: "Approved", tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" };
  }
  if (row.status === "dismissed") {
    return { label: "Dismissed", tone: "bg-muted text-muted-foreground" };
  }
  // The column stores "rejected"; every screen has always said "Declined".
  return { label: "Declined", tone: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" };
}

export function LeaveRegister({
  orgId,
  departments,
  canReview,
  onChanged,
}: {
  orgId: string;
  departments: { id: string; name: string; color: string | null }[];
  canReview: boolean;
  /** Fired after a decision, so the sidebar badge can catch up. */
  onChanged?: () => void;
}) {
  const [view, setView] = useState<LeaveView>(DEFAULT_LEAVE_VIEW);
  const [departmentId, setDepartmentId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<Register>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string[]>([]);
  const [sweeping, setSweeping] = useState(false);

  const load = useCallback(async () => {
    /*
     * A reversed range is not sent. The server refuses it too — this is not the
     * guard, it is the manners: the reader gets told what is wrong with what
     * they typed instead of watching a list empty itself and come back.
     *
     * `setLoading(false)` before returning, or a range corrected mid-load leaves
     * the spinner up forever.
     */
    const range = parseDateRange(from, to);
    if (range.problem) {
      setError(DATE_RANGE_MESSAGE[range.problem]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const q = new URLSearchParams({ view, page: String(page) });
      if (departmentId) q.set("departmentId", departmentId);
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      if (search.trim()) q.set("search", search.trim());

      const res = await fetch(`/api/organizations/${orgId}/leave?${q}`);
      const body = await res.json();
      if (!res.ok || !Array.isArray(body?.rows)) {
        setError(typeof body?.error === "string" ? body.error : "Failed to load");
        setData(EMPTY);
        return;
      }
      setData(body);
      setError(null);
    } catch {
      setError("Failed to load");
      setData(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [orgId, view, departmentId, from, to, search, page]);

  /*
   * Debounced, and only for the text box.
   *
   * A dropdown is one deliberate act and should fetch at once; a search box is
   * one act per keystroke, and "sarah" would otherwise be five requests whose
   * answers can arrive out of order. 300ms is below the threshold where typing
   * feels like waiting.
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: refetches the register when a filter changes
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  /* A filter change invalidates the page number: page 4 of a narrower list may
   * not exist, and a reader who lands on an empty page reads it as no results. */
  function change<T>(set: (v: T) => void) {
    return (value: T) => {
      set(value);
      setPage(1);
    };
  }

  async function decide(id: string, decision: LeaveDecision) {
    if (deciding.includes(id)) return;
    setDeciding((prev) => [...prev, id]);
    try {
      const res = await fetch(`/api/organizations/${orgId}/leave/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(apiErrorMessage(body, "Failed to record the decision"));
        return;
      }
      setError(null);
      // Refetched rather than spliced: the row moves between filters when its
      // status changes, and a second reviewer may have answered something else
      // in the list while this one was deciding.
      await load();
      onChanged?.();
    } finally {
      setDeciding((prev) => prev.filter((x) => x !== id));
    }
  }

  /**
   * Clears every lapsed request at once.
   *
   * Offered only on the Lapsed view. On a mixed list it would be a button whose
   * effect is invisible — a reader looking at forty rows cannot see which three
   * it would touch, and a bulk action you cannot see the scope of is one people
   * learn not to press.
   *
   * Reports what it could NOT do. A sweep that silently does nine of ten is
   * worse than one that does none, and a skip is real here: a manager's own
   * lapsed request is refused by the same rule that stops them approving it.
   */
  async function dismissAllLapsed() {
    if (sweeping) return;
    setSweeping(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/leave/dismiss-lapsed`,
        { method: "POST" }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(apiErrorMessage(body, "Failed to dismiss"));
        return;
      }
      setError(
        body.skipped > 0
          ? `Dismissed ${body.dismissed}. ${body.skipped} could not be — your own requests need somebody else.`
          : null
      );
      await load();
      onChanged?.();
    } finally {
      setSweeping(false);
    }
  }

  const filtered =
    Boolean(departmentId || from || to || search.trim()) ||
    view !== DEFAULT_LEAVE_VIEW;

  function clearFilters() {
    setView(DEFAULT_LEAVE_VIEW);
    setDepartmentId("");
    setFrom("");
    setTo("");
    setSearch("");
    setPage(1);
  }
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div className="space-y-4">
      {/* ── Tiles ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        {LEAVE_TILE_VIEWS.map((v) => {
          const n = data.counts[v] ?? 0;
          const style = TILE_STYLE[v];
          return (
            <StatTile
              key={v}
              label={LEAVE_VIEW_LABEL[v]}
              value={n}
              /*
                The urgent subset goes in the caption rather than into a fifth
                tile: it is part of this number, and a row of tiles whose
                figures overlap invites a reader to add them up.
              */
              detail={
                v === "awaiting" && data.closingSoon > 0
                  ? `${data.closingSoon} closing soon`
                  : style.detail
              }
              accentColour={style.accent}
              valueColour={style.colour?.(n)}
            />
          );
        })}
      </div>

      {/* ── Search & Filters ────────────────────────────────── */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => change(setSearch)(e.target.value)}
            aria-label="Search by name or email"
            className="h-9 pl-9 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/*
            A select, not a row of chips. Status was chips while it was the only
            way to see how many lapsed requests existed; the tiles above carry
            that now, so the control can be the same shape as every other filter
            on every other page.
          */}
          <select
            value={view}
            onChange={(e) => change(setView)(e.target.value as LeaveView)}
            aria-label="Filter by status"
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground"
          >
            {LEAVE_VIEWS.map((v) => (
              <option key={v} value={v}>
                {LEAVE_VIEW_LABEL[v]}
              </option>
            ))}
          </select>

          {/*
            Hidden from a reader who holds one department: a dropdown whose only
            option is the answer it already has cannot do anything, and offering
            it implies the others exist.
          */}
          {departments.length > 1 && (
            <select
              value={departmentId}
              onChange={(e) => change(setDepartmentId)(e.target.value)}
              aria-label="Filter by department"
              className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground"
            >
              <option value="">All depts</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}

          {/* `max`/`min` bound each picker by the other, the pattern the audit
              log already used — it stops most reversals at the calendar rather
              than reporting them afterwards. Not a guard: a typed or pasted
              value slips past it in several browsers, and a hand-written URL
              never sees it at all, which is why the rule is also enforced in
              `parseDateRange` and again in the service. */}
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => change(setFrom)(e.target.value)}
            aria-label="Leave on or after"
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground"
          />
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => change(setTo)(e.target.value)}
            aria-label="Leave on or before"
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground"
          />

          {/*
            One control to undo all of them. Four filters deep, a reader has to
            remember which four they set — and the one they forget is the one
            that makes the list look empty.
          */}
          {canReview && view === "lapsed" && data.total > 0 && (
            <button
              type="button"
              onClick={dismissAllLapsed}
              disabled={sweeping}
              className="flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {sweeping ? "Dismissing…" : `Dismiss all ${data.total}`}
            </button>
          )}

          {filtered && (
            <button
              type="button"
              onClick={clearFilters}
              className="h-9 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {/* ── Rows ────────────────────────────────────────────── */}
      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Loading…
        </p>
      ) : data.rows.length === 0 ? (
        <EmptyState
          icon={CalendarOff}
          title="Nothing here"
          /* Says which filter is empty, not just that something is. "No
             results" is true of a filter nobody has used and of one just
             narrowed too far, and those need different next moves. */
          description={
            filtered
              ? "No requests match these filters."
              : LEAVE_VIEW_EMPTY[view]
          }
        />
      ) : (
        <div className="space-y-2">
          {data.rows.map((row) => {
            const state = rowState(row);
            const name = row.membership.user.name || row.membership.user.email;
            const busy = deciding.includes(row.id);
            const when = new Date(row.date).toLocaleDateString([], {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
              timeZone: "UTC",
            });
            const undecided = row.status === "pending";

            return (
              <div
                key={row.id}
                className={`flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center ${
                  row.lapsed
                    ? "border-dashed border-border/70 bg-muted/30"
                    : "border-border bg-card"
                }`}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  {/* A different icon, not just a paler one — colour alone is
                      no distinction at all for a reader who cannot see it. */}
                  <span
                    className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      row.lapsed
                        ? "bg-muted text-muted-foreground"
                        : "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400"
                    }`}
                  >
                    {row.lapsed ? (
                      <CalendarX className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <CalendarOff className="h-4 w-4" aria-hidden="true" />
                    )}
                  </span>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">
                        {name} — asked off on {when}
                      </p>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${state.tone}`}
                      >
                        {state.label}
                      </span>
                      {row.departments.map((d) => (
                        <span
                          key={d.id}
                          className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
                          style={{
                            backgroundColor: `${d.color || "#94A3B8"}1a`,
                            color: d.color || "#64748B",
                          }}
                        >
                          {d.name}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {row.reason || "No reason given"}
                      {/* Who answered it, on the rows where somebody did. The
                          audit log had this and nothing else did, so "who
                          approved Sam's July leave" had no answer on screen. */}
                      {row.reviewedBy && (
                        <>
                          {" · "}
                          {state.label} by{" "}
                          {row.reviewedBy.name || row.reviewedBy.email}
                        </>
                      )}
                    </p>
                  </div>
                </div>

                {canReview && undecided && (
                  <div className="flex shrink-0 gap-2">
                    {row.lapsed ? (
                      <button
                        type="button"
                        onClick={() => decide(row.id, "dismissed")}
                        disabled={busy}
                        aria-label={`Dismiss lapsed leave request for ${name}`}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Dismiss
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => decide(row.id, "approved")}
                          disabled={busy}
                          aria-label={`Approve leave for ${name}`}
                          className="flex items-center gap-1.5 rounded-lg border border-emerald-200 px-2.5 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900 dark:text-emerald-400 dark:hover:bg-emerald-950"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => decide(row.id, "rejected")}
                          disabled={busy}
                          aria-label={`Decline leave for ${name}`}
                          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:border-red-900 dark:hover:bg-red-950 dark:hover:text-red-400"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                          Decline
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Paging ──────────────────────────────────────────── */}
      {data.total > data.pageSize && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {/* States the cap. A page that shows fifty of three hundred without
              saying so reads as complete coverage. */}
          <span>
            Showing {(data.page - 1) * data.pageSize + 1}–
            {Math.min(data.page * data.pageSize, data.total)} of {data.total}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={data.page <= 1}
              className="rounded-lg border border-border px-2.5 py-1.5 font-medium transition-colors hover:bg-muted disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={data.page >= pages}
              className="rounded-lg border border-border px-2.5 py-1.5 font-medium transition-colors hover:bg-muted disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
