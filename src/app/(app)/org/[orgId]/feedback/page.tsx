/**
 * Send Feedback Page (Boundary Layer)
 *
 * Any member, no permission, no plan gate — see the route for why.
 *
 * ## It says what it is
 *
 * There is no status, no reply and no place to come back to, so the page does
 * not imply any of the three. It is "send feedback", not "raise a ticket": a
 * ticket is something you chase, and a product that offers one and then never
 * mentions it again has told a small lie on the way in. The confirmation says
 * what actually happens to it and nothing more.
 */
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AlertBanner } from "@/components/ui/alert-banner";
import {
  FEEDBACK_AREAS,
  FEEDBACK_AREA_LABEL,
  FEEDBACK_MAX_LENGTH,
  type FeedbackArea,
} from "@/lib/feedback-areas";

export default function FeedbackPage() {
  const params = useParams<{ orgId: string }>();
  const orgId = params?.orgId;

  const [area, setArea] = useState<FeedbackArea | "">("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = FEEDBACK_MAX_LENGTH - message.length;
  const canSend = area !== "" && message.trim().length > 0 && !sending;

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) return;

    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/organizations/${orgId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area, message }),
      });
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        setError(result?.error || "Could not send that. Try again in a moment.");
        return;
      }

      toast.success("Thanks — that has been sent to the team.");
      setArea("");
      setMessage("");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    /*
      `max-w-2xl` and NOT centred. One column of prose and a textarea should
      not stretch to a 1600px monitor, but every other page in the application
      starts its content at the left edge — centring this one moves the title
      away from where the eye has learned to find it, which is the same "reads
      as a different product" the dashboards were rebuilt for.
    */
    <div className="w-full max-w-2xl">
      {/*
        The house header: `h2`, bold, a 13px muted line under it, `mb-4` to the
        content. Availability, Notifications, Work Rules, Leave and My
        Certifications all do this; this page arrived with an `h1`, semibold,
        a 14px line and a decorative icon tile no other page has.
      */}
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
          Send feedback
        </h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Tell us what is working, what is not, and what you wish this did. It
          goes straight to the people building it.
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

      <form onSubmit={send} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="feedback-area">What is this about?</Label>
          {/*
            Buttons rather than a <select>. On a phone a native select opens a
            system sheet that hides the rest of the form, and there are only six
            options — few enough to show all of them and let the choice be one
            tap instead of three.
          */}
          <div
            id="feedback-area"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {FEEDBACK_AREAS.map((candidate) => {
              const selected = area === candidate;
              return (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setArea(candidate)}
                  aria-pressed={selected}
                  className={`rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                    selected
                      ? "border-primary bg-primary/10 font-medium text-primary"
                      : "border-border bg-card hover:bg-accent"
                  }`}
                >
                  {FEEDBACK_AREA_LABEL[candidate]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="feedback-message">Your feedback</Label>
            <span
              className={`text-xs tabular-nums ${
                remaining < 0 ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {remaining} left
            </span>
          </div>
          <textarea
            id="feedback-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={7}
            maxLength={FEEDBACK_MAX_LENGTH}
            placeholder="The more specific the better — what were you trying to do?"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        {/*
          Stacked on a phone, inline above it. The note sits with the button
          because it is the answer to "what happens when I press this".
        */}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            We read everything. We cannot reply to each one.
          </p>
          {/*
            Spinner while it is in flight, matching the review form next door.
            A static icon over the word "Sending…" says the press registered
            and nothing about whether anything is still happening.
          */}
          <Button type="submit" disabled={!canSend} className="w-full sm:w-auto">
            {sending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {sending ? "Sending…" : "Send feedback"}
          </Button>
        </div>
      </form>
    </div>
  );
}
