/**
 * Notification type → icon.
 *
 * ## Why this exists
 *
 * The notifications page and the bell each carried their own emoji table, and
 * the page's own comment said it "mirrors the bell so the two never look like
 * different features" — two hand-maintained copies held in sync by good
 * intentions. The bell covered 7 types and the page covered 14, so they had
 * already drifted: seven notification types showed a generic bell in one place
 * and a specific icon in the other.
 *
 * ## Why not emoji
 *
 * Same reasoning as `certification-state-icon.tsx`, which this deliberately
 * mirrors. Emoji are OS-supplied colour bitmaps: they cannot inherit
 * `currentColor`, they ignore dark mode entirely, and they render as visibly
 * different pictures on Windows, macOS and Android — so a screenshot in a
 * report does not match what a marker sees on their own machine. Every other
 * icon in this application is lucide.
 *
 * ## Choices a future edit should not undo
 *
 * - `withdrawal_approved` and `withdrawal_denied` are a thumbs-up/thumbs-down
 *   pair in emoji. As icons they are `CheckCheck` and `Undo2` — approving a
 *   withdrawal REMOVES someone from a shift, so a green tick reads as "task
 *   done" when the outcome is "assignment reversed". The shape says what
 *   happened, not whether a request succeeded.
 * - `task_cancelled` and `task_unassigned` share `Ban` and a red tint, because
 *   from the recipient's point of view they are the same event: work that was
 *   theirs no longer is.
 * - The fallback is `Bell`, matching the unknown-state fallback in
 *   `certification-state-icon.tsx`: an unrecognised type renders as a generic
 *   notification rather than being silently relabelled as something specific.
 */
