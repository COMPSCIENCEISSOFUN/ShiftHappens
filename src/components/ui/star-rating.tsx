/**
 * Star rating — read-only display and an interactive picker.
 */
"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

const VALUES = [1, 2, 3, 4, 5] as const;

/**
 * Words, not just a number. "4 out of 5" tells a manager the score; "Good"
 * tells them what the person meant by it, and the two together stop a 3 being
 * read as a failing grade by one reader and a pass by another.
 */
export const RATING_LABEL: Record<number, string> = {
  1: "Bad",
  2: "Poor",
  3: "Okay",
  4: "Good",
  5: "Great",
};

function starClass(filled: boolean) {
  return filled
    ? "fill-amber-400 text-amber-400"
    : "fill-none text-muted-foreground/40";
}

/** Non-interactive display of a recorded rating. */
export function StarRatingDisplay({
  value,
  size = "sm",
  showLabel = true,
}: {
  value: number;
  size?: "sm" | "md";
  showLabel?: boolean;
}) {
  const dimension = size === "md" ? "h-4 w-4" : "h-3 w-3";

  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex" aria-hidden="true">
        {VALUES.map((v) => (
          <Star key={v} className={cn(dimension, starClass(v <= value))} />
        ))}
      </span>
      {/* The stars are decorative; this is what is actually announced. */}
      <span className="sr-only">
        {value} out of 5 — {RATING_LABEL[value]}
      </span>
      {showLabel && (
        <span className="text-xs font-medium text-muted-foreground" aria-hidden="true">
          {RATING_LABEL[value]}
        </span>
      )}
    </span>
  );
}

/**
 * Interactive picker.
 *
 * `hovered` drives the preview but never the announced value — a mouse moving
 * across the row must not make a screen reader read out four different scores.
 */
export function StarRatingInput({
  value,
  onChange,
  disabled,
  label = "Rate this shift",
}: {
  value: number | null;
  onChange: (value: number) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const shown = hovered ?? value ?? 0;

  return (
    <div className="flex items-center gap-2">
      <div
        role="radiogroup"
        aria-label={label}
        className="flex items-center gap-0.5"
        onMouseLeave={() => setHovered(null)}
      >
        {VALUES.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            aria-label={`${v} out of 5 — ${RATING_LABEL[v]}`}
            disabled={disabled}
            onClick={() => onChange(v)}
            onMouseEnter={() => setHovered(v)}
            onFocus={() => setHovered(v)}
            onBlur={() => setHovered(null)}
            className={cn(
              "rounded p-1 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
            )}
          >
            <Star className={cn("h-5 w-5", starClass(v <= shown))} />
          </button>
        ))}
      </div>
      {/* Empty rather than absent when nothing is chosen: a label that appears
          only once a star is picked shifts the row's layout under the cursor. */}
      <span className="min-w-[3.5rem] text-xs font-medium text-muted-foreground">
        {shown > 0 ? RATING_LABEL[shown] : ""}
      </span>
    </div>
  );
}
