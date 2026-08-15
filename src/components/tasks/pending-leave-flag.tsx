"use client";

import { CalendarOff } from "lucide-react";

export interface LeaveOnThisShift {
  id: string;
  membershipId: string;
  date: string;
  reason: string | null;
}

/** A candidate the engine considers eligible, ranked or not. */
export interface Alternative {
  membershipId: string;
  name: string;
  rank?: number;
}

/**
 * Says when a candidate has asked for this day off and nobody has answered —
 * and offers somebody else.
 */
export function PendingLeaveFlag({
  leave,
  alternatives,
  onPick,
}: {
  leave: LeaveOnThisShift;
  /** Eligible candidates without pending leave, best first. */
  alternatives: Alternative[];
  onPick?: (membershipId: string) => void;
}) {
  const when = new Date(leave.date).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const best = alternatives[0];

  return (
    <span className="mt-0.5 block rounded-md border border-amber-200 bg-amber-50/60 px-2 py-1 text-xs leading-snug dark:border-amber-900 dark:bg-amber-950/30">
      <span className="flex items-center gap-1 font-medium text-amber-800 dark:text-amber-300">
        <CalendarOff className="h-3 w-3 shrink-0" aria-hidden="true" />
        {`Asked ${when} off — awaiting approval`}
      </span>

      {leave.reason && (
        <span className="mt-0.5 block text-amber-700/80 dark:text-amber-400/70">
          {leave.reason}
        </span>
      )}

      {/*
        Only offered when somebody is actually available. "No alternatives" is
        not worth a line — the manager can see the rest of the list.
      */}
      {best && (
        <span className="mt-1 block">
          <button
            type="button"
            onClick={(e) => {
              // The flag sits inside the candidate's own <label>, so a click
              // here would otherwise tick the very person being warned about.
              e.preventDefault();
              e.stopPropagation();
              onPick?.(best.membershipId);
            }}
            className="font-medium text-amber-900 underline underline-offset-2 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-100"
          >
            Pick {best.name} instead
            {best.rank ? ` (ranked #${best.rank})` : ""}
          </button>
        </span>
      )}
    </span>
  );
}
