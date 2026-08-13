/**
 * Platform Admin — Landing Page FAQ (Boundary Layer)
 *
 * The questions and answers shown on the public site. Platform admins only.
 *
 * ## Writing and publishing are separate
 *
 * An entry is created unpublished, and publishing is a deliberate second act.
 * The alternative — live on save — means a half-finished answer reaches the
 * public page by being interrupted, which is the one failure a marketing page
 * cannot afford.
 *
 * ## Order is a number, not a drag
 *
 * Drag-and-drop needs a pointer, and this list is short. A position field is
 * one tap on a phone, survives a reload, and says exactly what it does.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Eye,
  EyeOff,
  HelpCircle,
  MessageCircleQuestion,
  PenLine,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertBanner } from "@/components/ui/alert-banner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { apiErrorMessage } from "@/lib/api-error";

interface AskedQuestion {
  id: string;
  body: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  handledAt: string | null;
  organization: { id: string; name: string } | null;
}

interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  position: number;
  published: boolean;
}

export default function PlatformFaqPage() {
  const [entries, setEntries] = useState<FaqEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FaqEntry | null>(null);
  const [newQuestion, setNewQuestion] = useState("");
  const [newAnswer, setNewAnswer] = useState("");
  const [creating, setCreating] = useState(false);
  const [asked, setAsked] = useState<AskedQuestion[]>([]);
  const [askedTotal, setAskedTotal] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/platform/faq");
      if (!response.ok) {
        setError("Could not load the FAQ. Refresh to try again.");
        setEntries(null);
        return;
      }
      setError(null);
      setEntries(await response.json());

      /*
       * Loaded alongside the entries, not on its own screen.
       *
       * The two belong together: what people asked is the reason to write an
       * entry, and a list of questions on a separate page is one nobody
       * opens while they are in the middle of writing.
       */
      const askedResponse = await fetch("/api/platform/questions");
      if (askedResponse.ok) {
        const body = await askedResponse.json();
        setAsked(body.rows ?? []);
        setAskedTotal(body.total ?? 0);
      }
    } catch {
      setError("Could not reach the server.");
      setEntries(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: loads this page's rows on mount
    void load();
  }, [load]);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    try {
      const response = await fetch("/api/platform/faq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: newQuestion, answer: newAnswer }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(apiErrorMessage(result, "Could not create that entry."));
        return;
      }
      toast.success("Draft saved. Publish it when you are happy with it.");
      setNewQuestion("");
      setNewAnswer("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function patch(entry: FaqEntry, changes: Partial<FaqEntry>) {
    setSavingId(entry.id);
    try {
      const response = await fetch(`/api/platform/faq/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(apiErrorMessage(result, "Could not save that."));
        return;
      }
      toast.success(
        changes.published === undefined
          ? "Saved"
          : changes.published
            ? "Published to the landing page"
            : "Hidden from the landing page"
      );
      await load();
    } finally {
      setSavingId(null);
    }
  }

  async function setHandled(question: AskedQuestion, handled: boolean) {
    const response = await fetch(`/api/platform/questions/${question.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handled }),
    });
    if (!response.ok) {
      toast.error("Could not update that question.");
      return;
    }
    await load();
  }

  /* Carries the question into the form above; the answer is still yours. */
  function answerThis(question: AskedQuestion) {
    setNewQuestion(question.body.slice(0, 200));
    setNewAnswer("");
    document
      .getElementById("new-question")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById("new-answer")?.focus();
  }

  async function remove(entry: FaqEntry) {
    setPendingDelete(null);
    const response = await fetch(`/api/platform/faq/${entry.id}`, { method: "DELETE" });
    if (!response.ok) {
      toast.error("Could not delete that entry.");
      return;
    }
    toast.success("Deleted");
    await load();
  }

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
          Landing page FAQ
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Published entries appear on the public site, in position order
        </p>
      </div>

      {error && <AlertBanner className="mb-4" variant="error" message={error} />}

      {/* ── What people actually asked ── */}
      {asked.length > 0 && (
        <section className="mb-4 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex items-center gap-2">
            <MessageCircleQuestion className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">
              Asked, not yet answered
            </h3>
            <span className="text-xs text-muted-foreground">
              {askedTotal} waiting
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Sent from the landing page. Nothing here is published — answering
            one writes an entry in your words.
          </p>

          <ul className="mt-3 space-y-2">
            {asked.map((question) => (
              <li
                key={question.id}
                className="rounded-lg border border-border bg-background p-3"
              >
                <p className="whitespace-pre-wrap break-words text-sm">
                  {question.body}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span>{question.name ?? "Anonymous"}</span>
                  {question.organization && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{question.organization.name}</span>
                    </>
                  )}
                  {question.email && (
                    <>
                      <span aria-hidden="true">·</span>
                      <a
                        href={`mailto:${question.email}`}
                        className="underline hover:text-foreground"
                      >
                        {question.email}
                      </a>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  {/* No locale argument: spelled the reader's way. */}
                  <span>{new Date(question.createdAt).toLocaleDateString()}</span>
                </div>

                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button size="sm" onClick={() => answerThis(question)}>
                    <PenLine className="mr-2 h-4 w-4" />
                    Answer this
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setHandled(question, true)}
                  >
                    <Check className="mr-2 h-4 w-4" />
                    Dealt with
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form
        onSubmit={create}
        className="mb-4 space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5"
      >
        <div className="space-y-2">
          <Label htmlFor="new-question">New question</Label>
          <Input
            id="new-question"
            value={newQuestion}
            onChange={(event) => setNewQuestion(event.target.value)}
            placeholder="Can I change plans later?"
            maxLength={200}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-answer">Answer</Label>
          <textarea
            id="new-answer"
            value={newAnswer}
            onChange={(event) => setNewAnswer(event.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="Yes — upgrades take effect immediately and…"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <Button
          type="submit"
          className="w-full sm:w-auto"
          disabled={creating || !newQuestion.trim() || !newAnswer.trim()}
        >
          <Plus className="mr-2 h-4 w-4" />
          {creating ? "Saving…" : "Add as draft"}
        </Button>
      </form>

      {loading ? (
        <PageLoading label="Loading entries…" />
      ) : !entries || entries.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={HelpCircle}
          title="No entries yet"
          description="Add one above. Nothing reaches the landing page until you publish it."
        />
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => (
            <FaqRow
              key={entry.id}
              entry={entry}
              saving={savingId === entry.id}
              onSave={(changes) => patch(entry, changes)}
              onDelete={() => setPendingDelete(entry)}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this entry?"
        description={
          pendingDelete
            ? `"${pendingDelete.question}" will be removed. If it is published, it disappears from the landing page immediately.`
            : ""
        }
        confirmLabel="Delete"
        variant="destructive"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove(pendingDelete)}
      />
    </div>
  );
}

function FaqRow({
  entry,
  saving,
  onSave,
  onDelete,
}: {
  entry: FaqEntry;
  saving: boolean;
  onSave: (changes: Partial<FaqEntry>) => void;
  onDelete: () => void;
}) {
  const [question, setQuestion] = useState(entry.question);
  const [answer, setAnswer] = useState(entry.answer);
  const [position, setPosition] = useState(String(entry.position));

  const dirty =
    question !== entry.question ||
    answer !== entry.answer ||
    position !== String(entry.position);

  return (
    <li className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            entry.published
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {entry.published ? "Live" : "Draft"}
        </span>
        <span className="text-xs text-muted-foreground">Position</span>
        <Input
          value={position}
          onChange={(event) => setPosition(event.target.value)}
          inputMode="numeric"
          className="h-8 w-16"
          aria-label="Position on the landing page"
        />
      </div>

      <div className="mt-3 space-y-3">
        <Input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={200}
          aria-label="Question"
        />
        <textarea
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          rows={4}
          maxLength={2000}
          aria-label="Answer"
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {/* Stacks on a phone; the destructive action sits apart from the rest. */}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button
          variant="ghost"
          size="sm"
          className="justify-start text-destructive hover:text-destructive sm:justify-center"
          onClick={onDelete}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => onSave({ published: !entry.published })}
          >
            {entry.published ? (
              <>
                <EyeOff className="mr-2 h-4 w-4" />
                Unpublish
              </>
            ) : (
              <>
                <Eye className="mr-2 h-4 w-4" />
                Publish
              </>
            )}
          </Button>
          <Button
            size="sm"
            disabled={saving || !dirty}
            onClick={() => {
              const parsed = Number(position);
              if (!Number.isInteger(parsed) || parsed < 0) {
                toast.error("Position must be a whole number of zero or more.");
                return;
              }
              onSave({ question, answer, position: parsed });
            }}
          >
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </li>
  );
}
