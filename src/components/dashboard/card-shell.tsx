"use client";

/**
 * One card, one frame.
 *
 * The three dashboards this replaces carried three mutually incompatible tile
 * styles and re-typed the same bordered panel in a dozen places. A shell means
 * a card author writes the contents and nothing else, and the spacing between
 * two cards cannot depend on which one you are looking at.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type CardTone = "default" | "warning" | "danger";

const TONE: Record<CardTone, string> = {
  default: "border-border",
  warning: "border-amber-300/70 dark:border-amber-800/70",
  danger: "border-destructive/40",
};

export function DashboardCardShell({
  title,
  tone = "default",
  action,
  children,
  className,
}: {
  title?: string;
  tone?: CardTone;
  /** A link or button belonging to the card, rendered beside the title. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border bg-card p-4 shadow-sm sm:p-5",
        TONE[tone],
        className
      )}
    >
      {title && (
        <header className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * What a card renders when its data is null.
 *
 * Null from this endpoint means the query THREW — the route settles each
 * section independently and writes null for a rejection. Rendering that as a
 * zero, an empty list or a green "all clear" is how a broken dashboard came to
 * report good news. Every card that can receive null says this instead.
 */
export function CardLoadFailed({ what }: { what: string }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[13px] text-muted-foreground">
      Could not load {what}. Refresh to try again.
    </p>
  );
}
