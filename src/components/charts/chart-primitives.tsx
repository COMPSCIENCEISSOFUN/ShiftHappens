/**
 * Chart primitives — donut, stacked bar, bar list, meter, heatmap.
 *
 * Hand-rolled SVG and flexbox, matching the rest of the app: there is no chart
 * library in this project and adding one for five small charts would be a large
 * dependency for a small gain.
 *
 * ## What every chart here carries
 *
 * A legend whenever there are two or more series, so identity is never
 * conveyed by colour alone. Direct labels on the values, which doubles as the
 * relief the light-mode contrast warning requires (see palette.ts). A
 * screen-reader table, because a chart with no text equivalent is unreadable to
 * anyone not looking at it. A native tooltip on each mark. And a 2px surface
 * gap between adjacent fills so touching segments stay separable.
 *
 * Empty states are explicit rather than a chart drawn from zeroes — an empty
 * donut and a donut of nothing look the same, and only one of them is honest.
 */
import { cn } from "@/lib/utils";
import { CATEGORICAL, NEUTRAL, ORDINAL, SEQUENTIAL, TRACK, sequentialStep } from "./palette";

export interface Slice {
  key: string;
  label: string;
  value: number;
  /** A palette value. Callers pick the ramp; this component does not guess. */
  colour: string;
}

/* ------------------------------------------------------------------ */
/*  Shared                                                             */
/* ------------------------------------------------------------------ */

/**
 * The text equivalent, for readers who are not looking at the picture.
 *
 * `sr-only` rather than a toggle: a visible table beside every chart would
 * double the page length, and this is the requirement's substance — the numbers
 * exist in text somewhere reachable.
 *
 * ## The wrapper div is load-bearing — do not put `sr-only` on the table
 *
 * `sr-only` works by making the element 1×1, absolutely positioned, with
 * `overflow: hidden`. That is fine on a `<div>`. It is NOT fine on a `<table>`:
 * CSS `height` on a table is a *minimum*, not a size, and `overflow` on a
 * table box is not reliably honoured. So `<table class="sr-only">` lays out at
 * its full natural height — and although it is absolutely positioned, and
 * therefore does not push anything down, it still contributes to the page's
 * scrollable area.
 *
 * The symptom is a page you can scroll a long way past its content into
 * nothing. Measured in Chromium: an 800px page with a hidden 97-row table
 * became 2935px with `sr-only` on the table, and stayed 800px with the table
 * wrapped in an `sr-only` div. The coverage heatmap's table is 97 rows on a
 * populated week, which is exactly how this was found.
 */
