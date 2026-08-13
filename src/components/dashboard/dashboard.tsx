"use client";

/**
 * One dashboard, assembled from the registry.
 *
 * ## What this replaces
 *
 * Three components — admin, manager, staff — picked by a switch on the caller's
 * role. That is only correct while the population of callers is those three,
 * and custom roles make it combinatorial: a member holding
 * `certifications:review` without `reports:view` was routed to the personal
 * dashboard, the API returned the certification section because it gates that
 * independently, and nothing rendered it. A granted permission the screen
 * silently dropped.
 *
 * Here the reader states what they hold, `dashboard-cards` states what each
 * card needs, and this renders the intersection. Nothing maps a role to a
 * layout any more, so no grant can fail to surface.
 *
 * ## One request, and each card decides what its own absence means
 *
 * `GET /api/organizations/[orgId]/dashboard` answers with every section the
 * caller may see, settled independently. Three states reach a card and they are
 * not interchangeable:
 *
 *   - a value — it worked
 *   - `null` — the query THREW, and the card says so
 *   - `undefined` — the reader was never sent it, and the registry should not
 *     have offered the card at all
 *
 * Three cards fetch for themselves — billing, leave and the engine report —
 * because each is a separate route with its own gates, and folding them into
 * the dashboard payload would make the slowest of them the speed of the page.
 *
 * ## The `needs` band renders nothing when it is empty
 *
 * No heading, no "0 items need you". An empty top of the screen is the fastest
 * way to say you are clear, and a band that announces its own emptiness trains
 * people to skip the band.
 *
 * ## Whose data it is, said once
 *
 * The bands organise by when something matters, not by whose numbers you are
 * looking at — so each card was left to say that in its own title, and one did
 * not: "Tomorrow — nothing scheduled, tomorrow is clear" is the organisation's
 * rota in the second person, read by a company admin who can never hold a
 * shift. Cards now declare a `subject` and the layout puts a heading over each
 * group, so a new card cannot omit the answer.
 *
 * **Except in `needs`.** Every card there carries a verb and a count in its own
 * title, and the band exists to be scanned as ONE list — splitting it in two
 * would mean two places to look for what you have to do, which is the thing it
 * was built to prevent.
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

  const reader: DashboardReader = useMemo(
    () => ({
      permissions: new Set(permissions),
      departmentScope,
      rosterable,
    }),
    [permissions, departmentScope, rosterable]
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
   * Whether both halves have something in them.
   *
   * Asked of the registry rather than assumed: a reader who cannot see any
   * trend card would otherwise get a Trends tab that opens onto nothing, which
   * is worse than no tab — it looks like the page failed to load.
   */
  const tabsWorthShowing = (
    Object.values(TAB_BANDS) as readonly (readonly DashboardBand[])[]
  ).every((bands) => bands.some((name) => cardsInBand(reader, name).length > 0));

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
      {TAB_BANDS[activeTab].map((name) => band(name))}
    </div>
  );
}
