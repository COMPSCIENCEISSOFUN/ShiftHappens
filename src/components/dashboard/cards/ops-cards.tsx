"use client";

/**
 * The cards about the work rather than about you.
 *
 * Every one of them takes its section as `T | null | undefined` and treats the
 * three differently: `undefined` means the reader was not sent it, `null` means
 * the query THREW, and a value means it worked. The dashboards this replaces
 * collapsed null into empty, which is how a failed alert query came to render a
 * green "All clear — nothing needs your attention".
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CalendarCheck,
  CircleAlert,
  CircleHelp,
  ClipboardList,
  CreditCard,
  Sparkles,
  TriangleAlert,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { StatusBadge } from "@/components/ui/status-badge";
import { CardLoadFailed, DashboardCardShell } from "@/components/dashboard/card-shell";
import {
  LeaveRequestsPanel,
  type LeaveDecision,
  type PendingLeave,
} from "@/components/dashboard/leave-requests-panel";
import type {
  CoverageSummary,
  NeedsAttentionItem,
  TeamMemberItem,
  TomorrowTask,
} from "@/components/dashboard/dashboard-types";

/* ------------------------------------------------------------------ */
/*  Needs you — the alert feed                                         */
/* ------------------------------------------------------------------ */

const SEVERITY = {
  danger: { icon: TriangleAlert, tint: "bg-destructive/10 text-destructive" },
  warning: { icon: CircleAlert, tint: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  info: { icon: ClipboardList, tint: "bg-primary/10 text-primary" },
} as const;

/**
 * Which alert to start with, from `ai-recommendations`.
 *
 * `entityId` is validated server-side against the alerts the model was shown,
 * so its only contribution is WHICH row leads. The route also returns the
 * chosen alert's `message`, and this deliberately ignores it — the row already
 * has our sentence, and rendering the echoed copy would be a second place for
 * the same words to drift.
 */
interface PriorityCall {
  entityId: string;
  /** The model's one-line justification, or null when it offered none. */
  reason: string | null;
}

/**
 * What needs a decision, the engine's pick first and the rest most severe
 * first.
 *
 * Each alert already carries `actionUrl` and `actionLabel` from the service, so
 * every row leads somewhere — the previous versions rendered the label and, in
 * one of the three, forgot the link.
 *
 * `actionPost` rows DO something rather than go somewhere. Only the
 * availability nudge uses it, and it is declared on the alert rather than
 * inferred here so the one row that writes is named where the row is built.
 */

export function AlertsCard({
  orgId,
  alerts,
}: {
  orgId: string;
  alerts: NeedsAttentionItem[] | null | undefined;
}) {
  const [posting, setPosting] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [priority, setPriority] = useState<PriorityCall | null>(null);
  /*
   * Distinct from having no strong opinion, which is also `call: null`. The
   * badge disappeared identically for a rate limit, a timeout, a missing key
   * and "fewer than two alerts" — so a manager who had come to rely on it had
   * no way to know the engine had stopped answering a fortnight ago.
   */
  const [unavailable, setUnavailable] = useState(false);

  /*
   * Its own request, and deliberately not part of the dashboard payload: a
   * model call is slow and the list is complete without it. Failure is silent
   * because the only thing lost is the ORDER hint.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/organizations/${orgId}/dashboard/ai-recommendations`
        );
        if (!response.ok) return;
        const body = await response.json();
        if (cancelled) return;
        setPriority(body?.call ?? null);
        setUnavailable(Boolean(body?.unavailable));
      } catch {
        // The list keeps its own order.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (alerts === null) {
    return (
      <DashboardCardShell title="Needs a decision" tone="warning">
        <CardLoadFailed what="what needs attention" />
      </DashboardCardShell>
    );
  }
  // Genuinely nothing to do. No card, no "0 items" — an empty band says it.
  if (!alerts || alerts.length === 0) return null;

  /*
   * The pick goes first; everything else sorts by severity.
   *
   * Sorting by severity alone left five identical-looking danger rows in
   * whatever order they were computed, and the ordering IS the engine's only
   * output — burying it at position four would discard the thing it was asked
   * for.
   */
  const rank = { danger: 0, warning: 1, info: 2 } as const;
  const ordered = [...alerts].sort((a, b) => {
    if (priority) {
      if (a.entityId === priority.entityId) return -1;
      if (b.entityId === priority.entityId) return 1;
    }
    return (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);
  });

  async function nudge(item: NeedsAttentionItem, key: string) {
    setPosting(key);
    try {
      const response = await fetch(item.actionUrl, { method: "POST" });
      if (!response.ok) {
        toast.error("That did not go through.");
        return;
      }
      toast.success("Asked");
      setDone((current) => new Set(current).add(key));
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setPosting(null);
    }
  }

  return (
    <DashboardCardShell
      title={`${ordered.length} thing${ordered.length === 1 ? "" : "s"} need${ordered.length === 1 ? "s" : ""} a decision`}
      tone={ordered.some((a) => a.severity === "danger") ? "danger" : "warning"}
    >
      {/*
        Two different silences, saying two different things.

        A provider outage falls back to the most SEVERE alert, chosen by rule —
        so a flat "no suggestion" sentence would be denying a pick that is
        visibly highlighted in the first row. Which line shows depends on
        whether a call came back, not on `unavailable` alone.
      */}
      {unavailable && priority && (
        <p className="mb-2.5 text-xs text-muted-foreground">
          The assistant is unavailable, so this is simply the most serious item
          on the list — picked by rule, not by the engine.
        </p>
      )}
      {unavailable && !priority && (
        <p className="mb-2.5 text-xs text-muted-foreground">
          The assistant could not suggest where to start. The list below is
          complete and in its usual order.
        </p>
      )}

      <ul className="space-y-2">
        {ordered.map((item, index) => {
          const key = `${item.type}-${item.entityId ?? index}`;
          const look = SEVERITY[item.severity] ?? {
            icon: CircleHelp,
            tint: "bg-muted text-muted-foreground",
          };
          const Icon = look.icon;
          const picked =
            priority !== null && item.entityId === priority.entityId;

          return (
            <li
              key={key}
              className={`flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between ${
                picked
                  ? "border-primary/40 bg-primary/5"
                  : "border-border bg-background"
              }`}
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    picked ? "bg-primary/15 text-primary" : look.tint
                  }`}
                >
                  {picked ? (
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="min-w-0 text-sm leading-snug">
                    {item.message}
                    {/*
                      Claims only what happened — something picked this one to
                      lead with. Whether that was a model or the fallback rule
                      is stated in the line above the list, because a colour
                      cannot carry that distinction and was never going to.
                    */}
                    {picked && (
                      <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-primary ring-1 ring-primary/30">
                        Start here
                      </span>
                    )}
                  </p>
                  {/*
                    The engine's own sentence, shown only on the row it is
                    about. Null is a normal outcome — see PriorityCall.
                  */}
                  {picked && priority?.reason && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {priority.reason}
                    </p>
                  )}
                </div>
              </div>

              <div className="shrink-0 sm:pl-2">
                {item.actionPost ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={posting === key || done.has(key)}
                    onClick={() => nudge(item, key)}
                  >
                    {done.has(key) ? "Asked" : item.actionLabel}
                  </Button>
                ) : (
                  <Link href={item.actionUrl}>
                    <Button variant="outline" size="sm">
                      {item.actionLabel}
                    </Button>
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Needs you — a subscription in trouble                              */
/* ------------------------------------------------------------------ */

const NEEDS_ATTENTION_STATUS = ["past_due", "unpaid", "incomplete"];

/**
 * A failed payment, on the screen the admin actually opens.
 *
 * `subscriptionStatus` was written by the Stripe webhook for months and read by
 * nothing — an organisation whose card failed kept full access with nobody
 * told. The billing page is its first reader, but only if you go there.
 *
 * Fetched here rather than added to the dashboard payload because it is one
 * request for the few readers who hold `billing:manage`, against a route that
 * already exists and already gates itself.
 */
export function BillingWarningCard({ orgId }: { orgId: string }) {
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/organizations/${orgId}/billing`);
        if (!response.ok) return;
        const body = await response.json();
        if (!cancelled) setStatus(body?.subscriptionStatus ?? null);
      } catch {
        // Silent: this card is an addition to the page, not the page.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (!status || !NEEDS_ATTENTION_STATUS.includes(status)) return null;

  return (
    <DashboardCardShell title="Your subscription needs attention" tone="danger">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2.5">
          <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <p className="text-sm leading-snug">
            The last payment did not go through. Access continues for now, and
            stops if it is not resolved.
          </p>
        </div>
        <Link href={`/org/${orgId}/billing`} className="shrink-0">
          <Button size="sm">Open billing</Button>
        </Link>
      </div>
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  What is happening — coverage                                       */
/* ------------------------------------------------------------------ */

/** The manager's first question, in four numbers. */
export function CoverageCard({
  coverage,
}: {
  coverage: CoverageSummary | null | undefined;
}) {
  if (coverage === null) {
    return (
      <DashboardCardShell title="Coverage" className="md:col-span-2">
        <CardLoadFailed what="coverage" />
      </DashboardCardShell>
    );
  }
  if (!coverage) return null;

  return (
    <DashboardCardShell title="Coverage ahead" className="md:col-span-2">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Slots filled"
          value={`${coverage.coveragePercent}%`}
          detail="of what is required"
          accentColour={STAT_ACCENT.indigo}
        />
        <StatTile
          label="Upcoming"
          value={coverage.upcomingTasks}
          detail="shifts scheduled"
          accentColour={STAT_ACCENT.blue}
        />
        <StatTile
          label="Fully staffed"
          value={coverage.fullyStaffed}
          detail="need nobody else"
          accentColour={STAT_ACCENT.green}
        />
        <StatTile
          label="Short"
          value={coverage.understaffed + coverage.unassigned}
          detail={`${coverage.unassigned} with nobody at all`}
          accentColour={STAT_ACCENT.amber}
          valueColour={
            coverage.understaffed + coverage.unassigned > 0
              ? "text-amber-600 dark:text-amber-400"
              : undefined
          }
        />
      </div>
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  What is happening — tomorrow                                       */
/* ------------------------------------------------------------------ */

export function TomorrowCard({
  orgId,
  tasks,
}: {
  orgId: string;
  tasks: TomorrowTask[] | null | undefined;
}) {
  if (tasks === null) {
    return (
      <DashboardCardShell title="Tomorrow's shifts">
        <CardLoadFailed what="tomorrow's schedule" />
      </DashboardCardShell>
    );
  }
  if (!tasks) return null;

  return (
    <DashboardCardShell
      title="Tomorrow's shifts"
      action={
        <Link
          href={`/org/${orgId}/calendar`}
          className="text-[13px] font-medium text-primary hover:underline"
        >
          Open the calendar
        </Link>
      }
    >
      {tasks.length === 0 ? (
        /*
          States the fact and stops. It used to read "Nothing scheduled —
          tomorrow is clear", which is the organisation's rota written in the
          second person AND the flattering reading of an ambiguous number: zero
          shifts tomorrow means either nothing needs doing or nobody has built
          the rota yet, and this card cannot tell which. The reader who can is
          one click away.
        */
        <EmptyState
          icon={CalendarCheck}
          title="No shifts on the schedule for tomorrow"
          className="py-4"
        />
      ) : (
        <ul className="divide-y divide-border">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-3 py-2.5">
              <span
                className="h-7 w-1 shrink-0 rounded-sm"
                style={{ backgroundColor: task.departmentColor ?? "#94A3B8" }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{task.title}</p>
                {task.timeRange && (
                  <p className="text-xs text-muted-foreground">{task.timeRange}</p>
                )}
              </div>
              {task.isUnderstaffed ? (
                <Link
                  href={`/org/${orgId}/tasks`}
                  className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive hover:underline"
                >
                  needs {task.requiredHeadcount - task.assignedCount} more
                </Link>
              ) : (
                <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  staffed
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  What is happening — my team                                        */
/* ------------------------------------------------------------------ */

export function TeamRosterCard({
  team,
}: {
  team: TeamMemberItem[] | null | undefined;
}) {
  if (team === null) {
    return (
      <DashboardCardShell title="My team">
        <CardLoadFailed what="your team" />
      </DashboardCardShell>
    );
  }
  if (!team) return null;

  const available = team.filter((member) => member.status !== "off_today").length;

  return (
    <DashboardCardShell title={`My team — ${available} of ${team.length} available`}>
      {team.length === 0 ? (
        <EmptyState icon={Users} title="Nobody in your departments yet" className="py-4" />
      ) : (
        <ul className="divide-y divide-border">
          {team.map((member) => (
            <li
              key={member.membershipId}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <span className="truncate text-sm">{member.name}</span>
              <StatusBadge
                value={member.status}
                palette="teamStatus"
                label={member.statusLabel}
              />
            </li>
          ))}
        </ul>
      )}
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Needs you — leave awaiting a decision                              */
/* ------------------------------------------------------------------ */

/**
 * Its own fetch, because leave is not part of the dashboard payload.
 *
 * ## Why the panel and not a list
 *
 * `LeaveRequestsPanel` already carries the decision — approve, reject, dismiss
 * a lapsed one — along with the double-click guard and the live-before-lapsed
 * ordering. A read-only list here would have moved the manager's leave queue
 * one click further away than the dashboard it replaces, which is a downgrade
 * dressed as a redesign.
 *
 * ## The failure is surfaced rather than swallowed
 *
 * Both dashboards this replaces caught the error and set an empty array, so a
 * broken leave query and a quiet week looked identical — and the quiet week is
 * the one a manager stops checking.
 */
export function LeaveQueueCard({ orgId }: { orgId: string }) {
  const [rows, setRows] = useState<PendingLeave[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/organizations/${orgId}/leave?view=pending`);
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const body = await response.json();
      setFailed(false);
      // `view=pending` is everything undecided — live AND lapsed. A manager who
      // never opens the leave page still needs to see that something went
      // unanswered; the page itself defaults to the live ones because it has a
      // Lapsed filter beside them.
      setRows(Array.isArray(body?.rows) ? body.rows : []);
    } catch {
      setFailed(true);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, decision: LeaveDecision) {
    const response = await fetch(`/api/organizations/${orgId}/leave/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    /*
     * Refetched rather than spliced out locally: approving changes who is
     * eligible for the shifts this manager may be looking at, and a list that
     * disagrees with the server about what was decided is worse than a round
     * trip.
     */
    if (response.ok) await load();
  }

  if (failed) {
    return (
      <DashboardCardShell title="Leave requests" tone="warning">
        <CardLoadFailed what="leave requests" />
      </DashboardCardShell>
    );
  }
  // Nothing awaiting a decision is not a card. The panel says the same of an
  // empty list, and this saves rendering a frame around nothing.
  if (!rows || rows.length === 0) return null;

  return (
    <DashboardCardShell tone="warning">
      <LeaveRequestsPanel requests={rows} onDecide={decide} />
    </DashboardCardShell>
  );
}