function DataTable({
  caption,
  rows,
  valueHeading = "Count",
}: {
  caption: string;
  rows: { label: string; value: number | string }[];
  valueHeading?: string;
}) {
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">{valueHeading}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend({ slices, total }: { slices: Slice[]; total: number }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
      {slices.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: s.colour }}
          />
          <span className="text-xs text-muted-foreground">{s.label}</span>
          <span className="text-xs font-semibold tabular-nums">
            {s.value}
            {total > 0 && (
              <span className="ml-1 font-normal text-muted-foreground">
                {Math.round((s.value / total) * 100)}%
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmptyChart({ message }: { message: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{message}</p>;
}

/* ------------------------------------------------------------------ */
/*  Donut                                                              */
/* ------------------------------------------------------------------ */

const DONUT_R = 15.9155; // circumference 100, so dasharray reads as percentages

/**
 * Part-to-whole as a ring, with the total in the middle.
 *
 * A donut rather than a pie: the hole gives the total a home, and comparing arc
 * lengths on a ring is no worse than comparing wedge areas — which people are
 * measurably bad at. Above about five slices neither works and this should be a
 * bar chart instead; the caller is trusted not to do that.
 *
 * Segments are separated by a 2px surface-coloured gap so two adjacent arcs of
 * similar lightness stay distinguishable.
 */
export function Donut({
  slices,
  centreLabel,
  emptyMessage = "No data yet",
  className,
}: {
  slices: Slice[];
  centreLabel?: string;
  emptyMessage?: string;
  className?: string;
}) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const drawn = slices.filter((s) => s.value > 0);

  if (total === 0) {
    return (
      <div className={className}>
        <EmptyChart message={emptyMessage} />
        <DataTable caption="Distribution" rows={slices.map((s) => ({ label: s.label, value: 0 }))} />
      </div>
    );
  }

  // A single slice at 100% must not be drawn with a gap, or the ring shows a
  // notch where nothing is missing.
  const GAP = drawn.length > 1 ? 1.2 : 0;

  // Offsets are computed before the map rather than accumulated inside it.
  // Mutating during render is the bug React's strict rules exist to catch: a
  // re-render that reuses the closure would draw every arc from the wrong
  // start angle.
  const arcs: { slice: Slice; percent: number; offset: number }[] = [];
  let running = 0;
  for (const slice of drawn) {
    const percent = (slice.value / total) * 100;
    arcs.push({ slice, percent, offset: running });
    running += percent;
  }

  return (
    <div className={cn("flex flex-col items-center gap-4 sm:flex-row sm:items-center", className)}>
      <div className="relative h-[128px] w-[128px] shrink-0">
        <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90" role="presentation">
          <circle
            cx="18"
            cy="18"
            r={DONUT_R}
            fill="none"
            stroke={TRACK}
            strokeWidth="3.6"
          />
          {arcs.map(({ slice, percent, offset }) => {
            const dash = Math.max(0, percent - GAP);
            return (
              <circle
                key={slice.key}
                cx="18"
                cy="18"
                r={DONUT_R}
                fill="none"
                stroke={slice.colour}
                strokeWidth="3.6"
                strokeDasharray={`${dash} ${100 - dash}`}
                strokeDashoffset={-offset}
              >
                <title>{`${slice.label}: ${slice.value} (${Math.round(percent)}%)`}</title>
              </circle>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-bold leading-none tracking-tight">{total}</span>
          {centreLabel && (
            <span className="mt-0.5 text-xs uppercase tracking-wider text-muted-foreground">
              {centreLabel}
            </span>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <Legend slices={slices} total={total} />
      </div>

      <DataTable
        caption={centreLabel ? `Distribution of ${centreLabel}` : "Distribution"}
        rows={slices.map((s) => ({ label: s.label, value: s.value }))}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stacked bar                                                        */
/* ------------------------------------------------------------------ */

/**
 * Part-to-whole as a horizontal bar.
 *
 * Preferred over a donut when the category names are long — they sit in a
 * legend that reads left to right instead of being crammed around a circle.
 */
export function StackedBar({
  slices,
  emptyMessage = "No data yet",
  className,
}: {
  slices: Slice[];
  emptyMessage?: string;
  className?: string;
}) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const drawn = slices.filter((s) => s.value > 0);

  if (total === 0) {
    return (
      <div className={className}>
        <EmptyChart message={emptyMessage} />
      </div>
    );
  }

  return (
    <div className={cn("space-y-2.5", className)}>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="presentation">
        {drawn.map((s) => (
          <div
            key={s.key}
            className="first:rounded-l-full last:rounded-r-full"
            style={{ background: s.colour, width: `${(s.value / total) * 100}%` }}
            title={`${s.label}: ${s.value} (${Math.round((s.value / total) * 100)}%)`}
          />
        ))}
      </div>
      <Legend slices={slices} total={total} />
      <DataTable caption="Breakdown" rows={slices.map((s) => ({ label: s.label, value: s.value }))} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Bar list                                                           */
/* ------------------------------------------------------------------ */

/**
 * Ranked magnitudes as horizontal bars.
 *
 * One hue for every bar, not a colour per row. The bar's length already encodes
 * the value; colouring by value spends the identity channel saying the same
 * thing twice, and these rows are nominal — nothing is ordered by the category
 * name.
 */
export function BarList({
  rows,
  emptyMessage = "Nothing recorded",
  valueSuffix = "",
  className,
}: {
  rows: { key: string; label: string; value: number; hint?: string }[];
  emptyMessage?: string;
  valueSuffix?: string;
  className?: string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 0);

  if (rows.length === 0 || max === 0) {
    return <EmptyChart message={emptyMessage} />;
  }

  const sorted = [...rows].sort((a, b) => b.value - a.value);

  return (
    <div className={cn("space-y-2.5", className)}>
      {sorted.map((r) => (
        <div key={r.key}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="truncate text-xs text-foreground" title={r.hint ?? r.label}>
              {r.label}
            </span>
            <span className="shrink-0 text-xs font-semibold tabular-nums">
              {r.value}
              {valueSuffix}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full" style={{ background: TRACK }}>
            <div
              className="h-full rounded-full"
              style={{
                background: CATEGORICAL[0],
                width: `${Math.max((r.value / max) * 100, 3)}%`,
              }}
              title={`${r.label}: ${r.value}${valueSuffix}`}
            />
          </div>
        </div>
      ))}
      <DataTable
        caption="Values"
        rows={sorted.map((r) => ({ label: r.label, value: `${r.value}${valueSuffix}` }))}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Meter                                                              */
/* ------------------------------------------------------------------ */

/**
 * A single ratio against its whole.
 *
 * A meter rather than a two-slice donut: with one number and its complement
 * there is nothing to compare, and a bar reads faster than an arc.
 */
export function Meter({
  label,
  percentage,
  detail,
  emphasis = false,
}: {
  label: string;
  percentage: number | null;
  detail: string;
  /** Draws in the accent hue. Use for the figure the panel is actually about. */
  emphasis?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-base font-bold tabular-nums">
          {percentage === null ? "—" : `${percentage}%`}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full"
        style={{ background: TRACK }}
        role="img"
        aria-label={`${label}: ${percentage === null ? "no data" : `${percentage} percent`}. ${detail}`}
      >
        {percentage !== null && (
          <div
            className="h-full rounded-full"
            style={{
              background: emphasis ? CATEGORICAL[0] : NEUTRAL,
              width: `${Math.min(Math.max(percentage, 0), 100)}%`,
            }}
          />
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Coverage heatmap                                                   */
/* ------------------------------------------------------------------ */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface CoverageCell {
  dayOfWeek: number;
  hour: number;
  count: number;
}

/**
 * Staff availability across the week, as a 7 × 24 grid.
 *
 * Magnitude on a grid, so: one hue, light to dark, and zero pinned to the
 * palest step rather than scaled. A quiet hour must look the same whether the
 * rest of the week is busy or not.
 *
 * Hours are labelled every three columns. Labelling all 24 produces a row of
 * overlapping numbers at any width this fits in, and the tooltip on each cell
 * carries the exact hour anyway.
 */
export function CoverageHeatmap({
  cells,
  emptyMessage = "No availability recorded yet",
  className,
}: {
  cells: CoverageCell[];
  emptyMessage?: string;
  className?: string;
}) {
  const max = Math.max(...cells.map((c) => c.count), 0);

  if (cells.length === 0 || max === 0) {
    return <EmptyChart message={emptyMessage} />;
  }

  const byDay = DAY_LABELS.map((_, day) =>
    Array.from({ length: 24 }, (_, hour) => {
      const cell = cells.find((c) => c.dayOfWeek === day && c.hour === hour);
      return cell?.count ?? 0;
    })
  );

  const busiest = cells.reduce((best, c) => (c.count > best.count ? c : best), cells[0]);

  return (
    <div className={className}>
      <div className="overflow-x-auto">
        <div className="min-w-[520px]">
          {/* Hour scale */}
          <div className="mb-1 flex gap-0.5 pl-9">
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="flex-1 text-center">
                {hour % 3 === 0 && (
                  <span className="text-xs tabular-nums text-muted-foreground">{hour}</span>
                )}
              </div>
            ))}
          </div>

          {byDay.map((hours, day) => (
            <div key={day} className="mb-0.5 flex items-center gap-0.5">
              <span className="w-9 shrink-0 text-xs text-muted-foreground">
                {DAY_LABELS[day]}
              </span>
              {hours.map((count, hour) => (
                <div
                  key={hour}
                  className="h-5 flex-1 rounded-sm"
                  style={{ background: sequentialStep(count, max) }}
                  title={`${DAY_LABELS[day]} ${String(hour).padStart(2, "0")}:00 — ${count} available`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Scale key */}
      <div className="mt-2.5 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">None</span>
        <div className="flex gap-0.5">
          {SEQUENTIAL.map((colour, i) => (
            <div
              key={i}
              className="h-2.5 w-5 rounded-sm"
              style={{ background: colour }}
              aria-hidden="true"
            />
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{max} staff</span>
        <span className="ml-auto text-xs text-muted-foreground">
          Busiest: {DAY_LABELS[busiest.dayOfWeek]}{" "}
          {String(busiest.hour).padStart(2, "0")}:00
        </span>
      </div>

      <DataTable
        caption="Staff available by day and hour"
        valueHeading="Staff available"
        rows={cells
          .filter((c) => c.count > 0)
          .map((c) => ({
            label: `${DAY_LABELS[c.dayOfWeek]} ${String(c.hour).padStart(2, "0")}:00`,
            value: c.count,
          }))}
      />
    </div>
  );
}

export { CATEGORICAL, NEUTRAL, ORDINAL, SEQUENTIAL };
