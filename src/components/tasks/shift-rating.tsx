/**
 * The staff-facing rating control on a worked shift.
 */
"use client";

import { useState } from "react";
import { MessageSquare, Star } from "lucide-react";
import { StarRatingDisplay, StarRatingInput } from "@/components/ui/star-rating";
import { PRIMARY_BUTTON } from "@/components/ui/button-styles";
import { cn } from "@/lib/utils";

export interface ShiftRatingProps {
  assignmentId: string;
  orgId: string;
  rating: number | null;
  comment: string | null;
  onSaved: () => void;
}

export function ShiftRating({
  assignmentId,
  orgId,
  rating,
  comment,
  onSaved,
}: ShiftRatingProps) {
  const [editing, setEditing] = useState(rating === null);
  const [value, setValue] = useState<number | null>(rating);
  const [text, setText] = useState(comment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (value === null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/assignments/${assignmentId}/rate?orgId=${orgId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: value,
          // Trimmed to undefined rather than sent as "": an empty string would
          // be stored and then rendered as an empty comment line.
          comment: text.trim() ? text.trim() : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not save your rating");
      }
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your rating");
    } finally {
      setSaving(false);
    }
  }

  if (!editing && value !== null) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          You rated this
        </span>
        <StarRatingDisplay value={value} />
        {comment && (
          <span className="text-xs italic text-muted-foreground">
            &ldquo;{comment}&rdquo;
          </span>
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="ml-auto text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <Star className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
        How was this shift?
        <span className="font-normal text-muted-foreground">Optional</span>
      </p>

      <StarRatingInput value={value} onChange={setValue} disabled={saving} />

      {value !== null && (
        <div className="mt-3 space-y-2">
          <label
            htmlFor={`comment-${assignmentId}`}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
          >
            <MessageSquare className="h-3 w-3" aria-hidden="true" />
            Anything your manager should know?
          </label>
          <textarea
            id={`comment-${assignmentId}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            rows={2}
            disabled={saving}
            placeholder="e.g. we were short-staffed after 8pm"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus:border-indigo-400 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className={cn(PRIMARY_BUTTON, "flex-1 justify-center sm:flex-initial")}
            >
              {saving ? "Saving…" : "Submit rating"}
            </button>
            {rating !== null && (
              <button
                type="button"
                onClick={() => {
                  setValue(rating);
                  setText(comment ?? "");
                  setEditing(false);
                  setError(null);
                }}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
