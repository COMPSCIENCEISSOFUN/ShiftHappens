"use client";

import { useState } from "react";
import { CalendarOff, Check, X } from "lucide-react";

export interface PendingLeave {
  id: string;
  date: string;
  isAvailable: boolean;
  reason: string | null;
  membership: {
    id: string;
    user: { id: string; name: string | null; email: string };
  };
}

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
  onDecide: (id: string, decision: "approved" | "rejected") => Promise<void>;
}) {
  /** Ids currently being decided, so a double click cannot send two verdicts. */
  const [deciding, setDeciding] = useState<string[]>([]);

  if (requests.length === 0) return null;

  async function decide(id: string, decision: "approved" | "rejected") {
    if (deciding.includes(id)) return;
    setDeciding((prev) => [...prev, id]);
    try {
      await onDecide(id, decision);
    } finally {
      setDeciding((prev) => prev.filter((x) => x !== id));
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Leave requests ({requests.length})
      </h3>

      <div className="space-y-2">
        {requests.map((request) => {
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
              className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
                  <CalendarOff className="h-4 w-4" aria-hidden="true" />
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
                    The reason is optional and often the whole decision. Shown
                    rather than truncated behind a click: a manager approving
                    without it is guessing.
                  */}
                  <p className="text-[12px] text-muted-foreground">
                    {request.reason || "No reason given"}
                  </p>
                </div>
              </div>

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
            </div>
          );
        })}
      </div>
    </div>
  );
}
