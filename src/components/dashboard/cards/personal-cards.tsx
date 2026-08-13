"use client";

/**
 * The cards that are about YOU.
 *
 * Gated on `canBeRostered` rather than on a permission — self-service data
 * needs no grant, and an admin holds no shifts, so these would render empty for
 * them by construction.
 *
 * ## What changed from the old staff dashboard
 *
 * It had exactly one interactive element on the whole page: a "Review" link,
 * and only when something was pending. The shifts waiting on you were not even
 * named — they appeared as unlabelled amber pills in a week strip. The person
 * who can resolve a pending offer got the least useful rendering of it in the
 * product, while their manager got a proper alert with a name attached.
 */
import { useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  CalendarDays,
  Check,
  ShieldAlert,
  TrendingUp,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import {
  certificationDisplayState,
  daysUntilExpiry,
} from "@/lib/certification-display";
import { DashboardCardShell } from "@/components/dashboard/card-shell";
import type { StaffData } from "@/components/dashboard/dashboard-types";

/* ------------------------------------------------------------------ */
/*  Needs you — offers awaiting your answer                            */
/* ------------------------------------------------------------------ */

/**
 * Every shift you have not answered, named, with Accept on the card.
 *
 * **Accept is here; Decline is not.** Declining requires one of the eight
 * recorded reasons — `rejectTaskSchema` refuses a request without one — and a
 * second reason picker on the dashboard would be a second place for that
 * vocabulary to drift. Accept needs no body, so it lives where the offer is;
 * Decline goes to the screen that owns the reason.
 */
export function PendingOffersCard({
  orgId,
  staff,
  onChanged,
}: {
  orgId: string;
  staff: StaffData;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const pending = staff.weekAssignments.filter(
    (assignment) => assignment.status === "pending"
  );

  // Nothing waiting is not a card. An empty band is the fastest way to say so.
  if (pending.length === 0) return null;

  async function accept(assignmentId: string, title: string) {
    setBusyId(assignmentId);
    try {
      const response = await fetch(`/api/assignments/${assignmentId}/accept`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        toast.error(body?.error || "Could not accept that shift.");
        return;
      }
      toast.success(`Accepted — ${title}`);
      onChanged();
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <DashboardCardShell
      title={`${pending.length} shift${pending.length === 1 ? "" : "s"} waiting on you`}
      tone="warning"
    >
      <ul className="space-y-2">
        {pending.map((assignment) => (
          <li
            key={assignment.id}
            className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{assignment.taskTitle}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {assignment.departmentName ?? "No department"}
                {assignment.scheduledStart && (
                  <>
                    {" · "}
                    {/* No locale argument: spelled the reader's way. */}
                    {new Date(assignment.scheduledStart).toLocaleDateString(
                      undefined,
                      { weekday: "short", day: "numeric", month: "short" }
                    )}
                  </>
                )}
              </p>
            </div>

            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                disabled={busyId === assignment.id}
                onClick={() => accept(assignment.id, assignment.taskTitle)}
              >
                <Check className="mr-1.5 h-4 w-4" />
                Accept
              </Button>
              {/* Declining needs a reason, and the reason lives on My Tasks. */}
              <Link href={`/org/${orgId}/my-tasks`}>
                <Button variant="outline" size="sm">
                  <X className="mr-1.5 h-4 w-4" />
                  Decline
                </Button>
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Needs you — certificates running out                               */
/* ------------------------------------------------------------------ */

/**
 * Only the ones that need doing something about, soonest first.
 *
 * The old page listed every certificate in whatever order the API returned,
 * with a coloured badge and no days remaining — so the one expiring on Friday
 * sat below three that are fine, and there was no link to the page where you
 * would replace it.
 */
export function ExpiringCertsCard({
  orgId,
  staff,
}: {
  orgId: string;
  staff: StaffData;
}) {
  const urgent = staff.certifications
    .map((cert) => ({
      cert,
      state: certificationDisplayState(cert.status, cert.expiryDate),
      days: cert.expiryDate ? daysUntilExpiry(cert.expiryDate) : null,
    }))
    .filter((row) => row.state === "expiring" || row.state === "expired")
    .sort((a, b) => (a.days ?? 0) - (b.days ?? 0));

  if (urgent.length === 0) return null;

  return (
    <DashboardCardShell title="Certificates needing attention" tone="warning">
      <ul className="space-y-2">
        {urgent.map(({ cert, state, days }) => (
          <li
            key={cert.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <ShieldAlert
                className={`h-4 w-4 shrink-0 ${
                  state === "expired" ? "text-destructive" : "text-amber-500"
                }`}
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{cert.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {state === "expired"
                    ? "Expired"
                    : days === 0
                      ? "Expires today"
                      : `Expires in ${days} day${days === 1 ? "" : "s"}`}
                </p>
              </div>
            </div>
            <Link
              href={`/org/${orgId}/my-certifications`}
              className="shrink-0 text-[13px] font-medium text-primary hover:underline"
            >
              Replace
            </Link>
          </li>
        ))}
      </ul>
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  What is happening — your next shift                                */
/* ------------------------------------------------------------------ */

export function NextShiftCard({ staff }: { staff: StaffData }) {
  const shift = staff.nextShift;

  return (
    <DashboardCardShell title="Your next shift">
      {shift ? (
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <CalendarClock className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{shift.taskName}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {new Date(shift.scheduledStart).toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </p>
            <p className="text-sm text-muted-foreground">
              {new Date(shift.scheduledStart).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
              {" – "}
              {new Date(shift.scheduledEnd).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={CalendarDays}
          title="Nothing scheduled ahead"
          description="When you are put on a shift it will appear here."
          className="py-4"
        />
      )}
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  What is happening — the week                                       */
/* ------------------------------------------------------------------ */

/**
 * This week's shifts as a list rather than a strip of inert pills.
 *
 * The old week strip drew seven day cards whose only content was an unlabelled
 * coloured pill — so a pending shift and an accepted one differed by hue, and
 * neither carried a title, a time or a link.
 */
export function MyWeekCard({ staff }: { staff: StaffData }) {
  const scheduled = staff.weekAssignments
    .filter((assignment) => assignment.scheduledStart !== null)
    .sort(
      (a, b) =>
        new Date(a.scheduledStart!).getTime() -
        new Date(b.scheduledStart!).getTime()
    );

  return (
    <DashboardCardShell title="Your week">
      {scheduled.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No shifts this week"
          className="py-4"
        />
      ) : (
        <ul className="divide-y divide-border">
          {scheduled.map((assignment) => (
            <li key={assignment.id} className="flex items-center gap-3 py-2.5">
              <span
                className="h-7 w-1 shrink-0 rounded-sm"
                style={{
                  backgroundColor: assignment.departmentColor ?? "#94A3B8",
                }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {assignment.taskTitle}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(assignment.scheduledStart!).toLocaleDateString(
                    undefined,
                    { weekday: "short", day: "numeric", month: "short" }
                  )}
                </p>
              </div>
              {assignment.status === "pending" && (
                <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  Awaiting your answer
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
/*  How it is going — your numbers                                     */
/* ------------------------------------------------------------------ */

export function MyStatsCard({ staff }: { staff: StaffData }) {
  const { stats } = staff;

  /*
   * A brand-new member has decided nothing and clocked nothing, and the service
   * defaults both rates to 100. "Acceptance 100%" over zero shifts is a number
   * about nothing, so it is withheld until there is something to measure.
   */
  const hasHistory = stats.shiftsThisMonth > 0;

  return (
    <DashboardCardShell title="How you are doing" className="md:col-span-2">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Hours this week"
          value={`${staff.hoursThisWeek.toFixed(1)}h`}
          detail={`of ${staff.weeklyCapacity}h preferred`}
          accentColour={STAT_ACCENT.indigo}
        />
        <StatTile
          label="Shifts this month"
          value={stats.shiftsThisMonth}
          detail={`${stats.hoursThisMonth.toFixed(1)}h worked`}
          accentColour={STAT_ACCENT.blue}
        />
        <StatTile
          label="Accepted"
          value={hasHistory ? `${stats.acceptanceRate}%` : "—"}
          detail={hasHistory ? "of offers" : "no offers yet"}
          accentColour={STAT_ACCENT.green}
        />
        <StatTile
          label="On time"
          value={hasHistory ? `${stats.onTimeRate}%` : "—"}
          detail={hasHistory ? "clock-ins" : "nothing clocked yet"}
          accentColour={STAT_ACCENT.amber}
        />
      </div>
      {!hasHistory && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
          Rates appear once you have worked a shift this month.
        </p>
      )}
    </DashboardCardShell>
  );
}
