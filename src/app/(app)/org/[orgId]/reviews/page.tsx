/**
 * Write a Review Page (Boundary Layer)
 *
 * One review per member, edited rather than added to — so this screen is the
 * same whether you are writing your first or changing your mind, and it opens
 * with whatever you said last time.
 *
 * ## It says what publishing means before you write
 *
 * Your name and your organisation appear on the public landing page if it is
 * approved. That is stated above the box rather than in a sentence underneath
 * the button, because consent given after the fact is not consent.
 *
 * ## Editing withdraws approval, and the screen says so
 *
 * Saving a change returns the review to the queue. A person who tweaks a word
 * and finds their review has vanished from the site would reasonably think
 * something broke, so the status panel explains it before they save.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2, Send, Star } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageLoading } from "@/components/ui/page-loading";
import {
  REVIEW_MAX_LENGTH,
  REVIEW_MAX_RATING,
  REVIEW_STATUS_LABEL,
  REVIEW_STATUS_NOTE,
  isReviewStatus,
} from "@/lib/review-status";

interface MyReview {
  id: string;
  rating: number;
  body: string;
  status: string;
  updatedAt: string;
}

export default function WriteReviewPage() {
  const params = useParams<{ orgId: string }>();
  const orgId = params?.orgId;

  const [existing, setExisting] = useState<MyReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/organizations/${orgId}/reviews`);
      if (!response.ok) {
        setError("Could not load your review. Refresh to try again.");
        return;
      }
      const body_ = await response.json();
      const mine: MyReview | null = body_.review ?? null;
      setExisting(mine);
      if (mine) {
        setRating(mine.rating);
        setBody(mine.body);
      }
      setError(null);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    !existing || rating !== existing.rating || body !== existing.body;
  const canSave = rating > 0 && body.trim().length > 0 && dirty && !saving;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/organizations/${orgId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, body }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        setError(result?.error || "Could not save that. Try again in a moment.");
        return;
      }
      toast.success(
        existing?.status === "approved"
          ? "Saved — it will reappear on the site once we have looked again."
          : "Saved. We will take a look before it appears on the site."
      );
      await load();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <PageLoading label="Loading your review…" />;

  const status = existing && isReviewStatus(existing.status) ? existing.status : null;
  const remaining = REVIEW_MAX_LENGTH - body.length;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
          {existing ? "Your review" : "Write a review"}
        </h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          If we publish it, your name and organisation appear with it on our
          landing page
        </p>
      </div>

      {error && (
        <AlertBanner
          className="mb-4"
          variant="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}

      {status && (
        <div className="mb-4 rounded-xl border border-border bg-card p-4 text-sm shadow-sm">
          <p className="font-medium">{REVIEW_STATUS_LABEL[status]}</p>
          <p className="mt-0.5 text-muted-foreground">
            {REVIEW_STATUS_NOTE[status]}
          </p>
          {status === "approved" && (
            <p className="mt-2 text-[13px] text-muted-foreground">
              Changing it takes it off the site until we have looked again.
            </p>
          )}
        </div>
      )}

      <form onSubmit={save} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="review-rating">How is it going?</Label>
          {/*
            Buttons rather than a slider or a select: a star is the one control
            everybody already knows, and each one is a full tap target.
          */}
          <div id="review-rating" className="flex gap-1">
            {Array.from({ length: REVIEW_MAX_RATING }, (_, i) => i + 1).map(
              (value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setRating(value)}
                  aria-label={`${value} out of ${REVIEW_MAX_RATING}`}
                  aria-pressed={rating === value}
                  className="rounded-md p-1.5 transition-transform hover:scale-110"
                >
                  <Star
                    className={`h-7 w-7 ${
                      value <= rating
                        ? "fill-amber-400 text-amber-400"
                        : "text-muted-foreground/40"
                    }`}
                  />
                </button>
              )
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="review-body">In your words</Label>
            <span
              className={`text-xs tabular-nums ${
                remaining < 0 ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {remaining} left
            </span>
          </div>
          <textarea
            id="review-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={6}
            maxLength={REVIEW_MAX_LENGTH}
            placeholder="What changed for your team since you started using it?"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            You have one review. Saving replaces it.
          </p>
          <Button type="submit" disabled={!canSave} className="w-full sm:w-auto">
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {saving ? "Saving…" : existing ? "Save changes" : "Submit review"}
          </Button>
        </div>
      </form>
    </div>
  );
}
