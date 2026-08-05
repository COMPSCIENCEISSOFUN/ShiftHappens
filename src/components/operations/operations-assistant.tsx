"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertBanner } from "@/components/ui/alert-banner";

type AssistantRole = "staff" | "manager" | "company_admin";
type Undo = { kind: "task" | "assignments"; taskIds?: string[]; assignmentIds?: string[] };
type Result = {
  status: "completed" | "needs_review";
  title: string;
  message: string;
  details?: string[];
  checks?: string[];
  actions?: { label: string; href: string }[];
  clarificationOptions?: { label: string; retryText: string }[];
  undo?: Undo;
};
type Message = { id: string; request?: string; result: Result };
type HistoryItem = { id: string; createdAt: string; request: string; title: string; status: string };

const examples: Record<AssistantRole, string[]> = {
  staff: ["What do I need to do today?", "Check my schedule conflicts", "Which certifications are expiring?"],
  manager: ["Resolve coverage gaps", "Schedule my team this week", "I need 2 staff tomorrow morning for prep"],
  company_admin: ["Analyze organization operations", "Check onboarding readiness", "Show staffing risks"],
};
const prompts: Record<AssistantRole, string> = {
  staff: "Ask ShiftHappens about your work, schedule, or certifications",
  manager: "Tell ShiftHappens what your team needs done. It only acts in your authorized departments.",
  company_admin: "Ask ShiftHappens about setup, staffing, or operational risks",
};
const progressSteps = ["Understanding your request", "Checking live workforce data", "Applying rules and permissions", "Preparing your result"];

export function OperationsAssistant({ orgId, role, onCompleted }: { orgId: string; role: AssistantRole; onCompleted?: () => void | Promise<void> }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  async function loadHistory() {
    try {
      const response = await fetch(`/api/organizations/${orgId}/operations/history`);
      const payload = await response.json();
      if (response.ok && Array.isArray(payload)) setHistory(payload);
    } catch {}
  }

  useEffect(() => { void loadHistory(); }, [orgId]);

  useEffect(() => {
    if (!loading) { setProgressIndex(0); return; }
    const interval = window.setInterval(() => setProgressIndex((current) => Math.min(current + 1, progressSteps.length - 1)), 1100);
    return () => window.clearInterval(interval);
  }, [loading]);

  async function run(request = text.trim()) {
    if (!request || loading) return;
    setLoading(true);
    setError(null);
    setText("");
    try {
      const response = await fetch(`/api/organizations/${orgId}/operations/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: request }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "I could not complete that request.");
      setMessages((current) => [...current, { id: crypto.randomUUID(), request, result: payload }]);
      void loadHistory();
      if (payload.status === "completed") await onCompleted?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "I could not complete that request.");
      setText(request);
    } finally {
      setLoading(false);
    }
  }

  async function undo(message: Message) {
    if (!message.result.undo || undoingId) return;
    setUndoingId(message.id);
    setError(null);
    try {
      const response = await fetch(`/api/organizations/${orgId}/operations/undo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ undo: message.result.undo }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Could not undo that action.");
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, result: { ...item.result, title: "Action undone", message: payload.message, undo: undefined } } : item));
      await onCompleted?.();
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : "Could not undo that action.");
    } finally {
      setUndoingId(null);
    }
  }

  return (
    <section aria-label="Ask ShiftHappens" className="scroll-mt-4">
      <Card className="border-indigo-200 bg-indigo-50/40 shadow-none dark:border-indigo-900 dark:bg-indigo-950/20">
        <CardContent className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white"><Sparkles className="h-4 w-4" /></span>
            <div><h3 className="text-sm font-semibold">Ask ShiftHappens</h3><p className="text-xs text-muted-foreground">{prompts[role]}</p></div>
          </div>
          <div className="flex gap-2">
            <Input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void run(); }} placeholder={prompts[role]} aria-label="Ask ShiftHappens" disabled={loading} />
            <Button onClick={() => void run()} disabled={loading || !text.trim()} className="shrink-0">{loading ? "Working..." : "Ask"}</Button>
          </div>
          {!messages.length && !loading && <div className="mt-2 flex flex-wrap gap-2">{examples[role].map((example) => <button key={example} type="button" onClick={() => setText(example)} className="rounded-md border border-indigo-200 bg-background px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950">{example}</button>)}</div>}
          {loading && <div className="mt-3 rounded-md border border-indigo-100 bg-background/70 p-3" aria-live="polite">{progressSteps.map((step, index) => <div key={step} className="flex items-center gap-2 py-0.5 text-xs"><span className={index <= progressIndex ? "text-indigo-600" : "text-muted-foreground"}>{index < progressIndex ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}</span><span className={index <= progressIndex ? "text-foreground" : "text-muted-foreground"}>{step}</span></div>)}</div>}
          {error && <AlertBanner className="mt-3" variant="error" message={error} />}
          {messages.length > 0 && <div className="mt-3 space-y-3">{messages.map((message) => <AssistantReceipt key={message.id} message={message} undoing={undoingId === message.id} onClarify={run} onUndo={() => void undo(message)} />)}</div>}
          {!messages.length && history.length > 0 && <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium text-foreground">Recent operations</summary><div className="mt-2 space-y-2">{history.map((item) => <div key={item.id} className="flex items-start justify-between gap-3 rounded-md border bg-background px-2.5 py-2"><span className="min-w-0 truncate">{item.title}: {item.request}</span><span className="shrink-0">{new Date(item.createdAt).toLocaleDateString()}</span></div>)}</div></details>}
        </CardContent>
      </Card>
    </section>
  );
}

function AssistantReceipt({ message, undoing, onClarify, onUndo }: { message: Message; undoing: boolean; onClarify: (request: string) => Promise<void>; onUndo: () => void }) {
  const { result } = message;
  return <div className="rounded-md border border-border bg-background p-3">
    {message.request && <p className="mb-2 text-xs text-muted-foreground">You: {message.request}</p>}
    <div className="flex items-start gap-2"><CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${result.status === "completed" ? "text-emerald-600" : "text-amber-600"}`} /><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{result.title}</p><p className="mt-1 text-sm text-muted-foreground">{result.message}</p></div></div>
    {result.details && result.details.length > 0 && <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{result.details.slice(0, 5).map((detail) => <li key={detail}>{detail}</li>)}</ul>}
    {result.checks && result.checks.length > 0 && <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium text-foreground">What ShiftHappens checked</summary><ul className="mt-2 space-y-1">{result.checks.map((check) => <li key={check}>{check}</li>)}</ul></details>}
    {result.clarificationOptions && result.clarificationOptions.length > 0 && <div className="mt-3"><p className="text-xs font-medium text-foreground">Choose a department to continue</p><div className="mt-2 flex flex-wrap gap-2">{result.clarificationOptions.map((option) => <Button key={option.label} size="sm" variant="outline" onClick={() => void onClarify(option.retryText)}>{option.label}</Button>)}</div></div>}
    <div className="mt-3 flex flex-wrap items-center gap-3">{result.actions?.map((action) => <Link key={`${action.href}-${action.label}`} href={action.href} className="text-xs font-semibold text-indigo-700 hover:underline dark:text-indigo-300">{action.label}</Link>)}{result.undo && <Button size="sm" variant="outline" onClick={onUndo} disabled={undoing} className="gap-1.5"><RotateCcw className="h-3.5 w-3.5" />{undoing ? "Undoing..." : "Undo this action"}</Button>}</div>
  </div>;
}
