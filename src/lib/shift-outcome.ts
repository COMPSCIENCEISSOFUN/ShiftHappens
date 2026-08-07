/**
 * What actually became of a shift, from the assignee's point of view.
 *
 * ## Why this is not just the status
 *
 * `TaskAssignment.status` answers "where is this row in the lifecycle", which
 * is the question the workflow asks. A history is read by the person who lived
 * it, and they are asking something else: what happened. Those come apart in
 * three places, and each one is a row somebody would otherwise misread.
 *
 *  - `accepted` on a shift that ended last week does not mean "accepted, on the
 *    way". It means nobody clocked anything, and the row says so only if you
 *    notice the date;
 *  - a CANCELLED shift leaves the assignment at whatever it was. Its status
 *    reports the member's last decision about a shift that then stopped
 *    existing, which is not what happened to them;
 *  - `pending` on an ended shift is a question that was never answered. The
 *    lifecycle has no terminal state for that, because from the workflow's
 *    side nothing happened — which is exactly the finding.
 *
 * ## No accusations
 *
 * There is no `no_show`. A missing clock-in means a missing clock-in: the
 * person may have worked the whole shift and forgotten the button, and a badge
 * on their own history page asserting they failed to turn up would be the
 * system stating as fact something it cannot observe. `no_clock_in` is what is
 * known; whether it mattered is a conversation, not a column.
 */
import { wasWorked } from "@/lib/assignment-status";

export const SHIFT_OUTCOMES = [
  "worked",
  "declined",
  "withdrawn",
  "cancelled",
  "not_clocked_out",
  "no_clock_in",
  "unanswered",
] as const;

export type ShiftOutcome = (typeof SHIFT_OUTCOMES)[number];

export const OUTCOME_LABEL: Record<ShiftOutcome, string> = {
  worked: "Worked",
  declined: "Declined",
  withdrawn: "Withdrew",
  cancelled: "Cancelled",
  not_clocked_out: "No clock-out",
  no_clock_in: "No clock-in",
  unanswered: "Never answered",
};

/**
 * One line saying what the badge means, for the row that carries it.
 *
 * A badge reading "No clock-out" on your own history invites exactly one
 * question — so does it count? — and leaving that unanswered on the page is how
 * a member ends up asking a manager something the screen could have said.
 */
export const OUTCOME_NOTE: Record<ShiftOutcome, string> = {
  worked: "",
  declined: "You turned this shift down.",
  withdrawn: "You came off this shift after accepting it.",
  cancelled: "The shift was cancelled after you were rostered on.",
  /*
   * Says what is true and stops. The first version added "ask your manager to
   * correct it", which points at a feature that does not exist — there is no
   * way for anybody to amend a clock time. Telling somebody to request an
   * impossible fix is worse than telling them nothing: they go and ask, and the
   * manager finds out the same way.
   *
   * Amending clock times is on the backlog. When it lands, this line is where
   * the route to it belongs.
   */
  not_clocked_out:
    "Clocked in but never out, so these hours are not counted in your total.",
  no_clock_in: "No clock-in was recorded, so this shift is not in your hours.",
  unanswered: "The shift passed without an answer either way.",
};

/**
 * Which badge tone each outcome takes. Names match the StatusBadge vocabulary.
 *
 * `cancelled` is neutral, not negative: it was not the member's doing and their
 * own history should not read as a list of their failures because a manager
 * called off a shift.
 */
export const OUTCOME_TONE: Record<ShiftOutcome, "positive" | "neutral" | "warning"> = {
  worked: "positive",
  declined: "neutral",
  withdrawn: "neutral",
  cancelled: "neutral",
  not_clocked_out: "warning",
  no_clock_in: "warning",
  unanswered: "warning",
};

/**
 * Classify one row.
 *
 * Order is the whole content of this function.
 *
 * Worked comes first, ahead of cancelled: a shift somebody clocked in and out
 * of was worked, whatever the task record says happened to it afterwards.
 * Cancelling a shift after the fact does not un-work it, and hiding those hours
 * behind a "Cancelled" badge would drop them from a total the member is paid
 * against.
 *
 * Released statuses come next, ahead of cancelled for the same reason in
 * reverse: if they had already declined it, the later cancellation is not their
 * story. Then cancelled, which outranks the two clock states — no clock-in on a
 * shift that stopped existing is not a finding.
 */
export function shiftOutcome(assignment: {
  status: string;
  clockInTime?: Date | string | null;
  clockOutTime?: Date | string | null;
  task: { status: string };
}): ShiftOutcome {
  if (wasWorked(assignment.status) || assignment.clockOutTime) return "worked";
  if (assignment.status === "rejected") return "declined";
  if (assignment.status === "withdrawn") return "withdrawn";
  if (assignment.task.status === "cancelled") return "cancelled";
  if (assignment.clockInTime) return "not_clocked_out";
  /*
   * Nobody answered, as opposed to answered and then not turned up. Both
   * awaiting-a-decision statuses land here too: `decline_requested` means the
   * member asked to come off and the shift passed before a manager replied,
   * which is a decision nobody made rather than one the member dodged.
   */
  if (["pending", "decline_requested"].includes(assignment.status)) {
    return "unanswered";
  }
  return "no_clock_in";
}

/** Hours between clocking in and out, or null when the pair is incomplete. */
export function workedHours(assignment: {
  clockInTime?: Date | string | null;
  clockOutTime?: Date | string | null;
}): number | null {
  if (!assignment.clockInTime || !assignment.clockOutTime) return null;
  const ms =
    new Date(assignment.clockOutTime).getTime() -
    new Date(assignment.clockInTime).getTime();
  // A negative span is corrupt data, not a negative shift. Returning it would
  // subtract from the member's total and make the figure quietly wrong rather
  // than visibly incomplete.
  return ms > 0 ? ms / 3_600_000 : null;
}
