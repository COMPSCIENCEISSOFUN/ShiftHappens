/**
 * Auto-Schedule Page (Boundary Layer)
 *
 * Generates an AI draft schedule for a selected week. The admin reviews the
 * proposed assignments, removes any they disagree with, then confirms to create
 * them all in one batch.
 *
 * Workflow: pick a week → generate → review → confirm or discard.
 *
 * ## On the visual language
 *
 * This page predates the Phase 12 overhaul and had kept its own conventions:
 * bespoke `bg-muted/50` summary boxes instead of the house stat tiles, an
 * unstyled table, a bare `rounded-lg border` panel with no section header, and
 * a "← Dashboard" button no other org page has. It now follows the same
 * structure as Departments, Members and Calendar — page header, stat row, card
 * panels with headed sections — so that moving between them does not feel like
 * moving between two applications.
 */
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock,
  Sparkles,
  TriangleAlert,
  UserCheck,
  X,
} from "lucide-react";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import {
  shiftWeeks,
  thisMondayInOrgTime,
  weekRangeLabel,
} from "@/lib/schedule-week";
import { WeekStartNotice } from "@/components/schedule/week-start-notice";
import { Panel } from "@/components/ui/panel";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { usePermissions } from "@/components/layout/permission-provider";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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
  provider?: string;
  assignments: DraftAssignment[];
  unfilledTasks: UnfilledTask[];
  summary: {
    totalTasks: number;
    totalAssignments: number;
    totalUnfilled: number;
    hoursDistribution: { name: string; hours: number }[];
  };
}

/* ------------------------------------------------------------------ */
/*  Shared page furniture                                              */
/* ------------------------------------------------------------------ */




