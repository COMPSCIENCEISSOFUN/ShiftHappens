/**
 * The notification vocabulary: every type, how it is grouped, and what it is
 * called on screen.
 *
 * ## Why it moved out of the service
 *
 * The service imports `NotificationRepository` and therefore Prisma, so the
 * notifications page and the bell could not read it — and both had their own
 * hand-written copy instead. There were FOUR lists of notification types by the
 * end: the service's, the page's badge labels, the icon map, and a test whose
 * "known types" array was itself typed out by hand. They had drifted: six types
 * had no label and rendered as "Update", five had no icon and fell back to a
 * generic bell, and the drift-guard test did not cover a single one of them,
 * because it had drifted too.
 *
 * Same move, same reason, as `audit-actions.ts` and `audit-entities.ts`: the
 * vocabulary is presentation data, the browser needs it, and a file the browser
 * can import cannot be the one that opens a database connection.
 *
 * ## Why `Record<NotificationType, …>` everywhere below
 *
 * Because a test that reminds somebody to add a label is a test somebody has to
 * remember to update. A `Record` over the union does not remind anybody — it
 * refuses to compile. Adding a notification type now means naming it, grouping
 * it, and saying where it links to (`notification-links.ts`), or the build
 * fails.
 *
 * ## `org_suspended` is gone
 *
 * It was declared, categorised, given an icon, a label and tests, and no code
 * path anywhere ever raised it — the eighth "built and uncalled" instance in
 * this codebase. It could not usefully have existed either: suspending an
 * organisation blocks its members from signing in, so the notification would
 * have been readable only by somebody who cannot log in to read it.
 */

export const NOTIFICATION_TYPES = {
  TASK_ASSIGNED: "task_assigned",
  TASK_UNASSIGNED: "task_unassigned",
  TASK_CANCELLED: "task_cancelled",
  TASK_RESCHEDULED: "task_rescheduled",
  STAFF_INELIGIBLE: "staff_ineligible",
  HOUR_LIMIT_WARNING: "hour_limit_warning",
  ASSIGNMENT_ACCEPTED: "assignment_accepted",
  ASSIGNMENT_REJECTED: "assignment_rejected",
  TASK_COMPLETED: "task_completed",
  DECLINE_REQUESTED: "decline_requested",
  DECLINE_APPROVED: "decline_approved",
  DECLINE_DENIED: "decline_denied",
  WITHDRAWAL_REQUESTED: "withdrawal_requested",
  WITHDRAWAL_APPROVED: "withdrawal_approved",
  WITHDRAWAL_DENIED: "withdrawal_denied",
  SHIFT_RATED_LOW: "shift_rated_low",
  AVAILABILITY_REVIEW_REQUESTED: "availability_review_requested",
  LEAVE_REQUESTED: "leave_requested",
  /*
   * A request is running out of time and nobody has answered it.
   *
   * ONE type for both passes, not two. The escalation adds the company admins
   * to the recipients; it does not change what is being said, and a second type
   * would give an organisation a switch that silences the reminder while
   * leaving the escalation on — a setting whose only effect is to make the
   * first warning somebody gets be the angry one.
   */
  LEAVE_REMINDER: "leave_reminder",
  /*
   * The date arrived and nobody ever answered.
   *
   * To the MEMBER, and deliberately not phrased as a decision — because none
   * was made. The alternative was silence, which is what shipped first: their
   * screen said "awaiting approval" indefinitely and nothing ever told them
   * otherwise.
   */
  LEAVE_LAPSED: "leave_lapsed",
  LEAVE_APPROVED: "leave_approved",
  LEAVE_REJECTED: "leave_rejected",
  CERT_VERIFIED: "cert_verified",
  CERT_REJECTED: "cert_rejected",
  CERT_EXPIRING: "cert_expiring",
  /*
   * Approved leave has opened a hole in a shift and nobody is filling it.
   *
   * Distinct from STAFF_INELIGIBLE, which says somebody assigned can no longer
   * work — this says they have already been REMOVED and the shift is short. The
   * two used to be the same message because approving leave did not unassign
   * anybody; once it did, "no longer eligible" stopped describing what had
   * happened.
   */
  BACKFILL_NEEDED: "backfill_needed",
  /*
   * A replacement has been found and ASKED. Never "assigned" — a backfill is
   * always an offer, even in auto mode, because the person being offered it
   * may be a full-timer whose all-week availability was set by default rather
   * than by them.
   */
  BACKFILL_OFFERED: "backfill_offered",
} as const;

/**
 * User-facing groupings for the notification feed's filter pills.
 * Presentation vocabulary lives here rather than in the page so the API and
 * the UI cannot drift apart on what "Alerts" means.
 */