import {
  Ban,
  Bell,
  CalendarClock,
  CheckCheck,
  CircleCheck,
  CircleX,
  ClipboardList,
  Clock,
  CalendarOff,
  CalendarX2,
  CalendarSync,
  Hourglass,
  LogOut,
  ShieldAlert,
  CalendarCheck,
  ShieldCheck,
  Star,
  TriangleAlert,
  Undo2,
  UserCheck,
  UserPlus,
  UserSearch,
  UserX,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { NotificationType } from "@/lib/notification-types";

export interface NotificationIcon {
  Icon: LucideIcon;
  /** Container tint. */
  tint: string;
  /** Stroke colour. Every entry carries a dark variant or is theme-neutral. */
  tone: string;
}

const INDIGO = {
  tint: "bg-indigo-500/[.13]",
  tone: "text-indigo-600 dark:text-indigo-400",
};
const GREEN = {
  tint: "bg-green-500/[.13]",
  tone: "text-green-600 dark:text-green-400",
};
const RED = {
  tint: "bg-red-500/[.12]",
  tone: "text-red-600 dark:text-red-400",
};
const AMBER = {
  tint: "bg-amber-500/[.14]",
  tone: "text-amber-600 dark:text-amber-400",
};

/*
 * `Record<NotificationType, …>`, not `Record<string, …>`.
 *
 * With a plain string key, five types had no row and fell through to the
 * generic bell — every leave and backfill notification. A test was supposed to
 * catch that, and could not: its list of "known types" was itself typed out by
 * hand and had drifted in the same direction.
 *
 * Keyed on the union, adding a notification type without choosing an icon fails
 * the build. Nothing to remember, and nothing to keep in step.
 */
const NOTIFICATION_ICON: Record<NotificationType, NotificationIcon> = {
  task_assigned: { Icon: ClipboardList, ...INDIGO },
  task_rescheduled: { Icon: CalendarClock, ...INDIGO },
  task_cancelled: { Icon: Ban, ...RED },
  task_unassigned: { Icon: Ban, ...RED },
  task_completed: { Icon: CircleCheck, ...GREEN },
  // Distinct from task_completed on purpose: both are green ticks conceptually,
  // but "someone accepted a shift" and "the work is finished" can appear in the
  // same feed minutes apart, and an identical icon makes them indistinguishable
  // at a glance.
  assignment_accepted: { Icon: UserCheck, ...GREEN },
  assignment_rejected: { Icon: CircleX, ...RED },
  decline_requested: { Icon: LogOut, ...AMBER },
  decline_approved: { Icon: CheckCheck, ...GREEN },
  decline_denied: { Icon: Undo2, ...RED },
  withdrawal_requested: { Icon: LogOut, ...AMBER },
  withdrawal_approved: { Icon: CheckCheck, ...GREEN },
  withdrawal_denied: { Icon: Undo2, ...RED },
  cert_verified: { Icon: ShieldCheck, ...GREEN },
  cert_rejected: { Icon: TriangleAlert, ...RED },
  // `certification.service.ts` genuinely sends this, and it had no row — so
  // expiring-certificate notifications fell through to the generic Bell in both
  // the feed and the dropdown, which is the exact drift this module exists to
  // end. ShieldAlert keeps the certificate family (ShieldCheck / ShieldOff)
  // recognisable while staying distinct from cert_rejected's triangle.
  cert_expiring: { Icon: ShieldAlert, ...AMBER },
  hour_limit_warning: { Icon: Clock, ...AMBER },
  staff_ineligible: { Icon: TriangleAlert, ...AMBER },
  // A star rather than a warning triangle. The event is a staff member telling
  // a manager a shift went badly, not the system detecting a fault, and the
  // manager's response is a conversation rather than a fix.
  shift_rated_low: { Icon: Star, ...AMBER },
  // A request, not a warning — nothing is wrong, a manager is asking the
  // person who owns the constraint to confirm it still holds.
  availability_review_requested: { Icon: CalendarCheck, ...INDIGO },

  /*
   * Leave and cover — the five types that had no row at all and fell through to
   * the generic bell, which is what a `Record<string, …>` allowed and a
   * `Record<NotificationType, …>` does not.
   *
   * Calendar glyphs for leave, because that is what a member is looking at when
   * they ask for it. People glyphs for backfill, because it is about finding
   * somebody rather than about a date: a magnifying glass while the shift is
   * still short, a plus once a replacement has been asked.
   */
  leave_requested: { Icon: CalendarOff, ...AMBER },
  leave_approved: { Icon: CalendarCheck, ...GREEN },
  leave_rejected: { Icon: CalendarX2, ...RED },
  /*
   * Amber, like `leave_requested`, because it IS that notification again — the
   * same request, still waiting. Red is reserved here for a refusal or a hole
   * in the roster, and a reminder is neither.
   *
   * `Hourglass` rather than `Clock`: `hour_limit_warning` is already Clock in
   * amber, and two types rendering to an identical row is a distinction the
   * reader cannot make.
   */
  leave_reminder: { Icon: Hourglass, ...AMBER },
  /*
   * Grey, and a distinct icon. This is the only notification in the product
   * that reports an absence of a decision rather than one, so it should not
   * wear the colour of either answer — a red one reads as "declined", which is
   * precisely what did not happen.
   */
  leave_lapsed: { Icon: CalendarSync, tint: "bg-muted", tone: "text-muted-foreground" },
  backfill_needed: { Icon: UserSearch, ...RED },
  backfill_offered: { Icon: UserPlus, ...INDIGO },
  /*
   * The two staffing shortfalls, and the tint carries the difference rather
   * than the glyph: amber for a shift that has SOMEBODY on it and red for one
   * that has nobody. Partly staffed can often wait for the hourly sweep to top
   * it up; not staffed at all cannot, and the colours should not suggest those
   * are the same size of problem.
   *
   * `Users` and `UserX` keep the people family that backfill already uses —
   * every one of these is about finding a person, not about a date.
   */
  task_partially_filled: { Icon: Users, ...AMBER },
  task_unfilled: { Icon: UserX, ...RED },
};

const UNKNOWN: NotificationIcon = {
  Icon: Bell,
  tint: "bg-muted",
  tone: "text-muted-foreground",
};

/**
 * Exported for tests. Accepts a bare string because notification `type` is a
 * plain column with no database enum, so an unrecognised value is reachable.
 *
 * `hasOwnProperty`, not `??`: the table is an object literal and so inherits
 * from Object.prototype, meaning a lookup of "constructor" or "toString" would
 * return an inherited member rather than undefined and skip the fallback
 * entirely — the same trap already fixed in `certification-state-icon.tsx`.
 */
export function notificationIcon(type: string): NotificationIcon {
  // Still takes a plain string: types arrive from `res.json()` and a signature
  // demanding the union would be defeated by the first cast written to make the
  // build pass. The cast is here, once, where the fallback covers it.
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_ICON, type)
    ? NOTIFICATION_ICON[type as NotificationType]
    : UNKNOWN;
}

/**
 * Decorative by design: every notification renders its title and message as
 * text beside this, so announcing the icon would only repeat them.
 */
export function NotificationIconBadge({
  type,
  className = "",
}: {
  type: string;
  className?: string;
}) {
  const { Icon, tint, tone } = notificationIcon(type);
  return (
    <div
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-lg ${tint} ${className}`}
    >
      <Icon className={`h-4 w-4 ${tone}`} />
    </div>
  );
}
