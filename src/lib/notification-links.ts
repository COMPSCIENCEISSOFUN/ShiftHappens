/**
 * Where clicking a notification takes you.
 */
import {
  MEMBER_LIST_READERS,
  TASK_LIST_READERS,
} from "@/lib/permissions";
import type { NotificationType } from "@/lib/notification-types";

export interface Destination {
  /** Where a member who holds `requires` is sent. */
  preferred: string;
  /** The permissions that page's own gate demands. Empty means ungated. */
  requires: readonly string[];
  /** Where everybody else is sent. Always an ungated page. */
  fallback: string;
}

/**
 * One entry per type, as a `Record` over the union rather than a loose map, so
 * adding a notification type without deciding where it goes fails the build
 * instead of producing a row that does nothing when clicked.
 */
export const NOTIFICATION_DESTINATIONS: Record<NotificationType, Destination> = {
  /*
   * Anything about a shift that is or might still be coming.
   *
   * A manager reaches the board, where they can act on it. Everybody else
   * reaches their own list, where the accept and decline buttons are — which is
   * where a staff member wants to be anyway, and was reachable from the
   * notification only by navigating there by hand.
   */
  task_assigned: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  task_unassigned: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  task_cancelled: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  task_rescheduled: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  staff_ineligible: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  assignment_accepted: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  assignment_rejected: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  decline_requested: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  decline_approved: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  decline_denied: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  withdrawal_requested: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  withdrawal_approved: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  withdrawal_denied: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  backfill_needed: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  backfill_offered: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  /*
   * The board, where the assign panel is — these two exist so somebody can put
   * people on the shift, and that is the only screen where they can. The
   * personal fallback matches the rest of the task family rather than being a
   * dead end, though in practice only task-list readers are ever sent these.
   */
  task_partially_filled: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },
  task_unfilled: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-tasks" },

  /*
   * Finished work, so the personal fallback is My History rather than My Tasks
   * — a completed shift and a low rating have both already left the list of
   * things to answer, and sending somebody to look for them there would be
   * sending them to an empty page.
   */
  task_completed: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-history" },
  shift_rated_low: { preferred: "tasks", requires: TASK_LIST_READERS, fallback: "my-history" },

  /*
   * Hours. A manager belongs on the member list, where the figures sit beside
   * the people; a member belongs on their own history, which is the only place
   * their own hours are shown to them.
   */
  hour_limit_warning: {
    preferred: "members",
    requires: MEMBER_LIST_READERS,
    fallback: "my-history",
  },

  /*
   * Leave and availability. Two different pages for what `entityType` calls one
   * thing: a REQUEST is a job for whoever reviews leave, while an outcome and a
   * nudge are the member's own to act on.
   */
  leave_requested: {
    preferred: "leave",
    requires: ["members:request_availability"],
    fallback: "availability",
  },
  leave_approved: { preferred: "availability", requires: [], fallback: "availability" },
  /*
   * To the queue, gated like `leave_requested` — the same recipients, the same
   * page, and the same reason for the gate: a manager whose custom role lacks
   * the permission must land somewhere they can actually read.
   */
  leave_reminder: {
    preferred: "leave",
    requires: ["members:request_availability"],
    fallback: "availability",
  },
  /*
   * To the MEMBER's own availability page — the one place they can see the
   * request marked "Never answered" and ask again for a date that still
   * matters. Never to the review queue: the recipient is the person who asked,
   * not the person who did not answer.
   */
  leave_lapsed: { preferred: "availability", requires: [], fallback: "availability" },
  leave_rejected: { preferred: "availability", requires: [], fallback: "availability" },
  availability_review_requested: {
    preferred: "availability",
    requires: [],
    fallback: "availability",
  },

  /*
   * Certificates. All three of these go to the HOLDER, so the review queue at
   * `/certifications` would be the wrong page even for a manager who can open
   * it — theirs is the one that was submitted.
   */
  cert_verified: { preferred: "my-certifications", requires: [], fallback: "my-certifications" },
  cert_rejected: { preferred: "my-certifications", requires: [], fallback: "my-certifications" },
  cert_expiring: { preferred: "my-certifications", requires: [], fallback: "my-certifications" },
};

/**
 * The path to open for a notification, given what the reader may do.
 *
 * `held` is the reader's permission set — the same one the destination page
 * will consult a moment later, so the two cannot disagree about whether they
 * are allowed in.
 *
 * An unrecognised type returns null and the caller renders a row that does not
 * navigate. Guessing `/tasks` would be the original bug in a new place: a
 * plausible page the reader may not be able to open.
 */
export function notificationHref(
  type: string,
  orgId: string,
  held: (permission: string) => boolean
): string | null {
  const destination = NOTIFICATION_DESTINATIONS[type as NotificationType];
  if (!destination) return null;

  const allowed =
    destination.requires.length === 0 ||
    destination.requires.some((permission) => held(permission));

  return `/org/${orgId}/${allowed ? destination.preferred : destination.fallback}`;
}