export const NOTIFICATION_CATEGORIES = {
  task: [
    NOTIFICATION_TYPES.TASK_ASSIGNED,
    NOTIFICATION_TYPES.TASK_UNASSIGNED,
    NOTIFICATION_TYPES.TASK_CANCELLED,
    NOTIFICATION_TYPES.TASK_RESCHEDULED,
    NOTIFICATION_TYPES.TASK_COMPLETED,
  ],
  assignment: [
    NOTIFICATION_TYPES.ASSIGNMENT_ACCEPTED,
    NOTIFICATION_TYPES.ASSIGNMENT_REJECTED,
    NOTIFICATION_TYPES.DECLINE_REQUESTED,
    NOTIFICATION_TYPES.DECLINE_APPROVED,
    NOTIFICATION_TYPES.DECLINE_DENIED,
    NOTIFICATION_TYPES.WITHDRAWAL_REQUESTED,
    NOTIFICATION_TYPES.WITHDRAWAL_APPROVED,
    NOTIFICATION_TYPES.WITHDRAWAL_DENIED,
    NOTIFICATION_TYPES.AVAILABILITY_REVIEW_REQUESTED,
    NOTIFICATION_TYPES.LEAVE_REQUESTED,
    NOTIFICATION_TYPES.LEAVE_APPROVED,
    NOTIFICATION_TYPES.LEAVE_REJECTED,
    NOTIFICATION_TYPES.LEAVE_LAPSED,
    NOTIFICATION_TYPES.BACKFILL_OFFERED,
  ],
  certification: [
    NOTIFICATION_TYPES.CERT_VERIFIED,
    NOTIFICATION_TYPES.CERT_REJECTED,
    NOTIFICATION_TYPES.CERT_EXPIRING,
  ],
  alert: [
    // A reminder is an alert, not an assignment update: it is addressed to
    // somebody who has to act, and it groups with the other things waiting on
    // them rather than with the news about their own shifts.
    NOTIFICATION_TYPES.LEAVE_REMINDER,
    NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
    NOTIFICATION_TYPES.STAFF_INELIGIBLE,
    NOTIFICATION_TYPES.SHIFT_RATED_LOW,
    NOTIFICATION_TYPES.BACKFILL_NEEDED,
  ],
} as const;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;

/**
 * Types that represent something gone wrong which the recipient is expected to
 * do something about — surfaced as the "Needs action" tile.
 */
export const NEEDS_ACTION_TYPES: string[] = [
  NOTIFICATION_TYPES.CERT_EXPIRING,
  NOTIFICATION_TYPES.ASSIGNMENT_REJECTED,
  NOTIFICATION_TYPES.HOUR_LIMIT_WARNING,
  NOTIFICATION_TYPES.CERT_REJECTED,
  NOTIFICATION_TYPES.WITHDRAWAL_REQUESTED,
  NOTIFICATION_TYPES.STAFF_INELIGIBLE,
  // An unfilled shift is the definition of something needing action.
  NOTIFICATION_TYPES.BACKFILL_NEEDED,
  // And a request nobody has answered is the definition of something overdue.
  NOTIFICATION_TYPES.LEAVE_REMINDER,
];

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

/**
 * What each type is called on the row's badge.
 *
 * The page had twenty of these and fell back to "Update" for the rest, so a
 * `leave_approved` notification sat under the Assignments pill wearing a badge
 * that said "Update" — technically true and useless.
 */
export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  task_assigned: "Assigned",
  task_unassigned: "Removed",
  task_cancelled: "Cancelled",
  task_rescheduled: "Rescheduled",
  task_completed: "Completed",
  staff_ineligible: "No longer eligible",
  hour_limit_warning: "Hour limit",
  assignment_accepted: "Accepted",
  assignment_rejected: "Rejected",
  decline_requested: "Decline requested",
  decline_approved: "Decline approved",
  decline_denied: "Decline denied",
  withdrawal_requested: "Withdrawal requested",
  withdrawal_approved: "Withdrawal approved",
  withdrawal_denied: "Withdrawal denied",
  shift_rated_low: "Low rating",
  availability_review_requested: "Availability check",
  leave_requested: "Leave requested",
  leave_reminder: "Awaiting your decision",
  leave_lapsed: "Never answered",
  leave_approved: "Leave approved",
  leave_rejected: "Leave declined",
  cert_verified: "Verified",
  cert_rejected: "Not accepted",
  cert_expiring: "Expiring",
  backfill_needed: "Cover needed",
  backfill_offered: "Cover offered",
};

/** Every type, for tests and exhaustiveness checks. */
export const NOTIFICATION_TYPE_LIST = Object.values(
  NOTIFICATION_TYPES
) as NotificationType[];
