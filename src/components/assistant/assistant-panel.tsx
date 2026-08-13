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
import Link from "next/link";
import { usePermissions } from "@/components/layout/permission-provider";
import { usePlan } from "@/components/layout/plan-provider";
import { intentsFor, ASSISTANT_PERMISSION } from "@/lib/assistant-intents";

interface Exchange {
  /** What the person typed, shown back so the thread reads as a conversation. */
  question: string;
  answer: string;
  /** What it resolved to. Sent with the NEXT question as its only context. */
  intent?: string;
  /** Present only on an answer that came back. */
  classifiedBy?: "certain" | "ai" | "fallback";
  href?: string;
  hrefLabel?: string;
  failed?: boolean;
}

export function AssistantPanel({
  orgId,
  /**
   * The caller's system role, for `canBeRostered`.
   *
   * A company admin is never rostered, so the four questions about your own
   * shifts are not offered to one — they would each answer "you have no
   * shifts", which reads as a rota that happens to be empty rather than as
   * somebody who is not on it.
   */
  role,
}: {
  orgId: string;
  role?: string;
}) {
  const { can, permissions } = usePermissions();
  const { has } = usePlan();

  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [thread, setThread] = useState<Exchange[]>([]);
  const [asking, setAsking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * A conversation belongs to ONE organisation.
   *
   * The shell is not unmounted when the org id in the URL changes — that is
   * what makes the switcher feel instant — so without this, switching from
   * Ocean Grill to Harbour Cafe left Ocean Grill's answers sitting under
   * Harbour Cafe's sidebar. Nothing leaks: the reader had already been shown
   * every word of it. But an answer about one organisation, framed by
   * another's chrome, is exactly the confusion putting the org in the URL was
   * meant to end.
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: the organisation is owned by the URL, and this component cannot derive a reset from its own render
    setThread([]);
    setQuestion("");
    setOpen(false);
  }, [orgId]);

  /*
   * Escape closes it, and opening moves focus into it.
   *
   * `role="dialog"` promises both. Without them a screen reader is told this
   * is a dialog and then handed none of the behaviour the word implies —
   * which is the same defect as the Members table announcing a control that
   * could not be reached by keyboard.
   *
   * Deliberately NOT a focus trap. A trap is right for a modal that must be
   * answered; this panel sits beside a page the reader is expected to keep
   * using, and stealing tab from it would be worse than the omission.
   */
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector("input")?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
  const suggestions = intentsFor(permissions, role)
    .filter((i) => i.id !== "help")
    .slice(0, 4);

  /*
   * Stay open on a desktop, get out of the way on a phone.
   *
   * The panel is anchored beside the page at `sm` and up, so following a link
   * leaves the answer visible next to the thing it was about — which is the
   * point of answering with a link at all. Below `sm` it is `inset-0` and
   * covers the whole screen, so staying open would hide the page it just sent
   * you to.
   *
   * Read at click time rather than tracked in state: this is a one-off
   * question about the viewport as it is right now, and a resize listener for
   * it would be a subscription maintained for an event that happens once.
   */
  function closeIfCovering() {
    if (window.matchMedia("(max-width: 639px)").matches) setOpen(false);
  }

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || asking) return;

    setQuestion("");
    setAsking(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          /*
           * The last thing that resolved, so "and Jamie?" keeps its subject.
           * Read from the thread rather than held in its own state — one place
           * that knows what was asked, and it is the place already rendering
           * it.
           */
          previousIntent: thread[thread.length - 1]?.intent,
        }),
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
          intent: data.intent,
          classifiedBy: data.classifiedBy,
          href: data.href,
          hrefLabel: data.hrefLabel,
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
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="Assistant"
          className="fixed inset-0 z-50 flex flex-col border-border bg-card sm:inset-auto sm:right-6 sm:bottom-24 sm:h-[520px] sm:w-[380px] sm:rounded-2xl sm:border sm:shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-semibold">Assistant</p>
              <p className="text-xs text-muted-foreground">
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
                <p className="text-sm text-muted-foreground">
                  Ask about your shifts, or pick one to start.
                </p>
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => ask(s.prompt)}
                    className="block w-full rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors hover:border-indigo-400 hover:bg-muted"
                  >
                    {s.prompt}
                  </button>
                ))}
              </div>
            )}

            {thread.map((exchange, i) => (
              <div key={i} className="space-y-1.5">
                <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-1.5 text-sm text-white">
                  {exchange.question}
                </p>
                <div
                  className={`w-fit max-w-[90%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm ${
                    exchange.failed
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {/* Answers can carry a short list, and the newlines in them
                      are the formatting. */}
                  <p className="whitespace-pre-line">{exchange.answer}</p>
                  {/*
                    `Link`, not `<a>`.

                    A plain anchor is a full page load: the whole application
                    reboots, `AppShell` remounts, and the conversation is gone —
                    which defeats the one thing this panel's design depends on.
                    Ask "which shifts are unfilled", follow the link to see
                    them, and the answer you were reading has been thrown away
                    by the act of acting on it.

                    Worth noting the shape rather than just the fix: the
                    docblock above already promised the thread survives
                    navigation. It was true of the component and false of the
                    markup, and nothing failed — the same claim-outruns-behaviour
                    pattern as a header that says AI over a pile of if
                    statements.
                  */}
                  {exchange.href && (
                    <Link
                      href={exchange.href}
                      onClick={closeIfCovering}
                      className="mt-1.5 inline-block text-xs font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
                    >
                      {exchange.hrefLabel ?? "Open the page"}
                    </Link>
                  )}
                  {/*
                    `fallback`, NOT `certain`.

                    Both are the keyword classifier and they mean opposite
                    things: `certain` is the optimisation working — the
                    question was plain enough that no provider was needed —
                    and `fallback` is Groq and Gemini both being unreachable.
                    Warning on the first would put this notice under every
                    suggested question anybody clicks, and a warning that fires
                    when nothing is wrong is a warning people stop reading.

                    Said out loud when the providers were unreachable.

                    A keyword answer and a model answer look identical, and an
                    assistant that has quietly stopped understanding paraphrase
                    should say so rather than appear to have got stupid. Same
                    reasoning as the task parser reporting `parsedBy`.
                  */}
                  {exchange.classifiedBy === "fallback" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Answered without AI — matched on keywords only
                    </p>
                  )}
                </div>
              </div>
            ))}

            {asking && (
              <p className="text-xs text-muted-foreground">Thinking…</p>
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
