/**
 * What a task's status permits.
 *
 * ## Why this exists
 *
 * `assignStaff` checked seven things before writing an assignment — the member
 * exists, is active, is not an admin, belongs to the organisation, is not
 * already on the task, does not exceed the headcount, has no scheduling
 * conflict — and never once looked at the task itself. So a shift that had been
 * **cancelled** or marked **completed** still accepted new people, silently and
 * with no reason to think otherwise.
 *
 * Cancelling is the project's chosen alternative to deletion: `TaskService`
 * refuses to delete a task with assignments and sets `status: "cancelled"`
 * instead, precisely so the record survives as "this was real and is not
 * happening". Rostering somebody onto it afterwards contradicts the whole point
 * of that decision — and the person would appear on a shift the board shows as
 * cancelled, be counted in nobody's headcount, and never be told it was off.
 *
 * ## Why `in_progress` is allowed
 *
 * Cover arriving mid-shift is ordinary. Somebody calls in sick two hours in and
 * a replacement is found — that assignment is legitimate and the task is
 * genuinely in progress. Refusing it would push the work off the system, which
 * is the same argument that stopped full-time declines being blocked outright.
 *
 * ## Why a module for one predicate
 *
 * Two call sites need it — assigning a person and confirming a whole week's
 * draft — and a draft generated on Monday can be confirmed on Wednesday, after
 * somebody cancelled the shift. Written twice, the two would eventually
 * disagree, which is the failure `assignment-status.ts` was created to end and
 * the one this codebase has repeated more than any other.
 */

/** Lifecycle: open → in_progress → completed. Off-ramp: cancelled. */
export const TASK_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * The statuses that refuse new people.
 *
 * Both are terminal: one says the work happened, the other says it will not.
 * Neither has a seat left to fill.
 */
export const CLOSED_TO_ASSIGNMENT = ["completed", "cancelled"] as const;

/**
 * May somebody be rostered onto a task in this state?
 *
 * Takes a plain `string`, like `occupiesSlot` next door and for the same
 * reason: statuses arrive from Prisma and from `res.json()` as strings, and a
 * signature demanding the union would be defeated by the first cast somebody
 * wrote to make the build pass.
 *
 * An unrecognised status is ALLOWED, which is the opposite of the safe
 * direction `occupiesSlot` takes — deliberately. There, guessing wrong
 * over-counts a shift and prompts a human to look; here, guessing wrong refuses
 * a manager the ability to staff a shift, with a message about a status the
 * product does not have. A new status should not silently make the roster
 * unfillable.
 */
export function acceptsAssignments(status: string): boolean {
  return !(CLOSED_TO_ASSIGNMENT as readonly string[]).includes(status);
}

/** Why this task cannot take anybody, phrased for an API refusal. */
export function assignmentRefusalFor(status: string): string | null {
  if (acceptsAssignments(status)) return null;
  return status === "cancelled"
    ? "This shift has been cancelled — reopen it before assigning anyone"
    : "This shift is marked completed — reopen it before assigning anyone";
}

/**
 * The statuses that no longer commit the people on them to a time.
 *
 * ## Why this is NOT `CLOSED_TO_ASSIGNMENT`
 *
 * That constant answers "may somebody be added to this shift", and both of its
 * entries are terminal. This answers a different question — "is this person
 * still busy at that hour" — and the two statuses part company on it.
 * `completed` still commits: somebody worked 09:00 to 17:00 and was genuinely
 * unavailable in the middle of it. `cancelled` does not: the shift is not
 * happening, so neither is the commitment.
 *
 * ## What it fixes
 *
 * Cancelling a task writes the status and tells everyone rostered they are no
 * longer scheduled — then leaves their assignment rows exactly as they were,
 * deliberately, because `shift-outcome` derives "Cancelled" in a member's
 * history from `task.status` and rewriting the assignment would take that away.
 *
 * Both conflict queries filtered on the ASSIGNMENT's status and never looked at
 * the task's. So a member was told they were free and stayed unschedulable at
 * that hour, blocked by a shift that had been called off — the message and the
 * data disagreeing, which is this codebase's most repeated defect.
 */
export const RELEASES_COMMITMENT = ["cancelled"] as const;

/**
 * Prisma `notIn` filter for tasks that still commit their assignees' time.
 *
 * A fresh array, matching `occupyingStatusFilter` next door and for the same
 * reason: Prisma's generated types want `string[]`, not `readonly string[]`.
 */
export function committedTaskStatusFilter(): string[] {
  return [...RELEASES_COMMITMENT];
}

/**
 * Prisma `notIn` filter for the two terminal states — the shifts that no
 * longer need staffing.
 *
 * Three queries wrote `["completed", "cancelled"]` by hand. Nothing was wrong
 * with any of them, and that is the point: the fourth is where the list gets a
 * status added to it in one place and not the others, which is the failure
 * `assignment-status` was created to end.
 */
export function closedTaskStatusFilter(): string[] {
  return [...CLOSED_TO_ASSIGNMENT];
}
