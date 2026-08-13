/**
 * What the AI just did, said out loud and undoable.
 *
 * ## Why this exists at all
 *
 * A clean parse now creates and staffs a shift without showing anybody a form
 * — which is the point of an automated product, and also the moment it can be
 * confidently wrong. "Cover the lunch rush Thursday" resolved to the wrong
 * Thursday passes every check the parser makes, gets created, and tells real
 * people they are working it.
 *
 * So the safety is not a confirmation before, it is a statement after: what was
 * made, who is on it, and a way back. The manager reads one line instead of
 * filling in a form, and the wrong result is visible immediately rather than
 * discovered by whoever turns up.
 *
 * ## Why undo says it will notify
 *
 * Because it will, and it must. The staff were told thirty seconds ago that
 * they are on this shift; removing it silently leaves them believing they still
 * are, which is worse than a second notification. `TaskService.delete` already
 * sends the cancellation and already refuses when somebody has actually worked
 * the shift — so this button is honest about a cost it does not get to avoid.
 *
 * ## Why it does not expire
 *
 * No countdown. A timer running out while somebody is reading the sentence is
 * its own kind of annoyance, and there is no cost to leaving the offer open:
 * `delete` enforces the only rule that matters, which is that work already done
 * cannot be erased.
 */
"use client";

import Link from "next/link";
import { ArrowRight, Sparkles, Undo2, X } from "lucide-react";
import { DANGER_GHOST_BUTTON } from "@/components/ui/button-styles";

export function AiResultBanner({
  title,
  assigned,
  required,
  unscheduled = false,
  href,
  undoing = false,
  onUndo,
  onDismiss,
}: {
  /** The task that was created. */
  title: string;
  /** How many people the engine actually placed. */
  assigned: number;
  /** How many the shift asks for. */
  required: number;
  /** True when the proposed time fell outside the project and was dropped. */
  unscheduled?: boolean;
  /** Where to go to look at it. Omitted when already on that page. */
  href?: string;
  undoing?: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  /*
   * Three outcomes, three sentences. "Assigned 0 of 3" is technically what
   * happened when nobody was eligible, but it reads as a maths error rather
   * than as the thing the manager has to act on.
   */
  const staffing =
    assigned === 0
      ? "Nobody eligible was available, so it is unassigned."
      : assigned >= required
        ? `Staffed with ${assigned} of ${required}.`
        : `Assigned ${assigned} of ${required} — ${required - assigned} still open.`;

  return (
    // `my-4`, not `mt-4`: this had space above and none below, so it sat flush
    // against whatever followed it — on the tasks page, the status filter pills.
    <div className="my-4 flex items-start gap-3 rounded-xl border border-indigo-200 bg-indigo-50/70 p-4 dark:border-indigo-900 dark:bg-indigo-950/40">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600/10 dark:bg-indigo-400/10">
        <Sparkles
          className="size-4 text-indigo-600 dark:text-indigo-400"
          aria-hidden="true"
        />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          Created &ldquo;{title}&rdquo;
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{staffing}</p>
        {unscheduled && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            Its suggested time fell outside this project&apos;s timeframe, so it
            was left unscheduled — set the dates to have it staffed.
          </p>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onUndo}
            disabled={undoing}
            className={DANGER_GHOST_BUTTON}
            title={
              assigned > 0
                ? `Removes the shift and tells the ${assigned} assigned it is cancelled`
                : "Removes the shift"
            }
          >
            <Undo2 className="size-3.5" aria-hidden="true" />
            {undoing ? "Removing…" : "Undo"}
          </button>
          {href && (
            <Link
              href={href}
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              Open it
              <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          )}
          {assigned > 0 && (
            <span className="text-xs text-muted-foreground">
              Undo notifies the {assigned} assigned.
            </span>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
