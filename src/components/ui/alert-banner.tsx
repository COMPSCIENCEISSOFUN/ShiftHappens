/**
 * AlertBanner Component
 *
 * Shared alert/notification banner for inline feedback messages.
 * Supports error, success, warning, and info variants with
 * appropriate colors that work in both light and dark mode.
 *
 * ## When this, and when a toast
 *
 * The rule is about DURATION, not severity.
 *
 * This is for a condition that is still true while you look at it — the form
 * was refused, the plan does not include this, the organisation is suspended.
 * It occupies layout because the thing it describes has not gone away, and it
 * belongs beside whatever it is about.
 *
 * A finished action is not a condition. "Invitation sent", "Schedule saved",
 * "Task updated" describe something already over, and rendering them here
 * pushed the page down, sat between two unrelated sections, and stayed until
 * the next navigation. Those are `toast.success(...)` from `sonner`, mounted
 * once in `app/layout.tsx`.
 *
 * Two success banners survive that rule, both deliberately:
 *
 *   - `verify-email` — the confirmation IS the page's content; there is
 *     nothing underneath for a toast to float over
 *   - `settings` post-checkout — describes a state that persists and is not
 *     finished ("your plan will update momentarily"), tied to a URL parameter
 *     rather than to a click
 *
 * `tests/lib/no-success-banners.test.ts` holds that line, because the cheap
 * mistake is to add a ninth.
 */
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

const variantStyles = {
  error:
    "border-destructive/50 bg-destructive/10 text-destructive dark:border-destructive/40 dark:bg-destructive/15 dark:text-red-300",
  success:
    "border-green-500/50 bg-green-50 text-green-700 dark:border-green-500/40 dark:bg-green-950/50 dark:text-green-300",
  warning:
    "border-yellow-500/50 bg-yellow-50 text-yellow-700 dark:border-yellow-500/40 dark:bg-yellow-950/50 dark:text-yellow-300",
  info:
    "border-blue-500/50 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-950/50 dark:text-blue-300",
} as const;

interface AlertBannerProps {
  message: React.ReactNode;
  variant: "error" | "success" | "warning" | "info";
  onDismiss?: () => void;
  className?: string;
}

export function AlertBanner({
  message,
  variant,
  onDismiss,
  className,
}: AlertBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        "relative rounded-md border px-3 py-3 text-sm",
        variantStyles[variant],
        onDismiss && "pr-9",
        className,
      )}
    >
      {message}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="absolute right-2 top-2.5 rounded-sm opacity-70 transition-opacity hover:opacity-100"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
