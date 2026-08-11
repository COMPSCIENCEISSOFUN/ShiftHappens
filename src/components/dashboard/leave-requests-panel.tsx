"use client";

import { useState } from "react";
import { CalendarOff, CalendarX, Check, Trash2, X } from "lucide-react";

export interface PendingLeave {
  id: string;
  date: string;
  isAvailable: boolean;
  reason: string | null;
  /**
   * Its date has already gone by.
   *
   * Computed by the server, on the organisation's calendar day, and not
   * re-derived here — a browser in a different timezone would draw the boundary
   * somewhere else, and the sidebar badge reads the same flag off the same
   * response.
   */
  lapsed: boolean;
  membership: {
    id: string;
    user: { id: string; name: string | null; email: string };
  };
}

export type LeaveDecision = "approved" | "rejected" | "dismissed";

/**
 * Leave awaiting a decision, with the decision attached.
 *
 * ## Why this exists as its own component
 *
 * The approve and reject endpoints shipped before any screen called them, so a
 * full-time member could request leave, managers were notified, and nothing in
 * the product could act on it. Built-and-uncalled is the fourth instance of
 * that pattern in this codebase and the first one written on purpose.
 *
 * Separated from the dashboard rather than inlined because the interesting
 * behaviour is here — that a decision is disabled while it is in flight, and
 * that the row leaves the list once decided — and the dashboard is a page
 * component that needs a mocked world to render at all.
 *
 * ## Empty renders nothing
 *
 * No heading, no "nothing to review" card. This sits among a manager's action
 * items, and an action list that lists non-actions trains people to skip it.
 */
export function LeaveRequestsPanel({
  requests,
  onDecide,
}: {
  requests: PendingLeave[];
  onDecide: (id: string, decision: LeaveDecision) => Promise<void>;
}) {
  /** Ids currently being decided, so a double click cannot send two verdicts. */
  const [deciding, setDeciding] = useState<string[]>([]);

  if (requests.length === 0) return null;

  async function decide(id: string, decision: LeaveDecision) {
    if (deciding.includes(id)) return;
    setDeciding((prev) => [...prev, id]);
    try {
      await onDecide(id, decision);
    } finally {
      setDeciding((prev) => prev.filter((x) => x !== id));
    }
  }

  /*
   * Live first, lapsed last, each group still soonest-first.
   *
   * The server orders by date ascending, which is right within a group and
   * exactly wrong across them: a request nobody answered three weeks ago has
   * the earliest date in the list, so the rows that can no longer be acted on
   * led the queue and pushed tomorrow's below the fold. Sorted here rather than
   * in the repository because this is a question about presenting the work, and
   * the ordering the repository states is the one its other callers want.
   */
  const ordered = [...requests].sort((a, b) => {
    if (a.lapsed !== b.lapsed) return a.lapsed ? 1 : -1;
    return a.date.localeCompare(b.date);
  });
  /*
   * The heading counts what can still be decided. A manager reading "4" needs
   * it to mean four decisions, not three decisions and a tidy-up.
   */
  const liveCount = requests.filter((r) => !r.lapsed).length;
  const lapsedCount = requests.length - liveCount;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Leave requests ({liveCount})
        {lapsedCount > 0 && (
          <span className="ml-2 font-medium normal-case tracking-normal text-muted-foreground/70">
            + {lapsedCount} lapsed
          </span>
        )}
      </h3>

      <div className="space-y-2">
        {ordered.map((request) => {
          const name =
            request.membership.user.name || request.membership.user.email;
          const busy = deciding.includes(request.id);
          const when = new Date(request.date).toLocaleDateString([], {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: "UTC",
          });

          return (
            <div
              key={request.id}
              className={`flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center ${
                request.lapsed
                  ? "border-dashed border-border/70 bg-muted/30"
                  : "border-border bg-card"
              }`}
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                {/*
                  A different icon, not just a paler one. Colour alone would
                  carry the whole distinction, which is no distinction at all
                  for the eight percent of men who cannot see it.
                */}
                <span
                  className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    request.lapsed
                      ? "bg-muted text-muted-foreground"
                      : "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400"
                  }`}
                >
                  {request.lapsed ? (
                    <CalendarX className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <CalendarOff className="h-4 w-4" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">
                    {/*
                      Always "asked off". A contracted member may ask for a day
                      OFF and never to work one on — asking to work a day you
                      are not contracted for is asking to change the contract,
                      which belongs to whoever sets the contracted days. Casual
                      members can still widen their own availability, but theirs
                      is written approved and never reaches this queue.
                    */}
                    {name} — asked off on {when}
                  </p>
                  {/*
                    Says what happened, not just that something did. "Lapsed"
                    alone invites the reading that the system cancelled it; the
                    truth is that nobody answered, and the person who needs to
                    know that is reading this row.
                  */}
                  {request.lapsed && (
                    <p className="text-[12px] font-medium text-amber-700 dark:text-amber-500">
                      Lapsed — the date passed without an answer
                    </p>
                  )}
                  {/*
                    The reason is optional and often the whole decision. Shown
                    rather than truncated behind a click: a manager approving
                    without it is guessing.
                  */}
                  <p className="text-[12px] text-muted-foreground">
                    {request.reason || "No reason given"}
                  </p>
                </div>
              </div>

              {/*
                A lapsed request takes no verdict, because there is nothing left
                to decide: the day happened. Dismissing clears it from the queue
                and records who cleared it, and sends the member nothing — the
                service refuses the other two on this row regardless of what
                this renders, since a queue left open across midnight would
                otherwise show live buttons over a request that has just
                lapsed.
              */}
              {request.lapsed ? (
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => decide(request.id, "dismissed")}
                    disabled={busy}
                    aria-label={`Dismiss lapsed leave request for ${name}`}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Dismiss
                  </button>
                </div>
              ) : (
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => decide(request.id, "approved")}
                  disabled={busy}
                  aria-label={`Approve leave for ${name}`}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-200 px-2.5 py-1.5 text-[12px] font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900 dark:text-emerald-400 dark:hover:bg-emerald-950"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => decide(request.id, "rejected")}
                  disabled={busy}
                  aria-label={`Decline leave for ${name}`}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:border-red-900 dark:hover:bg-red-950 dark:hover:text-red-400"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Decline
                </button>
              </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
