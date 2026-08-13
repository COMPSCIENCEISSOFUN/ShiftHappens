/**
 * Panel
 *
 * The titled, bordered container that holds most content in the redesigned
 * pages: an icon, a heading, an optional count, an optional action on the
 * right, then a body.
 *
 * ## Why this is shared
 *
 * Four copies existed, in auto-schedule, my-tasks, work-rules and roles. Two
 * were identical; the other two had each grown a feature the others could not
 * use — auto-schedule an amber `tone` and a header `action`, my-tasks a `count`
 * pill and a dividing body. So the duplication had already cost something: a
 * page wanting a count next to its title had to reimplement the whole panel to
 * get one.
 *
 * The union is small enough to carry in one component, and every prop here is
 * in use by a real call site rather than added on speculation.
 *
 * ## Two decisions worth knowing
 *
 * It renders `<section>`. Three of the four copies used a `<div>`; my-tasks
 * used `<section>` and was right to. A titled thematic grouping is what the
 * element is for, and it gives screen readers something to navigate by.
 * `<section>` and `<div>` are both block-level with no default styling, so this
 * is free.
 *
 * The body is only wrapped in a `<div>` when `bodyClassName` is passed.
 * Wrapping unconditionally would be tidier to read, but it would insert a node
 * into three pages that render fine today, and an extra wrapper is exactly the
 * kind of change that breaks a layout in a way nobody thinks to check. Callers
 * that need the wrapper ask for it.
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
