/**
 * The assistant launcher and panel (Boundary Layer).
 *
 * ## Both gates, at entry, and nothing rendered when either says no
 *
 * The same shape as `ExportReportButton`: permission and plan are read from the
 * providers the shell already supplies, and a refusal renders NOTHING rather
 * than a locked button with an upgrade badge. A control you cannot use is a
 * control you have to think about every time you see it.
 *
 * Both are read after the hooks. An early return above `useState` would change
 * the hook count between renders the moment a permission arrives, which React
 * forbids and which is easy to write by accident when the guard is the first
 * thing on your mind.
 *
 * ## A panel, not a drawer
 *
 * Anchored to the launcher, about the size of a phone screen, and it does not
 * cover the page. The questions are about what you are looking at, so hiding
 * what you are looking at to ask them would work against the feature. Full
 * screen on a phone, where there is no "beside" to be.
 *
 * ## Nothing is persisted
 *
 * The conversation lives in this component's state: it survives navigation
 * inside the organisation, because the shell does not unmount, and it is gone
 * on reload. Deliberate — no table, no retention policy, and no question about
 * whether a company admin can read what their staff typed. What is kept is the
 * audit line, which records the INTENT and never the text.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { usePermissions } from "@/components/layout/permission-provider";
import { usePlan } from "@/components/layout/plan-provider";
import { intentsFor, ASSISTANT_PERMISSION } from "@/lib/assistant-intents";

interface Exchange {
  /** What the person typed, shown back so the thread reads as a conversation. */
  question: string;
  answer: string;
  /** Present only on an answer that came back. */
  classifiedBy?: "ai" | "keywords";
  href?: string;
  failed?: boolean;
}

export function AssistantPanel({ orgId }: { orgId: string }) {
  const { can, permissions } = usePermissions();
  const { has } = usePlan();

  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [thread, setThread] = useState<Exchange[]>([]);
  const [asking, setAsking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Newest exchange in view. `thread.length` rather than `thread`, so an
  // identical answer twice still scrolls.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread.length]);

  if (!can(ASSISTANT_PERMISSION)) return null;
  if (!has("assistant")) return null;

  /*
   * The chips, from the same catalogue the server classifies against and
   * filtered by the same rule. A manager is offered "what needs my attention";
   * a staff member holding this permission through a custom role is not, and
   * is not left to discover the refusal by asking.
   */
  const suggestions = intentsFor(permissions)
    .filter((i) => i.id !== "help")
    .slice(0, 4);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || asking) return;

    setQuestion("");
    setAsking(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const data = await res.json();

      if (!res.ok) {
        /*
         * The server's own words. A 429 says how long to wait and a plan
         * refusal names the tier that would grant this — replacing either with
         * "Something went wrong" would throw away the only useful part.
         */
        setThread((t) => [
          ...t,
          {
            question: trimmed,
            answer: data?.error ?? "Something went wrong.",
            failed: true,
          },
        ]);
        return;
      }

      setThread((t) => [
        ...t,
        {
          question: trimmed,
          answer: data.answer,
          classifiedBy: data.classifiedBy,
          href: data.href,
        },
      ]);
    } catch {
      setThread((t) => [
        ...t,
        {
          question: trimmed,
          answer: "I could not reach the server. Try again in a moment.",
          failed: true,
        },
      ]);
    } finally {
      setAsking(false);
    }
  }

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label="Assistant"
          className="fixed inset-0 z-50 flex flex-col border-border bg-card sm:inset-auto sm:right-6 sm:bottom-24 sm:h-[520px] sm:w-[380px] sm:rounded-2xl sm:border sm:shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-semibold">Assistant</p>
              <p className="text-[11px] text-muted-foreground">
                Answers about this organisation only
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
            >
              &times;
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {thread.length === 0 && (
              <div className="space-y-2">
                <p className="text-[13px] text-muted-foreground">
                  Ask about your shifts, or pick one to start.
                </p>
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => ask(s.prompt)}
                    className="block w-full rounded-lg border border-border px-3 py-2 text-left text-[13px] transition-colors hover:border-indigo-400 hover:bg-muted"
                  >
                    {s.prompt}
                  </button>
                ))}
              </div>
            )}

            {thread.map((exchange, i) => (
              <div key={i} className="space-y-1.5">
                <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-1.5 text-[13px] text-white">
                  {exchange.question}
                </p>
                <div
                  className={`w-fit max-w-[90%] rounded-2xl rounded-bl-sm px-3 py-2 text-[13px] ${
                    exchange.failed
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {/* Answers can carry a short list, and the newlines in them
                      are the formatting. */}
                  <p className="whitespace-pre-line">{exchange.answer}</p>
                  {exchange.href && (
                    <a
                      href={exchange.href}
                      className="mt-1.5 inline-block text-[11px] font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
                    >
                      Open the page
                    </a>
                  )}
                  {/*
                    Said out loud when the providers were unreachable.

                    A keyword answer and a model answer look identical, and an
                    assistant that has quietly stopped understanding paraphrase
                    should say so rather than appear to have got stupid. Same
                    reasoning as the task parser reporting `parsedBy`.
                  */}
                  {exchange.classifiedBy === "keywords" && (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Answered without AI — matched on keywords only
                    </p>
                  )}
                </div>
              </div>
            ))}

            {asking && (
              <p className="text-[12px] text-muted-foreground">Thinking…</p>
            )}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
            className="flex gap-2 border-t border-border px-3 py-3"
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask about your shifts…"
              aria-label="Ask the assistant"
              maxLength={500}
              className="h-9 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
            />
            <button
              type="submit"
              disabled={asking || question.trim() === ""}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Ask
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close assistant" : "Open assistant"}
        aria-expanded={open}
        className="fixed right-6 bottom-6 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-indigo-600 to-violet-600 text-lg font-bold text-white shadow-lg transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
      >
        {open ? "×" : "?"}
      </button>
    </>
  );
}
