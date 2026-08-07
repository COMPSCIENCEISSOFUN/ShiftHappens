/**
 * Auto-Schedule Page (Boundary Layer)
 *
 * Generates an AI-powered draft schedule for a selected week.
 * Admin reviews assignments, can remove individual entries,
 * then confirms to create all assignments in batch.
 *
 * Workflow: Select week → Generate → Review → Confirm/Discard
 */
"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AlertBanner } from "@/components/ui/alert-banner";

interface DraftAssignment {
  taskId: string;
  taskTitle: string;
  membershipId: string;
  staffName: string;
  reasoning: string;
}

interface UnfilledTask {
  taskId: string;
  taskTitle: string;
  reason: string;
}

interface DraftSchedule {
  assignments: DraftAssignment[];
  unfilledTasks: UnfilledTask[];
  summary: {
    totalTasks: number;
    totalAssignments: number;
    totalUnfilled: number;
    hoursDistribution: { name: string; hours: number }[];
  };
}

function getThisMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split("T")[0];
}

function formatWeekRange(dateStr: string): string {
  const start = new Date(dateStr);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} — ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

export default function AutoSchedulePage() {
  const params = useParams();
  const router = useRouter();
  const orgId = params.orgId as string;

  const [weekStart, setWeekStart] = useState(getThisMonday());
  const [draft, setDraft] = useState<DraftSchedule | null>(null);
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    setDraft(null);
    setSuccess(null);

    try {
      const res = await fetch(`/api/organizations/${orgId}/auto-schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekStart: new Date(weekStart).toISOString() }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to generate schedule");
        return;
      }

      const data: DraftSchedule = await res.json();

      if (data.assignments.length === 0 && data.unfilledTasks.length === 0) {
        setError("No open tasks found for the selected week that need staffing. Try a different week or create tasks first.");
        return;
      }

      setDraft(data);
    } catch {
      setError("Something went wrong");
    } finally {
      setGenerating(false);
    }
  }

  function handleRemoveAssignment(index: number) {
    if (!draft) return;
    const updated = { ...draft };
    updated.assignments = updated.assignments.filter((_, i) => i !== index);
    updated.summary = {
      ...updated.summary,
      totalAssignments: updated.assignments.length,
    };
    setDraft(updated);
  }

  async function handleConfirm() {
    if (!draft || draft.assignments.length === 0) return;
    setConfirming(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/auto-schedule/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignments: draft.assignments.map(
              ({ taskId, membershipId }) => ({ taskId, membershipId })
            ),
          }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to confirm schedule");
        return;
      }

      const result = await res.json();
      setSuccess(
        `Schedule confirmed: ${result.created} assignments created${result.failed > 0 ? `, ${result.failed} failed` : ""}`
      );
      setDraft(null);
    } catch {
      setError("Something went wrong");
    } finally {
      setConfirming(false);
    }
  }

  function handleDiscard() {
    setDraft(null);
    setError(null);
    setSuccess(null);
  }

  const maxHours = draft?.summary.hoursDistribution.length
    ? Math.max(...draft.summary.hoursDistribution.map((h) => h.hours))
    : 0;

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">Schedule review</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Smart auto-schedule</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Generate a draft, inspect the decisions, then publish only when the coverage looks right.
          </p>
        </div>
        <Button variant="outline" onClick={() => router.push("/dashboard")}>
          ← Dashboard
        </Button>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {success && <AlertBanner message={success} variant="success" />}

      {/* Week selector + generate — always visible when no draft */}
      {!draft && (
        <div className="space-y-4 rounded-lg border border-primary/20 bg-card p-5 shadow-sm sm:p-6">
          <div className="space-y-2">
            <label className="text-sm font-medium">Week starting</label>
            <div className="flex items-center gap-3">
              <input
                type="date"
                value={weekStart}
                onChange={(e) => setWeekStart(e.target.value)}
                className="rounded-md border px-3 py-2 text-sm bg-background text-foreground"
                disabled={generating}
              />
              <span className="text-sm text-muted-foreground">
                {formatWeekRange(weekStart)}
              </span>
            </div>
          </div>
          <Button onClick={handleGenerate} disabled={generating}>
            {generating ? "Building draft..." : "Generate schedule draft"}
          </Button>
          {generating && (
            <p className="text-sm text-muted-foreground">
              Analyzing tasks, availability, certifications, and work rules...
            </p>
          )}
        </div>
      )}

      {/* Draft review */}
      {draft && draft.assignments.length > 0 && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Draft for {formatWeekRange(weekStart)} — review and adjust before confirming
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleDiscard}>
                Discard
              </Button>
              <Button onClick={handleConfirm} disabled={confirming}>
                {confirming
                  ? "Confirming..."
                  : `Confirm schedule (${draft.assignments.length})`}
              </Button>
            </div>
          </div>

          {/* Summary metrics */}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">Tasks to fill</p>
              <p className="text-xl font-medium">{draft.summary.totalTasks}</p>
            </div>
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">Assignments</p>
              <p className="text-xl font-medium">{draft.summary.totalAssignments}</p>
            </div>
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">Unfilled</p>
              <p className={`text-xl font-medium ${draft.summary.totalUnfilled > 0 ? "text-amber-600" : ""}`}>
                {draft.summary.totalUnfilled}
              </p>
            </div>
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">Total hours</p>
              <p className="text-xl font-medium">
                {draft.summary.hoursDistribution.reduce((sum, h) => sum + h.hours, 0)}h
              </p>
            </div>
          </div>

          {/* Assignment table */}
          <div className="mb-4 overflow-x-auto rounded-lg border bg-card shadow-sm">
            <table className="min-w-[700px] w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left font-medium px-4 py-3 text-muted-foreground">Task</th>
                  <th className="text-left font-medium px-4 py-3 text-muted-foreground">Staff</th>
                  <th className="text-left font-medium px-4 py-3 text-muted-foreground">Reasoning</th>
                  <th className="w-16 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {draft.assignments.map((a, index) => (
                  <tr key={`${a.taskId}-${a.membershipId}`} className="border-b last:border-b-0 hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium">{a.taskTitle}</td>
                    <td className="px-4 py-3">
                      <span className="inline-block rounded-full bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 px-2 py-0.5 text-xs">
                        {a.staffName}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{a.reasoning}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => handleRemoveAssignment(index)} className="text-xs font-medium text-red-600 hover:underline dark:text-red-400">
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Unfilled tasks */}
          {draft.unfilledTasks.length > 0 && (
            <div className="rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 p-4 mb-4">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">
                {draft.unfilledTasks.length} task{draft.unfilledTasks.length > 1 ? "s" : ""} could not be fully staffed
              </p>
              {draft.unfilledTasks.map((t) => (
                <p key={t.taskId} className="text-xs text-amber-700 dark:text-amber-300">
                  {t.taskTitle} — {t.reason}
                </p>
              ))}
            </div>
          )}

          {/* Hours distribution */}
          {draft.summary.hoursDistribution.length > 0 && (
            <div className="rounded-lg border p-4 mb-4">
              <p className="text-sm font-medium mb-3">Hours distribution</p>
              <div className="space-y-2">
                {draft.summary.hoursDistribution.map((h) => (
                  <div key={h.name} className="grid items-center gap-3" style={{ gridTemplateColumns: "100px 1fr 40px" }}>
                    <span className="text-xs text-muted-foreground truncate">{h.name}</span>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-blue-500" style={{ width: `${maxHours > 0 ? (h.hours / maxHours) * 100 : 0}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground text-right">{h.hours}h</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
