/**
 * Choosing which certificates a shift requires.
 *
 * ## Why this replaced a text box
 *
 * It was `<Input placeholder="e.g. Food Safety, RSA" />` and a comma split. The
 * member's own screen was a different text box, placeholdered "e.g. Food Safety
 * Level 2", and `EligibilityService.checkCertifications` compares the two by
 * lower-cased string equality. Follow both hints and the holder is silently
 * ineligible for a shift they are qualified for — and told they are "Missing
 * required certification(s): Food Safety" while holding one.
 *
 * The manager is not losing a decision here. They still say which certificates
 * this shift needs; they have stopped also having to guess how somebody else
 * spelled them.
 *
 * ## Why a name already on the task stays selectable
 *
 * `extras` are requirements the task carries that are NOT on the organisation's
 * list — a task written before the list existed, or one whose certificate was
 * removed from it since. They render as ticked, and unticking them works.
 *
 * Dropping them silently would be the worst version of this change: a manager
 * opens a shift to move its start time, saves, and the food-safety requirement
 * is gone with nothing said. This is the same rule the role permission picker
 * follows — what is already granted stays editable, because removing is not the
 * thing being guarded against.
 */
"use client";

import Link from "next/link";
import { Award, Lock } from "lucide-react";
import { Label } from "@/components/ui/label";

export interface CertificationOption {
  id: string;
  name: string;
}

export function CertificationPicker({
  options,
  selected,
  onToggle,
  orgId,
  canManageList,
  label = "Required certifications",
}: {
  /** The organisation's recognised list. */
  options: CertificationOption[];
  /** Names currently required. Matched case-insensitively against `options`. */
  selected: string[];
  onToggle: (name: string) => void;
  orgId: string;
  /** Whether to offer a route to the screen that adds one. */
  canManageList: boolean;
  label?: string;
}) {
  const chosen = new Set(selected.map((n) => n.trim().toLowerCase()));

  /*
   * Requirements the task holds that the list does not know about. Shown after
   * the recognised ones, marked, and removable — see the docblock.
   */
  const known = new Set(options.map((o) => o.name.trim().toLowerCase()));
  const extras = selected.filter((n) => !known.has(n.trim().toLowerCase()));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-semibold text-muted-foreground">
          {label}
        </Label>
        {chosen.size > 0 && (
          <span className="text-xs text-muted-foreground">
            {chosen.size} selected
          </span>
        )}
      </div>

      {options.length === 0 && extras.length === 0 ? (
        /*
          A new organisation has an empty list, and an empty picker with no
          explanation reads as a broken control. It says where the list is
          filled in — and only offers the link to somebody who could act on it.
        */
        <p className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
          This organisation has no recognised certificates yet.{" "}
          {canManageList ? (
            <Link
              href={`/org/${orgId}/certifications`}
              className="font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
            >
              Add them on the Certifications page
            </Link>
          ) : (
            "Ask a company admin to add them."
          )}
          .
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-border p-2">
          {options.map((option) => {
            const on = chosen.has(option.name.trim().toLowerCase());
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onToggle(option.name)}
                aria-pressed={on}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                  on
                    ? "bg-indigo-600 text-white"
                    : "bg-muted text-muted-foreground hover:bg-muted/70"
                }`}
              >
                <Award className="h-3 w-3 shrink-0" aria-hidden="true" />
                {option.name}
              </button>
            );
          })}

          {extras.map((name) => (
            <button
              key={`extra-${name}`}
              type="button"
              onClick={() => onToggle(name)}
              aria-pressed
              title="Not on the organisation's list. Removing it here is permanent."
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 px-2.5 py-1 text-xs font-medium text-white"
            >
              <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
              {name}
            </button>
          ))}
        </div>
      )}

      {extras.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {extras.length === 1
            ? `"${extras[0]}" is not on the organisation's list.`
            : `${extras.length} of these are not on the organisation's list.`}{" "}
          They still apply. Remove one here and it cannot be added back until it
          is on the list.
        </p>
      )}
    </div>
  );
}
