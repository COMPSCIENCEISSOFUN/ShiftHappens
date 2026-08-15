"use client";

/**
 * One dashboard, assembled from the registry.
 *
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { AlertBanner } from "@/components/ui/alert-banner";
import { ExportReportButton } from "@/components/dashboard/export-report-button";
import {
  BAND_LABEL,
  bandGroups,
  cardsInBand,
  type CardSubject,
  type DashboardBand,
  type DashboardReader,
} from "@/lib/dashboard-cards";
import type { DashboardResponse } from "@/components/dashboard/dashboard-types";
import {
  ExpiringCertsCard,
  MyStatsCard,
  MyWeekCard,
  NextShiftCard,
  PendingOffersCard,
} from "@/components/dashboard/cards/personal-cards";
import {
  AlertsCard,
  BillingWarningCard,
  CoverageCard,
  LeaveQueueCard,
  TeamRosterCard,
  TomorrowCard,
} from "@/components/dashboard/cards/ops-cards";
import {
  CertificationSummaryCard,
  CompletionChartCard,
  DeclineReasonsCard,
  DepartmentWorkloadCard,
  KeyMetricsCard,
  StaffUtilisationCard,
  TaskSummaryCard,
} from "@/components/dashboard/cards/trend-cards";
import { EngineCard } from "@/components/dashboard/cards/engine-card";
import { usePlan } from "@/components/layout/plan-provider";

/**
 * What the page hands down.
 *
 * `permissions` is an array and not the `Set` the registry wants, because this
 * crosses the server/client boundary and a `Set` does not survive
 * serialisation. Converted once, below.
 */
export interface DashboardProps {
  orgId: string;
  orgName: string;
  userName: string;
  permissions: string[];
  departmentScope: string[] | null;
  rosterable: boolean;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/**
 * Deliberately shapeless.
 *
 * A skeleton drawn to match a particular dashboard is a promise about what is
 * coming, and which cards this reader gets is not known until the response
 * arrives. Three neutral blocks say "loading" without saying what.
 */
/**
 * The two halves of the dashboard, and which bands fall in each.
 *
 * ## Why the page is split at all
 *
 * Stacked, the three bands are about a dozen regions at equal visual weight, so
 * the eye has nowhere to land and every visit costs a full read. The split is
 * by CADENCE rather than by subject: everything you check to answer "is today
 * covered" sits in one place, and everything you look at weekly sits in the
 * other. `needs` and `now` answer the first question; `trend` is the second by
 * its own definition — "how it is going".
 *
 * ## Why this is not two routes
 *
 * The dashboard is the page everyone opens. A second route only gets visited by
 * people who already know it exists, and the trends half is precisely the half
 * nobody would go looking for.
 */
const TAB_BANDS = {
  today: ["needs", "now"],
  trends: ["trend"],
} as const satisfies Record<string, readonly DashboardBand[]>;

type DashboardTab = keyof typeof TAB_BANDS;

const TAB_LABEL: Record<DashboardTab, string> = {
  today: "Today",
  trends: "Trends",
};

function DashboardSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="h-8 w-64 animate-pulse rounded-lg bg-muted" />
      <div className="h-28 animate-pulse rounded-xl bg-muted/60" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-44 animate-pulse rounded-xl bg-muted/60" />
        <div className="h-44 animate-pulse rounded-xl bg-muted/60" />
      </div>
    </div>
  );
}