/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function AutoSchedulePage() {
  const { can } = usePermissions();

  const params = useParams();
  const orgId = params.orgId as string;

  const [weekStart, setWeekStart] = useState(thisMondayInOrgTime());
  const [draft, setDraft] = useState<DraftSchedule | null>(null);
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  /**
   * Whether the admin has removed anything from the generated draft.
   *
   * The hours distribution comes from the generator and is keyed by staff name
   * only — there is no per-assignment figure to subtract — so removing a row
   * cannot honestly update it. Rather than quietly showing stale numbers, or
   * inventing a recalculation, the page says so.
   */
  const [edited, setEdited] = useState(false);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    setDraft(null);
    setSuccess(null);
    setEdited(false);

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
        setError(
          "No open tasks found for the selected week that need staffing. Try a different week, or create tasks first."
        );
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
    const assignments = draft.assignments.filter((_, i) => i !== index);
    setDraft({
      ...draft,
      assignments,
      summary: { ...draft.summary, totalAssignments: assignments.length },
    });
    setEdited(true);
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
            assignments: draft.assignments,
            // Echoed so the confirmed rows record which strategy produced them.
            provider: draft.provider,
          }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to confirm schedule");
        return;
      }

      const result = await res.json();

      /*
       * One line per reason, and the reasons do not overlap.
       *
       * This used to report `failed` — everything not written — and then
       * `rejected` as well, which is a subset of it, so a draft with one bad row
       * said "1 could not be created · 1 rejected as out of scope" about the
       * same row. The server now returns the breakdown, and each part is a
       * different thing for the manager to do about it: retry a write error,
       * look at the roster for a composition skip, regenerate a stale draft.
       * Duplicate rows are not reported — a draft naming the same person twice
       * is an artefact of editing, not something to act on.
       */
      const parts = [`${result.created} assignment${result.created === 1 ? "" : "s"} created`];
      if (result.brokeComposition > 0)
        parts.push(
          `${result.brokeComposition} skipped — would break a composition rule`
        );
      if (result.overCapacity > 0)
        parts.push(`${result.overCapacity} skipped — shift already full`);
      if (result.rejected > 0) parts.push(`${result.rejected} rejected as out of scope`);
      if (result.writeErrors > 0)
        parts.push(`${result.writeErrors} could not be created`);

      setSuccess(parts.join(" · "));
      setDraft(null);
      setEdited(false);
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
    setEdited(false);
  }

  const hours = draft?.summary.hoursDistribution ?? [];
  const maxHours = hours.length ? Math.max(...hours.map((h) => h.hours)) : 0;
  const totalHours = hours.reduce((sum, h) => sum + h.hours, 0);

  const reviewing = draft !== null;
  const hasAssignments = (draft?.assignments.length ?? 0) > 0;

  /*
   * The sidebar no longer links here without `allocation:auto_schedule`, but the URL still
   * resolved — and this page had no check of its own, so it rendered its
   * full surface and every action returned 403.
   *
   * Not a security boundary. The routes enforce this independently; this
   * is so the product does not offer what it will refuse.
   */
  if (!can("allocation:auto_schedule")) {
    return (
      <div className="w-full">
        <EmptyState title="Whole-week scheduling is a company admin action" description="You can still assign shifts individually from the Tasks page." />
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
            Auto-Schedule
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Generate a draft week of assignments from availability,
            certifications and work rules — then review before anything is saved
          </p>
        </div>

        {reviewing && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button onClick={handleDiscard} className={SECONDARY_BUTTON}>
              Discard draft
            </button>
            <button
              onClick={handleConfirm}
              disabled={confirming || !hasAssignments}
              className={PRIMARY_BUTTON}
            >
              {confirming
                ? "Confirming…"
                : `Confirm ${draft!.assignments.length} assignment${draft!.assignments.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}
      </div>

      {error && <AlertBanner message={error} variant="error" />}
      {success && <AlertBanner message={success} variant="success" />}

      {/* ── Week picker ── */}
      {!reviewing && (
        <div className="mt-4 max-w-2xl">
          <Panel title="Choose a week" icon={CalendarRange}>
            <div className="space-y-4 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-label="Previous week"
                  onClick={() => setWeekStart(shiftWeeks(weekStart, -1))}
                  disabled={generating}
                  className={SECONDARY_BUTTON}
                >
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                </button>

                <input
                  type="date"
                  aria-label="Week starting"
                  value={weekStart}
                  onChange={(e) => setWeekStart(e.target.value)}
                  disabled={generating}
                  className="h-8 rounded-lg border border-input bg-background px-3 text-sm text-foreground disabled:opacity-60"
                />

                <button
                  type="button"
                  aria-label="Next week"
                  onClick={() => setWeekStart(shiftWeeks(weekStart, 1))}
                  disabled={generating}
                  className={SECONDARY_BUTTON}
                >
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>

                <button
                  type="button"
                  onClick={() => setWeekStart(thisMondayInOrgTime())}
                  disabled={generating}
                  className={SECONDARY_BUTTON}
                >
                  This week
                </button>
              </div>

              <p className="text-[13px] text-muted-foreground">
                {weekRangeLabel(weekStart) || "Pick a date to choose a week"}
              </p>

              <WeekStartNotice
                weekStart={weekStart}
                onUseMonday={setWeekStart}
                disabled={generating}
              />

              <button
                onClick={handleGenerate}
                disabled={generating || !weekRangeLabel(weekStart)}
                className={PRIMARY_BUTTON}
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                {generating ? "Generating…" : "Generate draft"}
              </button>

              {generating && (
                <div className="space-y-2" role="status">
                  <div className="h-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full w-1/3 animate-pulse rounded-full bg-indigo-500" />
                  </div>
                  <p className="text-[13px] text-muted-foreground">
                    Analysing tasks, availability, certifications and work
                    rules…
                  </p>
                </div>
              )}

              <p className="text-[11px] text-muted-foreground">
                Nothing is saved until you confirm the draft.
              </p>
            </div>
          </Panel>
        </div>
      )}

      {/* ── Draft review ── */}
      {reviewing && (
        <div className="space-y-4">
          <p className="text-[13px] text-muted-foreground">
            Draft for {weekRangeLabel(weekStart)} — review and adjust before
            confirming. Nothing is saved until you do.
          </p>

          {/* Stat tiles */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            <StatTile
              label="Tasks"
              value={draft!.summary.totalTasks}
              detail="needed staffing"
              accentColour={STAT_ACCENT.indigo}
            />
            <StatTile
              label="Assignments"
              value={draft!.summary.totalAssignments}
              detail="proposed"
              accentColour={STAT_ACCENT.green}
              valueColour="text-green-600 dark:text-green-400"
            />
            <StatTile
              label="Unfilled"
              value={draft!.summary.totalUnfilled}
              detail="could not be staffed"
              accentColour={STAT_ACCENT.amber}
              valueColour={
                draft!.summary.totalUnfilled > 0
                  ? "text-amber-600 dark:text-amber-400"
                  : ""
              }
            />
            <StatTile
              label="Hours"
              value={`${totalHours}h`}
              detail={edited ? "as generated" : "across the week"}
              accentColour={STAT_ACCENT.blue}
              valueColour="text-blue-600 dark:text-blue-400"
            />
          </div>

          {/* Assignments */}
          <Panel title="Proposed assignments" icon={UserCheck}>
            {hasAssignments ? (
              <>
                {/* Table — from sm up */}
                <table className="hidden w-full text-sm sm:table">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Task
                      </th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Staff
                      </th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Why
                      </th>
                      <th className="w-12 px-4 py-2.5">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft!.assignments.map((a, index) => (
                      <tr
                        key={`${a.taskId}-${a.membershipId}`}
                        className="border-b border-border last:border-b-0 transition-colors hover:bg-muted/30"
                      >
                        <td className="px-4 py-3 text-[13px] font-medium">
                          {a.taskTitle}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:bg-green-900 dark:text-green-300">
                            {a.staffName}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[12px] text-muted-foreground">
                          {a.reasoning}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => handleRemoveAssignment(index)}
                            aria-label={`Remove ${a.staffName} from ${a.taskTitle}`}
                            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Stacked cards — below sm, where a four-column table is
                    unreadable and the Why column is what gets crushed first. */}
                <ul className="divide-y divide-border sm:hidden">
                  {draft!.assignments.map((a, index) => (
                    <li
                      key={`${a.taskId}-${a.membershipId}`}
                      className="flex items-start justify-between gap-3 p-3.5"
                    >
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium">{a.taskTitle}</p>
                        <span className="mt-1 inline-block rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:bg-green-900 dark:text-green-300">
                          {a.staffName}
                        </span>
                        <p className="mt-1.5 text-[12px] text-muted-foreground">
                          {a.reasoning}
                        </p>
                      </div>
                      <button
                        onClick={() => handleRemoveAssignment(index)}
                        aria-label={`Remove ${a.staffName} from ${a.taskTitle}`}
                        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              /* Removing the last row used to blank the page entirely: the
                 review block was gated on `assignments.length > 0` while the
                 week picker was gated on there being no draft, so neither
                 rendered and only a reload recovered. */
              <EmptyState
                title="No assignments left in this draft"
                description="You've removed every proposed assignment. Discard the draft to choose another week, or generate again."
                icon={UserCheck}
                action={
                  <button onClick={handleDiscard} className={SECONDARY_BUTTON}>
                    Discard draft
                  </button>
                }
              />
            )}
          </Panel>

          {/* Unfilled */}
          {draft!.unfilledTasks.length > 0 && (
            <Panel
              title={`${draft!.unfilledTasks.length} task${draft!.unfilledTasks.length === 1 ? "" : "s"} could not be fully staffed`}
              icon={TriangleAlert}
              tone="warning"
            >
              <ul className="divide-y divide-border">
                {draft!.unfilledTasks.map((t) => (
                  <li key={t.taskId} className="px-4 py-2.5">
                    <p className="text-[13px] font-medium">{t.taskTitle}</p>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {t.reason}
                    </p>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {/* Hours distribution */}
          {hours.length > 0 && (
            <Panel title="Hours distribution" icon={Clock}>
              <div className="space-y-2.5 p-4">
                {hours.map((h) => (
                  <div
                    key={h.name}
                    className="grid items-center gap-3"
                    style={{ gridTemplateColumns: "minmax(80px,120px) 1fr 44px" }}
                  >
                    <span className="truncate text-[12px] text-muted-foreground">
                      {h.name}
                    </span>
                    {/* Decorative: the name and the figure either side are
                        already readable text, so announcing the bar as well
                        would only repeat them. */}
                    <div
                      aria-hidden="true"
                      className="h-2 overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-indigo-400"
                        style={{
                          width: `${maxHours > 0 ? (h.hours / maxHours) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <span className="text-right text-[12px] font-medium tabular-nums">
                      {h.hours}h
                    </span>
                  </div>
                ))}

                {edited && (
                  <p className="pt-1 text-[11px] text-muted-foreground">
                    These are the hours as generated. They do not reflect the
                    assignments you have removed.
                  </p>
                )}
              </div>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
