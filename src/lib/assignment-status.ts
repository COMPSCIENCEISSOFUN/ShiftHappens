/**
 * Assignment lifecycle statuses, and the one question everything asks of them:
 * does this row still hold a slot on the shift?
 *
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

/**
 * Statuses an assignment can only be in if it was accepted at some point.
 *
 * Clocking in requires `accepted` — `clockIn` refuses anything else — so these
 * are the only rows that can legitimately carry a clock time, and therefore the
 * only ones a clock CORRECTION can be about.
 *
 * Derived by exclusion rather than listed, for the reason this whole module
 * exists: a hand-written list is how "which statuses count" came to be written
 * seven times with three of them disagreeing. The three excluded here are the
 * ones reachable without ever accepting — `pending` has not been answered,
 * `rejected` was refused, and `decline_requested` is a refusal awaiting a
 * decision, which starts from `pending` and returns there if denied.
 *
 * `withdrawn` IS included even though it releases the slot: a member can clock
 * in and then ask to leave, so those times exist and may need correcting. The
 * safe direction is offering a manager a control they do not need rather than
 * hiding one they do.
 */
export const NEVER_ACCEPTED_STATUSES = [
  "pending",
  "rejected",
  "decline_requested",
] as const;

/**
 * Could this assignment hold clock times?
 *
 * The tasks page offered "Add times" on every assignment regardless of status,
 * so a manager was invited to record hours against a shift somebody had
 * REJECTED — inventing attendance for a person who was never on it, on the
 * field every hours total and capacity figure is built from.
 */
export function canHoldClockTimes(status: string): boolean {
  return !(NEVER_ACCEPTED_STATUSES as readonly string[]).includes(status);
}

/** How many of these assignments hold a slot. The headcount numerator. */
export function countOccupied(
  assignments: readonly { status: string }[]
): number {
  return assignments.filter((a) => occupiesSlot(a.status)).length;
}

/**
 * Seats still to fill, given a count that has ALREADY been filtered.
 *
 * Never negative. Over-assignment should be impossible — `assignStaff` refuses
 * it — but a shift whose headcount was later REDUCED below the number already
 * assigned is legitimately over-filled, and a negative here flows into a
 * selection cap and a "needs -1 more" badge.
 *
 * Exists as its own function because three callers hold the occupied COUNT and
 * not the rows: the calendar's assign modal takes it as a prop, and the
 * calendar's two "needs n more" labels have already computed it for the badge
 * beside them. All three wrote the subtraction by hand and all three lost the
 * clamp, so an over-filled shift read "needs -1 more" on the calendar while the
 * tasks page beside it said nothing. The clamp is the whole point of this
 * module's existence being one definition rather than seven.
 */
export function remainingFromOccupied(
  requiredHeadcount: number,
  occupied: number
): number {
  return Math.max(0, requiredHeadcount - occupied);
}

/**
 * Seats still to fill on a shift.
 *
 * The same question as `remainingFromOccupied`, asked by a caller that holds
 * the assignment rows — which is most of them, and which means they cannot
 * accidentally count a rejected row into the numerator.
 */
export function remainingSlots(
  requiredHeadcount: number,
  assignments: readonly { status: string }[]
): number {
  return remainingFromOccupied(requiredHeadcount, countOccupied(assignments));
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