export function Dashboard({
  orgId,
  orgName,
  userName,
  permissions,
  departmentScope,
  rosterable,
}: DashboardProps) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  /*
   * Which half is on screen, held in the URL rather than in state.
   *
   * So it can be linked and bookmarked — "look at the trends" is a thing one
   * colleague says to another, and it should be a URL. `replace` rather than
   * `push`: switching tabs is not navigation, and pushing would make the back
   * button walk through every toggle before leaving the page.
   *
   * Anything other than `trends` reads as `today`, so a mistyped or stale
   * parameter opens on the half that answers the urgent question.
   */
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab: DashboardTab =
    searchParams.get("view") === "trends" ? "trends" : "today";

  function selectTab(tab: DashboardTab) {
    const next = new URLSearchParams(searchParams.toString());
    if (tab === "today") next.delete("view");
    else next.set("view", tab);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  /*
   * The plan, so a card the subscription excludes is never laid out at all.
   *
   * `planHas` comes from context and is stable across renders, but it is
   * listed as a dependency anyway rather than omitted with a comment: a memo
   * that quietly depends on something it does not declare is the kind of
   * correctness that stops being true when the provider changes.
   */
  const { has: planHas } = usePlan();

  const reader: DashboardReader = useMemo(
    () => ({
      permissions: new Set(permissions),
      departmentScope,
      rosterable,
      hasFeature: planHas,
    }),
    [permissions, departmentScope, rosterable, planHas]
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/organizations/${orgId}/dashboard`);
      if (!response.ok) {
        setFailed(true);
        return;
      }
      setData(await response.json());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: loads the dashboard sections on mount
    void load();
  }, [load]);

  /**
   * One card, by id.
   *
   * A `switch` rather than a lookup table of components, because the cards do
   * not share a props shape — each takes the section it is about, and forcing
   * them behind one signature would mean passing every card the whole response
   * and letting it dig. The registry decides IF a card renders; this decides
   * only what it is handed.
   */
  function render(id: string) {
    const staff = data?.staffData;

    switch (id) {
      // ── Needs you ───────────────────────────────────────────────
      case "billing-warning":
        return <BillingWarningCard key={id} orgId={orgId} />;
      case "pending-offers":
        return staff ? (
          <PendingOffersCard key={id} orgId={orgId} staff={staff} onChanged={load} />
        ) : null;
      case "expiring-certs":
        return staff ? (
          <ExpiringCertsCard key={id} orgId={orgId} staff={staff} />
        ) : null;
      case "alerts":
        return <AlertsCard key={id} orgId={orgId} alerts={data?.needsAttention} />;
      case "leave-queue":
        return <LeaveQueueCard key={id} orgId={orgId} />;

      // ── What is happening ───────────────────────────────────────
      case "next-shift":
        return staff ? <NextShiftCard key={id} staff={staff} /> : null;
      case "my-week":
        return staff ? <MyWeekCard key={id} staff={staff} /> : null;
      case "coverage":
        return <CoverageCard key={id} coverage={data?.coverageSummary} />;
      case "tomorrow":
        return (
          <TomorrowCard key={id} orgId={orgId} tasks={data?.tomorrowsSchedule} />
        );
      case "team-roster":
        return <TeamRosterCard key={id} team={data?.teamRoster} />;

      // ── How it is going ─────────────────────────────────────────
      case "key-metrics":
        return <KeyMetricsCard key={id} metrics={data?.keyMetrics} />;
      case "task-summary":
        return <TaskSummaryCard key={id} summary={data?.taskSummary} />;
      case "completion-chart":
        return <CompletionChartCard key={id} days={data?.completionChart} />;
      case "department-workload":
        return (
          <DepartmentWorkloadCard key={id} departments={data?.departmentWorkload} />
        );
      case "staff-utilisation":
        return <StaffUtilisationCard key={id} staff={data?.staffUtilization} />;
      case "certification-summary":
        return (
          <CertificationSummaryCard key={id} summary={data?.certificationSummary} />
        );
      case "decline-reasons":
        return <DeclineReasonsCard key={id} reasons={data?.declineReasons} />;
      case "engine":
        return <EngineCard key={id} orgId={orgId} />;
      case "my-stats":
        return staff ? <MyStatsCard key={id} staff={staff} /> : null;

      /*
       * A card was added to the registry and not to this switch. Loud in
       * development and silent in production: a missing card is a gap, not a
       * reason to blank the page somebody is trying to work from.
       */
      default:
        if (process.env.NODE_ENV !== "production") {
          console.error(`[Dashboard] no renderer for card "${id}"`);
        }
        return null;
    }
  }

  /**
   * What the heading over a group of cards says.
   *
   * The organisation's name only for an UNRESTRICTED reader. A scoped manager's
   * org cards are narrowed to their departments by the endpoint, so putting the
   * company name over them would claim a reach they do not have — the same
   * class of overstatement as the card this grouping was added to fix.
   */
  function subjectLabel(subject: CardSubject): string {
    if (subject === "self") return "Yours";
    return departmentScope === null ? orgName : "Your departments";
  }

  /**
   * Whether the split is worth making for this reader.
   *
   * Asked of the registry rather than assumed: a reader who cannot see any
   * trend card would otherwise get a Trends tab that opens onto nothing, which
   * is worse than no tab — it looks like the page failed to load.
   *
   * ## Why the trend half must contain something about the ORGANISATION
   *
   * A count alone was not enough. `my-stats` carries `permission: null` and
   * `rosterable: true`, so every staff member qualifies for it — which made the
   * check pass for them and produced a Trends tab holding exactly one card,
   * about themselves. That is not a second view of the dashboard, it is one
   * personal card behind a label that promises analytics, and it made a staff
   * member's home page look like a manager's without being one.
   *
   * The tabs exist to separate "what needs doing now" from "how the
   * organisation is doing". A reader with no org-level trend card has no second
   * subject to separate, so there is nothing to split.
   */
  const trendCards = cardsInBand(reader, "trend");
  const hasOrgTrends = trendCards.some((card) => card.subject === "org");
  const tabsWorthShowing =
    hasOrgTrends &&
    TAB_BANDS.today.some((name) => cardsInBand(reader, name).length > 0);

  /*
   * With no tabs, the trend band is rendered inline rather than dropped —
   * otherwise hiding the tab would take `my-stats` away from the very people it
   * was written for.
   */
  const visibleBands: readonly DashboardBand[] = tabsWorthShowing
    ? TAB_BANDS[activeTab]
    : [...TAB_BANDS.today, ...TAB_BANDS.trends];

  function band(name: DashboardBand) {
    /*
     * The `needs` band is a stack, not a grid, and carries no headings of any
     * kind. Every row in it is a decision somebody has to make; decisions are
     * read down a list, and side by side they compete rather than queue.
     */
    if (name === "needs") {
      const cards = cardsInBand(reader, name);
      if (cards.length === 0) return null;
      return (
        <section key={name} className="space-y-4">
          {cards.map((card) => render(card.id))}
        </section>
      );
    }

    const groups = bandGroups(reader, name);
    if (groups.length === 0) return null;

    return (
      <section key={name} className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {BAND_LABEL[name]}
        </h2>
        {groups.map((group) => (
          <div key={group.subject} className="space-y-2.5">
            {/*
              Rendered even when the reader has only one group. A heading that
              appears for a manager and vanishes for an admin would make the
              admin's cards the unlabelled default — which is exactly how "whose
              data is this" became unanswerable in the first place.
            */}
            <h3 className="text-[13px] font-medium text-muted-foreground/80">
              {subjectLabel(group.subject)}
            </h3>
            {/*
              No `items-start`. Two cards sharing a row stretch to the taller
              of them, so their bottom edges line up instead of leaving one
              short card floating against a ragged gap. The shell fills the
              cell; its contents still sit at the top.
            */}
            <div className="grid gap-4 md:grid-cols-2">
              {group.cards.map((card) => render(card.id))}
            </div>
          </div>
        ))}
      </section>
    );
  }

  if (loading) return <DashboardSkeleton />;

  if (failed) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">{orgName}</h1>
        <AlertBanner
          variant="error"
          message={
            <span className="flex flex-wrap items-center gap-2">
              Could not load the dashboard.
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  void load();
                }}
                className="font-medium underline underline-offset-2"
              >
                Try again
              </button>
            </span>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {greeting()}
            {userName ? `, ${userName}` : ""}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{orgName}</p>
        </div>
        {/*
          Renders nothing without `reports:export` AND a plan carrying
          `pdf_export`, both answered from the shell's providers — so it costs
          no request and needs no gate here.
        */}
        <ExportReportButton orgId={orgId} />
      </header>

      {/*
        Only shown when there is somewhere to go.

        A reader whose cards all fall in one half — a plain staff member with no
        trend cards, say — gets no tabs at all rather than a tab that opens onto
        an empty page. The registry already decides who qualifies for what, so
        this asks it rather than assuming.
      */}
      {tabsWorthShowing && (
        <div
          role="tablist"
          aria-label="Dashboard view"
          className="flex items-center gap-2"
        >
          {(Object.keys(TAB_BANDS) as DashboardTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => selectTab(tab)}
              className={`inline-flex shrink-0 items-center rounded-full border px-3.5 py-1.5 text-sm font-medium transition-all ${
                activeTab === tab
                  ? "border-indigo-600 bg-indigo-600 text-white shadow-sm"
                  : "border-border bg-card text-muted-foreground hover:border-indigo-400 hover:text-foreground"
              }`}
            >
              {TAB_LABEL[tab]}
            </button>
          ))}
        </div>
      )}

      {/*
        Only the active half is rendered, which is what makes this worth doing
        rather than a scroll break.

        Three cards fetch for themselves, and the engine report — thirty days of
        allocation history — is one of them. Stacked, every morning check paid
        for it. Unmounted, it is not requested until somebody opens Trends.
      */}
      {visibleBands.map((name) => band(name))}
    </div>
  );
}
