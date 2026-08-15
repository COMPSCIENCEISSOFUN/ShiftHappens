/**
 * Stat Tile
 *
 * The small metric card that heads most pages in the application — a label, a
 * number, a one-line detail, and a tinted corner.
 */
import { cn } from "@/lib/utils";

/**
 * The tinted corner colours in use across the application.
 *
 * Deliberately low-alpha: the tile is a surface, not a badge, and the corner is
 * meant to read as a hint of category rather than as a status. Call sites that
 * need a genuinely coloured VALUE pass `valueColour` instead.
 */
export const STAT_ACCENT = {
  indigo: "rgba(99,102,241,.08)",
  green: "rgba(34,197,94,.08)",
  amber: "rgba(245,158,11,.08)",
  blue: "rgba(59,130,246,.08)",
  red: "rgba(239,68,68,.08)",
  slate: "rgba(148,163,184,.08)",
} as const;

export interface StatTileProps {
  label: string;
  value: string | number;
  detail: string;
  /** One of STAT_ACCENT. Defaults to indigo. */
  accentColour?: string;
  /** Tailwind text colour for the value, e.g. "text-amber-600 dark:text-amber-400". */
  valueColour?: string;
  className?: string;
}

export function StatTile({
  label,
  value,
  detail,
  accentColour = STAT_ACCENT.indigo,
  valueColour,
  className,
}: StatTileProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card p-3.5 sm:p-4",
        className
      )}
    >
      <div
        aria-hidden="true"
        className="absolute right-0 top-0 h-10 w-10 rounded-bl-[40px]"
        style={{ background: accentColour }}
      />
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 text-xl font-bold tracking-tight sm:text-2xl", valueColour)}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
