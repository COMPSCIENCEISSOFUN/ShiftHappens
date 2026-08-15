/**
 * A warning — never a block — when a shift falls outside the organisation's
 * operating hours.
 *
 */
"use client";

import { TriangleAlert } from "lucide-react";
import {
  formatOperatingWindow,
  isWithinOperatingWindow,
} from "@/lib/business-day";

export function OperatingHoursNotice({
  start,
  end,
  operatingHoursStart,
  operatingHoursEnd,
}: {
  /** Value of a `datetime-local` input, or "" when not yet filled in. */
  start: string;
  end: string;
  operatingHoursStart: number;
  operatingHoursEnd: number;
}) {
  if (!start || !end) return null;

  const startDate = new Date(start);
  const endDate = new Date(end);

  // A half-filled or nonsensical range is the schedule validator's business,
  // not this component's — warning about opening hours on top of "end is before
  // start" would only add noise to a message the user already has.
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  if (endDate <= startDate) return null;

  if (
    isWithinOperatingWindow(
      startDate,
      endDate,
      operatingHoursStart,
      operatingHoursEnd
    )
  ) {
    return null;
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
    >
      <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        This falls outside your operating hours (
        {formatOperatingWindow(operatingHoursStart, operatingHoursEnd)}). You can
        still schedule it — this is a heads-up, not a restriction.
      </span>
    </div>
  );
}
