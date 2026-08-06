"use client";

import { isMonday, mondayOf, shortDateLabel, weekdayName } from "@/lib/schedule-week";

/**
 * Says so when the chosen week does not start on a Monday, and offers to move
 * it.
 *
 * ## Why not just snap the date
 *
 * `mondayOf` and `isMonday` were written, tested, and then left uncalled — the
 * decision at the time was that silently moving a date somebody had just picked
 * is worse than telling them. That was right, but only the half requiring no
 * work got done: the page neither snapped nor said anything, so picking a
 * Wednesday produced a Wednesday-to-Tuesday roster with nothing on screen
 * marking it as unusual.
 *
 * It is deliberately not an error and does not block generating. A seven-day
 * window starting on a Wednesday is a legitimate thing to want, and
 * `confirmSchedule` re-checks headcount so two overlapping drafts cannot
 * double-assign anyone. The problem was never that it is wrong — it is that it
 * is surprising, and a roster nobody thinks in should announce itself.
 */
export function WeekStartNotice({
  weekStart,
  onUseMonday,
  disabled,
}: {
  weekStart: string;
  onUseMonday: (monday: string) => void;
  disabled?: boolean;
}) {
  // Nothing to say about an empty or half-typed date — the page already shows
  // "Pick a date to choose a week" for that.
  const day = weekdayName(weekStart);
  if (!day || isMonday(weekStart)) return null;

  const monday = mondayOf(weekStart);
  const label = shortDateLabel(monday);

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-amber-700 dark:text-amber-400">
      <span>
        This week starts on a {day}. Rosters usually run Monday to Sunday.
      </span>
      {label && (
        <button
          type="button"
          onClick={() => onUseMonday(monday)}
          disabled={disabled}
          className="font-medium underline underline-offset-2 disabled:opacity-60"
        >
          Use {label} instead
        </button>
      )}
    </p>
  );
}
