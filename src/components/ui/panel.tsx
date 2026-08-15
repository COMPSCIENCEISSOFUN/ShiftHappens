/**
 * Panel
 *
 * The titled, bordered container that holds most content in the redesigned
 * pages: an icon, a heading, an optional count, an optional action on the
 * right, then a body.
 *
 */
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PanelProps {
  title: string;
  icon: LucideIcon;
  /** A small pill after the title. Pass a number even when it is 0. */
  count?: number;
  /** "warning" tints the header and border amber. */
  tone?: "default" | "warning";
  /** Rendered at the right of the header — usually a button. */
  action?: React.ReactNode;
  /** Classes for a wrapper around the body, e.g. "divide-y divide-border". */
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
}

export function Panel({
  title,
  icon: Icon,
  count,
  tone = "default",
  action,
  bodyClassName,
  className,
  children,
}: PanelProps) {
  const warning = tone === "warning";

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border bg-card",
        warning ? "border-amber-300 dark:border-amber-800" : "border-border",
        className
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b px-4 py-3",
          warning
            ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
            : "border-border"
        )}
      >
        <Icon
          className={cn(
            "h-4 w-4 shrink-0",
            warning ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
          )}
          aria-hidden="true"
        />
        <h3
          className={cn(
            "text-sm font-semibold",
            warning && "text-amber-800 dark:text-amber-300"
          )}
        >
          {title}
        </h3>
        {count !== undefined && (
          <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">
            {count}
          </span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>

      {bodyClassName ? <div className={bodyClassName}>{children}</div> : children}
    </section>
  );
}
