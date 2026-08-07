/**
 * Assignment lifecycle statuses, and the one question everything asks of them:
 * does this row still hold a slot on the shift?
 *
 * ## Why this file exists
 *
 * "Which statuses count toward headcount" was written out by hand in seven
 * places, and at least three of them disagreed:
 *
 *   - The tasks page counted `assignments.length` — every row, including
 *     rejected ones. A shift both assignees had turned down displayed "2/3
 *     staff" with an amber progress bar.
 *   - The dashboard counted `["pending", "accepted"]`, so the same shift read
 *     "needs 3 more staff (0/3 assigned)" on the same data, at the same moment.
 *     Two pages, two numbers, one shift.
 *   - That list also omitted `withdrawal_requested`, which
 *     `TaskAssignmentService.requestWithdrawal` documents as deliberately
 *     holding the slot until a manager decides. A shift nobody had actually
 *     left was reported as needing a replacement.
 *   - The calendar page had it right, in a file-local constant nothing else
 *     could import.
 *
 * None of these were typos. Each was written correctly for the question in
 * front of its author, and the definitions drifted because nothing tied them
 * together. So the rule lives here once and the lists are derived from it.
 *
 * ## The rule
 *
 * A slot is occupied unless the assignment has been given back. Only two
 * statuses give it back: `rejected` (never taken up) and `withdrawn` (taken up
 * and released, with a manager's agreement). Everything else — including
 * `clocked_out` and `completed` — is a person who filled that slot, and a
 * finished shift is the least understaffed a shift can be.
 *
 * ## The same rule answers two questions
 *
 * "Does this hold a seat on the shift?" and "Does this tie up the person's
 * time?" have the same answer for every status, so they share one set rather
 * than two lists that would drift.
 *
 * They drifted once already. When `decline_requested` was added, only the
 * HEADCOUNT sites were routed through here; the eligibility engine, the
 * conflict finder and the allocation filter kept their own hand-written lists
 * on the grounds that they were future-facing and therefore equivalent. That
 * was true of the statuses existing at the time and stopped being true the
 * moment a new one appeared — a full-time member with a pending decline still
 * held the seat but no longer counted toward their own hours, so they could be
 * pushed over a limit or double-booked on a shift they were still rostered on.
 *
 * Which is exactly the failure this module exists to prevent. Anything asking
 * either question uses this set.
 */

/** Lifecycle: pending → accepted → clocked_out → completed. */
export const ASSIGNMENT_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "clocked_out",
  "completed",
  // A full-time member has asked to be taken off a shift they were rostered
  // onto but had not yet accepted. Distinct from withdrawal_requested, which
  // starts from "accepted" and reverts there if denied — denying a decline has
  // to revert to "pending", because a manager refusing the request has not
  // thereby accepted the shift on the member's behalf. Reusing the withdrawal
  // status would have done exactly that.
  "decline_requested",
  "withdrawal_requested",
  "withdrawn",
] as const;

export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/**
 * The two statuses that release the slot.
 *
 * Neither `withdrawal_requested` nor `decline_requested` is here. Both are a
 * question put to a manager, not an answer: until one is approved the member is
 * still rostered, and treating the slot as free would have the engine offer it
 * to someone else while the original assignee is still expected to turn up.
 */
export const RELEASED_STATUSES = ["rejected", "withdrawn"] as const;

/** Everything else — derived, so the two sets cannot drift apart. */
export const OCCUPYING_STATUSES = ASSIGNMENT_STATUSES.filter(
  (s): s is Exclude<AssignmentStatus, (typeof RELEASED_STATUSES)[number]> =>
    !(RELEASED_STATUSES as readonly string[]).includes(s)
);

/**
 * Statuses meaning "this shift was actually worked".
 *
 * `clocked_out` counts as well as `completed`. The final confirmation is a
 * button somebody has to remember to press, and the hours between clocking in
 * and clocking out happened whether or not they did — the seniority derivation
 * already treats the two the same way, and a delete guard that disagreed with
 * it would protect a different set of rows than the one that matters.
 *
 * `clocked_in` is not a status in this system; a shift in progress is
 * `accepted` with a `clockInTime`, which is why the guard checks that column
 * separately rather than looking for a status here.
 */
export const WORKED_STATUSES = ["clocked_out", "completed"] as const;

/** Was this shift actually worked, as opposed to merely rostered? */
export function wasWorked(status: string): boolean {
  return (WORKED_STATUSES as readonly string[]).includes(status);
}

/**
 * Does this assignment still hold a slot on the shift?
 *
 * Takes a plain string rather than `AssignmentStatus`: statuses arrive from
 * `res.json()` and from Prisma as `string`, and a signature that forced a cast
 * at every call site would be quietly defeated by the first `as AssignmentStatus`
 * someone wrote to make the build pass.
 */
export function occupiesSlot(status: string): boolean {
  return !(RELEASED_STATUSES as readonly string[]).includes(status);
}

/** How many of these assignments hold a slot. The headcount numerator. */
export function countOccupied(
  assignments: readonly { status: string }[]
): number {
  return assignments.filter((a) => occupiesSlot(a.status)).length;
}

/**
 * Seats still to fill on a shift.
 *
 * Never negative. Over-assignment should be impossible — `assignStaff` refuses
 * it — but a shift whose headcount was later REDUCED below the number already
 * assigned is legitimately over-filled, and a negative here would flow into a
 * selection cap and a "need -1 more" badge.
 */
export function remainingSlots(
  requiredHeadcount: number,
  assignments: readonly { status: string }[]
): number {
  return Math.max(0, requiredHeadcount - countOccupied(assignments));
}

/**
 * Statuses that occupy a slot, as a mutable array for a Prisma `in` filter.
 *
 * Prisma's generated types want `string[]`, not `readonly string[]`, so this
 * returns a fresh copy rather than exposing the constant to mutation.
 */
export function occupyingStatusFilter(): string[] {
  return [...OCCUPYING_STATUSES];
}
