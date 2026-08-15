/**
 * AlertBanner Component
 *
 * Shared alert/notification banner for inline feedback messages.
 * Supports error, success, warning, and info variants with
 * appropriate colors that work in both light and dark mode.
 *
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
