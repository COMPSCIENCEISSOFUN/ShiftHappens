/**
 * Where clicking a notification takes you.
 *
 * ## Why this is a module and not two switch statements
 *
 * It WAS two switch statements — one in the notifications page, one in the bell
 * — each keyed on `entityType`, each written separately. They had drifted in
 * both directions: the page knew what to do with an hour-limit warning and the
 * bell did nothing, and neither had a case for `availability` at all, so four
 * notification types about leave were completely unclickable. One shared
 * resolver is the only arrangement in which they cannot disagree, which is the
 * same argument `assignment-status.ts` and `department-scope.ts` already make.
 *
 * ## Why it keys on TYPE rather than entityType
 *
 * `entityType` is too coarse to answer the question. All four leave and
 * availability notifications carry `"availability"`, but "your leave was
 * approved" belongs on the member's own availability page while "somebody
 * requested leave" belongs on the approvals queue — one is news, the other is a
 * job. The type says which; the entity type cannot.
 *
 * ## Why a destination has a fallback
 *
 * Several types reach BOTH audiences. `hour_limit_warning` goes to the member
 * and to every manager; `backfill_offered` goes to the replacement and to the
 * watchers. So the right page cannot be decided by the notification alone — it
 * depends on who is reading it.
 *
 * That was the live bug and it was not subtle. Seven staff-facing types —
 * a shift cancelled, a shift rescheduled, being removed from one, and the four
 * decline and withdrawal outcomes — all pushed to `/tasks`, which renders "You
 * don't have access to Tasks" for anybody without `TASK_LIST_READERS`. Staff
 * were told something had happened to their shift, tapped it, and hit a lock
 * screen. The identical bug had already been found and fixed for certificates
 * ten lines away, and never applied here.
 *
 * `requires` names the permissions the preferred page's own gate checks — not a
 * guess at them. Verified against each page:
 *
 *   - `/tasks` and `/calendar`  → `canAny(TASK_LIST_READERS)`
 *   - `/members`                → `canAny(MEMBER_LIST_READERS)`
 *   - `/leave`                  → `can("members:request_availability")`
 *   - `/certifications`         → `can("certifications:review")`
 *   - `/my-tasks`, `/my-history`, `/my-certifications`, `/availability`,
 *     `/my-schedule`            → no permission; self-service, and the sidebar
 *                                 gates them on `canBeRostered` instead
 *
 * The fallbacks are therefore all ungated pages, which is what makes this safe:
 * the worst case is a member landing somewhere useful rather than somewhere
 * forbidden.
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
