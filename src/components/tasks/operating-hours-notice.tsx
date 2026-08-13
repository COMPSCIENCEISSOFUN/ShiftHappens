/**
 * A warning — never a block — when a shift falls outside the organisation's
 * operating hours.
 *
 * ## Why this warns instead of refusing
 *
 * Blocking was the obvious option and it is the wrong one, for three reasons
 * worth recording so it is not "fixed" later:
 *
 *  1. Organisations legitimately schedule outside their opening hours. Setup,
 *     deliveries, deep cleaning, stocktakes and emergency cover all happen when
 *     the doors are shut. A shift-management product that cannot express those
 *     is not usable.
 *  2. Every task already in the database predates the rule. A hard block at
 *     validation would make an existing out-of-hours task uneditable — open it,
 *     change the title, hit save, get rejected on a field you never touched.
 *  3. Operating hours are a single pair of hours per organisation. They cannot
 *     describe a business whose hours differ by day, and most do. Enforcing a
 *     model that coarse would be enforcing an approximation.
 *
 * So the check informs the person making the decision and then gets out of the
 * way. The eligibility engine is where genuine refusals live, because its rules
 * are about people rather than premises.
 *
 * The notice renders nothing at all when it has nothing to say — no empty box,
 * no "looks fine" reassurance. It appears only when it is telling you something
 * you may not have noticed.
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
