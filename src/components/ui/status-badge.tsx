/**
 * Status Badge Component (Boundary Layer)
 *
 * Unified pill badge for task statuses, priorities, roles, tiers, and
 * any other categorical label.  All colour mappings live here — pages
 * pass a `palette` key and a `label`; no colour logic leaks into pages.
 *
 * Every palette entry includes dark-mode variants so the badge is
 * legible in both themes.
 */
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Palette definitions                                                */
/* ------------------------------------------------------------------ */

const TASK_STATUS_STYLES: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  in_progress:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  completed:
    "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  cancelled:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  closed:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const PRIORITY_STYLES: Record<string, string> = {
  urgent: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  medium:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  low: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
};

const ASSIGNMENT_STATUS_STYLES: Record<string, string> = {
  pending:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  accepted:
    "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  clocked_in:
    "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  clocked_out:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  completed:
    "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  // Both "awaiting a manager's decision" states share the orange. They are the
  // same thing to a reader — someone wants off this shift and nobody has said
  // yes yet — and the difference between them is only where in the lifecycle
  // it happened.
  decline_requested:
    "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  withdrawal_requested:
    "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  withdrawn:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const ROLE_STYLES: Record<string, string> = {
  company_admin:
    "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  manager:
    "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  staff:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const TIER_STYLES: Record<string, string> = {
  free: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  pro: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  enterprise:
    "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
};

const CERTIFICATION_STYLES: Record<string, string> = {
  pending:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  verified:
    "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  // Revoked was verified once and has been withdrawn. Grey rather than red:
  // the certificate was legitimate, it simply no longer counts — the same
  // practical meaning as expired.
  revoked:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  expired:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  expiring:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
};

const MEMBERSHIP_STATUS_STYLES: Record<string, string> = {
  active:
    "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  suspended: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  inactive:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const TEAM_STATUS_STYLES: Record<string, string> = {
  on_shift:
    "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  has_pending:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  available:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  off_today:
    "bg-gray-50 text-gray-400 dark:bg-gray-900 dark:text-gray-500",
};

/**
 * What became of a shift, on the member's own history page.
 *
 * Separate from ASSIGNMENT_STATUS_STYLES because it is answering a different
 * question — see src/lib/shift-outcome.ts. The colours follow the tones stated
 * there, which is why `cancelled` and `declined` are grey rather than red: a
 * member's own record should not be tinted like a list of their failures for a
 * shift a manager called off, or one they were entitled to turn down.
 */
const SHIFT_OUTCOME_STYLES: Record<string, string> = {
  worked: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  declined: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  withdrawn: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  cancelled: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  not_clocked_out:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  no_clock_in:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  unanswered:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
};

/* ------------------------------------------------------------------ */
/*  Palette registry                                                   */
/* ------------------------------------------------------------------ */

export type BadgePalette =
  | "taskStatus"
  | "priority"
  | "assignmentStatus"
  | "role"
  | "tier"
  | "certification"
  | "membershipStatus"
  | "teamStatus"
  | "shiftOutcome";

const PALETTE_MAP: Record<BadgePalette, Record<string, string>> = {
  taskStatus: TASK_STATUS_STYLES,
  priority: PRIORITY_STYLES,
  assignmentStatus: ASSIGNMENT_STATUS_STYLES,
  role: ROLE_STYLES,
  tier: TIER_STYLES,
  certification: CERTIFICATION_STYLES,
  membershipStatus: MEMBERSHIP_STATUS_STYLES,
  teamStatus: TEAM_STATUS_STYLES,
  shiftOutcome: SHIFT_OUTCOME_STYLES,
};

const DEFAULT_STYLE =
  "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface StatusBadgeProps {
  /** The raw value used to look up the colour (e.g. "open", "high"). */
  value: string;
  /** Which palette to use. */
  palette: BadgePalette;
  /** Override the display text. Defaults to a prettified `value`. */
  label?: string;
  /** Extra Tailwind classes. */
  className?: string;
}

/** Format "in_progress" → "In Progress", "clocked_in" → "Clocked In", etc. */
function prettify(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function StatusBadge({
  value,
  palette,
  label,
  className,
}: StatusBadgeProps) {
  const styles = PALETTE_MAP[palette];
  const colorClass = styles[value] ?? DEFAULT_STYLE;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        colorClass,
        className,
      )}
    >
      {label ?? prettify(value)}
    </span>
  );
}
