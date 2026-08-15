"use client";

import { isMonday, mondayOf, shortDateLabel, weekdayName } from "@/lib/schedule-week";

/**
 * Says so when the chosen week does not start on a Monday, and offers to move
 * it.
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
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-amber-700 dark:text-amber-400">
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
