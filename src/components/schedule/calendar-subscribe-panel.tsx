"use client";

/**
 * Subscribe to your shifts from a calendar app — US-81.
 *
 * ## Why a URL and not a download button
 *
 * A downloaded .ics is a snapshot. The moment a shift moves, the copy in
 * somebody's calendar is wrong and nothing tells them — which is worse than not
 * having it, because they now trust it. A subscribe URL is polled, so the rota
 * in their phone is the rota in the product.
 *
 * ## Why the warning is not a disclaimer
 *
 * Calendar clients send no session, so the link IS the credential: anyone
 * holding it can read this person's shifts until it is replaced. That is a real
 * thing for the reader to know before they paste it somewhere, and Regenerate
 * beside it is the only remedy — so the two sit together rather than the
 * warning living in a help page nobody opens.
 */

import { useCallback, useEffect, useState } from "react";
import { CalendarSync, Check, Copy, RefreshCw } from "lucide-react";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";

export function CalendarSubscribePanel({ orgId }: { orgId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/calendar/feed`);
      const body = await res.json();
      if (!res.ok || typeof body?.token !== "string") {
        setError("Could not load your calendar link");
        return;
      }
      setToken(body.token);
      setLastPolledAt(
        typeof body.lastPolledAt === "string" ? body.lastPolledAt : null
      );
      setError(null);
    } catch {
      setError("Could not load your calendar link");
    }
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: fetches this member's subscribe token
    load();
  }, [load]);

  /*
   * Built in the browser rather than returned by the server, because the server
   * does not reliably know its own public address behind a proxy — and getting
   * it wrong produces a URL that looks right and resolves to nothing.
   */
  const url = token
    ? `${typeof window === "undefined" ? "" : window.location.origin}/api/calendar/${token}`
    : "";

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      // Reverts on its own: a button stuck on "Copied" is a button whose state
      // stops meaning anything the second time.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy — select the link and copy it manually");
    }
  }

  async function regenerate() {
    setBusy(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/calendar/feed`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok || typeof body?.token !== "string") {
        setError("Could not create a new link");
        return;
      }
      setToken(body.token);
      // A fresh link has never been fetched. Leaving the old timestamp would
      // say the new one is working before anything has used it.
      setLastPolledAt(null);
      setError(null);
    } catch {
      setError("Could not create a new link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
          <CalendarSync className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Subscribe in your calendar</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Add this link to Google Calendar, Apple Calendar or Outlook and your
            shifts appear there, updating on their own. Shifts you have not
            answered yet show as tentative.
          </p>

          {error && (
            <p className="mt-2 text-[12px] text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              readOnly
              value={url}
              aria-label="Your calendar subscribe link"
              onFocus={(e) => e.currentTarget.select()}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 font-mono text-[12px] text-muted-foreground"
            />
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={copy}
                disabled={!url}
                className={SECONDARY_BUTTON}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={regenerate}
                disabled={busy}
                className={SECONDARY_BUTTON}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                {busy ? "Working…" : "New link"}
              </button>
            </div>
          </div>

          {/*
            Said plainly, next to the remedy. The link carries no password —
            that is inherent to how calendar apps fetch, not a shortcut — so the
            reader needs to know before they paste it into a group chat, and
            "New link" is the only way to take it back.
          */}
          <p className="mt-2 text-[12px] text-muted-foreground">
            Anyone with this link can see your shifts. Choose{" "}
            <span className="font-medium">New link</span> to stop the old one
            working.
          </p>

          {/*
            Whether anything has actually fetched it.
            
            Subscribing fails silently in every calendar app: paste a URL with a
            typo and it simply shows no events, which is indistinguishable from
            having no shifts. This is the only signal the person has that the
            other end is real — and `[]` rather than a locale, so the date reads
            in the reader's own format.
          */}
          <p className="mt-1 text-[12px] text-muted-foreground">
            {lastPolledAt
              ? `Last fetched ${new Date(lastPolledAt).toLocaleString([], {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}.`
              : "Not fetched yet — it can take a calendar app up to an hour to check the first time."}
          </p>
        </div>
      </div>
    </div>
  );
}
