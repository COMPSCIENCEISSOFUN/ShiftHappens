"use client";

/**
 * How it is going — the band you read rather than act on.
 *
 * Everything here uses the shared `StatTile`. The three dashboards this
 * replaces hand-rolled THREE mutually incompatible tile styles between them and
 * used the shared one in none of them, which is most of why the dashboards read
 * as a different product from the rest of the application.
 */
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { CardLoadFailed, DashboardCardShell } from "@/components/dashboard/card-shell";
import type {
  CertificationSummary,
  CompletionDay,
  DeclineReasonItem,
  DepartmentWorkloadItem,
  KeyMetrics,
  StaffUtilizationItem,
  TaskSummary,
} from "@/components/dashboard/dashboard-types";

/* ------------------------------------------------------------------ */
/*  Key metrics                                                        */
/* ------------------------------------------------------------------ */

export function KeyMetricsCard({
  metrics,
}: {
  metrics: KeyMetrics | null | undefined;
}) {
  if (metrics === null) {
    return (
      <DashboardCardShell title="This week" className="md:col-span-2">
        <CardLoadFailed what="the week's numbers" />
      </DashboardCardShell>
    );
  }
  if (!metrics) return null;

  const { completionRate, hoursLogged, assignmentPipeline } = metrics;
  const move = completionRate.current - completionRate.previous;

  return (
    <DashboardCardShell title="This week" className="md:col-span-2">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Completion rate"
          value={`${completionRate.current}%`}
          detail={
            completionRate.trend === "flat"
              ? "level with last week"
              : `${move > 0 ? "up" : "down"} ${Math.abs(move)}% on last week`
          }
          accentColour={STAT_ACCENT.indigo}
        />
        <StatTile
          label="Hours logged"
          value={`${hoursLogged.hours}h`}
          detail={`of ${hoursLogged.capacity}h capacity`}
          accentColour={STAT_ACCENT.blue}
        />
        <StatTile
          label="Awaiting an answer"
          value={assignmentPipeline.pending}
          detail="offers not yet accepted"
          accentColour={STAT_ACCENT.amber}
          valueColour={
            assignmentPipeline.pending > 0
              ? "text-amber-600 dark:text-amber-400"
              : undefined
          }
        />
        {/*
          `completed` is shown rather than dropped. The old stacked bar drew
          accepted, pending and rejected out of a total that INCLUDED completed,
          so the bar under-filled and its legend never reconciled with the
          number printed above it.
        */}
        <StatTile
          label="Worked"
          value={assignmentPipeline.completed}
          detail={`of ${assignmentPipeline.total} assignments`}
          accentColour={STAT_ACCENT.green}
        />
      </div>
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Task summary                                                       */
/* ------------------------------------------------------------------ */

export function TaskSummaryCard({
  summary,
}: {
  summary: TaskSummary | null | undefined;
}) {
  if (summary === null) {
    return (
      <DashboardCardShell title="Shifts" className="md:col-span-2">
        <CardLoadFailed what="the shift counts" />
      </DashboardCardShell>
    );
  }
  if (!summary) return null;

  return (
    <DashboardCardShell title="Shifts" className="md:col-span-2">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile label="Open" value={summary.open} detail="not started" accentColour={STAT_ACCENT.blue} />
        <StatTile label="In progress" value={summary.in_progress} detail="under way" accentColour={STAT_ACCENT.indigo} />
        <StatTile label="Completed" value={summary.completed} detail="finished" accentColour={STAT_ACCENT.green} />
        <StatTile label="Cancelled" value={summary.cancelled} detail="called off" accentColour={STAT_ACCENT.slate} />
      </div>
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Completions, last seven days                                       */
/* ------------------------------------------------------------------ */

/**
 * A null chart renders as a failure, not as seven flat bars.
 *
 * The old version substituted `[0,0,0,0,0,0,0]` when the query failed, which
 * drew a week of zero completions — visually identical to a real quiet week,
 * and sitting next to a completion percentage that was not zero.
 */
export function CompletionChartCard({
  days,
}: {
  days: CompletionDay[] | null | undefined;
}) {
  if (days === null) {
    return (
      <DashboardCardShell title="Completed, last 7 days">
        <CardLoadFailed what="completions" />
      </DashboardCardShell>
    );
  }
  if (!days) return null;

  const total = days.reduce((sum, day) => sum + day.count, 0);
  const peak = Math.max(1, ...days.map((day) => day.count));

  return (
    <DashboardCardShell title={`Completed, last 7 days — ${total}`}>
      {total === 0 ? (
        <EmptyState title="Nothing completed in the last week" className="py-4" />
      ) : (
        <div className="flex h-28 items-end gap-2">
          {days.map((day) => (
            <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {day.count}
              </span>
              <div
                className="w-full rounded-t bg-primary/70"
                style={{ height: `${Math.max(4, (day.count / peak) * 100)}%` }}
                aria-hidden="true"
              />
              <span className="text-[11px] text-muted-foreground">{day.label}</span>
            </div>
          ))}
        </div>
      )}
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Department workload                                                */
/* ------------------------------------------------------------------ */

export function DepartmentWorkloadCard({
  departments,
}: {
  departments: DepartmentWorkloadItem[] | null | undefined;
}) {
  if (departments === null) {
    return (
      <DashboardCardShell title="Workload by department">
        <CardLoadFailed what="department workload" />
      </DashboardCardShell>
    );
  }
  if (!departments) return null;

  const peak = Math.max(1, ...departments.map((d) => d.taskCount));

  return (
    <DashboardCardShell title="Workload by department">
      {departments.length === 0 ? (
        <EmptyState title="No departments yet" className="py-4" />
      ) : (
        <ul className="space-y-2.5">
          {departments.map((dept) => (
            <li key={dept.id} className="flex items-center gap-3">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: dept.color ?? "#94A3B8" }}
                aria-hidden="true"
              />
              <span className="w-24 shrink-0 truncate text-[13px]">{dept.name}</span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${(dept.taskCount / peak) * 100}%`,
                    backgroundColor: dept.color ?? "#94A3B8",
                  }}
                />
              </span>
              <span
                className={`shrink-0 text-xs tabular-nums ${
                  dept.isImbalanced
                    ? "font-semibold text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground"
                }`}
              >
                {dept.taskCount} · {dept.staffCount} staff
              </span>
            </li>
          ))}
        </ul>
      )}
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Staff utilisation                                                  */
/* ------------------------------------------------------------------ */

const UTILISATION_SHOWN = 8;

export function StaffUtilisationCard({
  staff,
}: {
  staff: StaffUtilizationItem[] | null | undefined;
}) {
  if (staff === null) {
    return (
      <DashboardCardShell title="Who is busiest">
        <CardLoadFailed what="utilisation" />
      </DashboardCardShell>
    );
  }
  if (!staff) return null;

  const shown = staff.slice(0, UTILISATION_SHOWN);

  return (
    <DashboardCardShell title="Who is busiest">
      {staff.length === 0 ? (
        <EmptyState title="No staff to measure yet" className="py-4" />
      ) : (
        <>
          <ul className="space-y-2">
            {shown.map((member) => (
              <li key={member.membershipId} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate text-[13px]">{member.name}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className={`block h-full rounded-full ${
                      member.percentage < 50 ? "bg-amber-500" : "bg-primary"
                    }`}
                    style={{ width: `${Math.min(100, member.percentage)}%` }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums">
                  {member.percentage}%
                </span>
              </li>
            ))}
          </ul>
          {/* Named rather than silently cut. */}
          {staff.length > UTILISATION_SHOWN && (
            <p className="mt-2.5 text-xs text-muted-foreground">
              Showing the {UTILISATION_SHOWN} busiest of {staff.length}.
            </p>
          )}
        </>
      )}
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Certifications across the organisation                             */
/* ------------------------------------------------------------------ */

export function CertificationSummaryCard({
  summary,
}: {
  summary: CertificationSummary | null | undefined;
}) {
  if (summary === null) {
    return (
      <DashboardCardShell title="Certificates" className="md:col-span-2">
        <CardLoadFailed what="certificates" />
      </DashboardCardShell>
    );
  }
  if (!summary) return null;

  /*
   * Four tiles that PARTITION.
   *
   * `summary.verified` is a status count and the expiring and expired tiles are
   * drawn from inside it, so showing it here put the same certificate under two
   * headings and captioned the overlap "in good standing". It also disagreed
   * with the certifications page, which derives four exclusive states from
   * `certificationDisplayState` — eleven here, eight there, same organisation.
   * `inGoodStanding` is the service's partitioned figure and matches that page.
   */
  return (
    <DashboardCardShell title="Certificates" className="md:col-span-2">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile label="Verified" value={summary.inGoodStanding} detail="in good standing" accentColour={STAT_ACCENT.green} />
        <StatTile label="Awaiting review" value={summary.pending} detail="submitted" accentColour={STAT_ACCENT.blue} />
        <StatTile
          label="Expiring"
          value={summary.expiringSoon}
          detail="within 30 days"
          accentColour={STAT_ACCENT.amber}
          valueColour={summary.expiringSoon > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
        />
        <StatTile
          label="Expired"
          value={summary.expired}
          detail="no longer valid"
          accentColour={STAT_ACCENT.red}
          valueColour={summary.expired > 0 ? "text-destructive" : undefined}
        />
      </div>
    </DashboardCardShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Why shifts get declined                                            */
/* ------------------------------------------------------------------ */

/**
 * Counted by reason, with nobody named.
 *
 * The service groups the same rows by person as well, and that version was
 * returned to this page for months with nothing rendering it. "Alex declined
 * three times" tells you to have a word with Alex; "seven declines for
 * insufficient notice" tells you to change the notice period.
 */
export function DeclineReasonsCard({
  reasons,
}: {
  reasons: DeclineReasonItem[] | null | undefined;
}) {
  if (reasons === null) {
    return (
      <DashboardCardShell title="Why shifts were declined">
        <CardLoadFailed what="decline reasons" />
      </DashboardCardShell>
    );
  }
  if (!reasons) return null;

  const total = reasons.reduce((sum, row) => sum + row.count, 0);

  return (
    <DashboardCardShell title="Why shifts were declined, last 7 days">
      {total === 0 ? (
        <EmptyState title="Nobody declined a shift this week" className="py-4" />
      ) : (
        <ul className="space-y-2">
          {reasons.map((row) => (
            <li key={row.reason} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate text-[13px] capitalize">
                {row.label}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary/70"
                  style={{ width: `${(row.count / total) * 100}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-xs tabular-nums">
                {row.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </DashboardCardShell>
  );
}
