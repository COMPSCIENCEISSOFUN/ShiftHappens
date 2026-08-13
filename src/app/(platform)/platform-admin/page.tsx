/**
 * Platform Admin Dashboard (Boundary Layer)
 *
 * Platform-wide totals and the spread of customers across subscription tiers.
 * Platform admins only — the layout enforces that.
 *
 * ## On the visual language
 *
 * Predates the Phase 12 overhaul: shadcn `Card` primitives, a bare `h1`, no
 * icons, no stat tiles. It now matches the org-level pages.
 *
 * ## What changed beyond the styling
 *
 * - **It fetched every organisation to produce three numbers.** The tier split
 *   was counted in the browser from `/api/platform/organizations`, which is
 *   paginated at fifty. So the distribution was right only while there were
 *   fewer than fifty customers, and would have started under-counting silently
 *   after that — the bar would still have drawn, just wrong. The counts are now
 *   grouped in the database and come back with the stats in one request.
 * - **Unknown tiers vanished.** The page iterated a hardcoded
 *   `["free", "pro", "enterprise"]`. An organisation on any other tier was
 *   counted into a map nothing read, so it was missing from the bar and the
 *   percentages did not add to 100. Whatever tiers exist are now rendered, with
 *   the three known ones kept in order and anything else appended.
 * - **The server's error message was discarded** in favour of "Failed to fetch
 *   stats". That is the habit that made a missing database column hard to
 *   diagnose on the deployed site. It now shows what the server said, with a
 *   retry.
 */
"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ListTodo,
  MessageSquare,
  PieChart,
  Star,
  Users,
} from "lucide-react";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageLoading } from "@/components/ui/page-loading";
import { Panel } from "@/components/ui/panel";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { Donut } from "@/components/charts/chart-primitives";
import { ORDINAL, NEUTRAL } from "@/components/charts/palette";

interface PlatformStats {
  totalOrganizations: number;
  activeOrganizations: number;
  totalUsers: number;
  totalTasks: number;
  tierCounts: Record<string, number>;
  /** Monthly recurring revenue, annual plans divided by twelve. */
  mrr: number;
  arr: number;
  paidOrganizations: number;
  /** Paid tenants as a percentage of all tenants. */
  conversionRate: number;
  completedTasks: number;
  completionRate: number;
  newOrganizations: number;
  newUsers: number;
  /** Percent change against the previous 30 days; null when there was none. */
  organizationGrowth: number | null;
  userGrowth: number | null;
  averageRating: number | null;
  reviewCount: number;
  openFeedback: number;
  pastDueOrganizations: number;
}

const TIER_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  enterprise: "Enterprise",
};



/** The known tiers first, in plan order, then anything unexpected. */
function orderedTiers(counts: Record<string, number>): string[] {
  const known = ["free", "pro", "enterprise"];
  const extra = Object.keys(counts)
    .filter((t) => !known.includes(t))
    .sort();
  return [...known, ...extra];
}

function tierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier;
}

/**
 * Fills in anything the response did not carry.
 *
 * The page reads about twenty numbers off this object and formats several of
 * them — `stats.mrr.toLocaleString()`, `stats.averageRating.toFixed(1)`. One
 * absent field therefore does not degrade the dashboard, it throws during
 * render and the whole page goes blank, which is how a missing statistic
 * becomes a total outage of the screen that would have told you about it.
 *
 * Cheap insurance against a partial payload, an older deployment answering a
 * newer bundle during a rollout, or a field being renamed on the server.
 *
 * `averageRating` keeps `null` rather than defaulting to zero: no reviews yet
 * and an average of nought out of five are different facts, and the tile says
 * "—" for the first.
 */
function normalise(data: Partial<PlatformStats> | null): PlatformStats {
  const count = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

  return {
    totalOrganizations: count(data?.totalOrganizations),
    activeOrganizations: count(data?.activeOrganizations),
    totalUsers: count(data?.totalUsers),
    totalTasks: count(data?.totalTasks),
    tierCounts: data?.tierCounts ?? {},
    mrr: count(data?.mrr),
    arr: count(data?.arr),
    paidOrganizations: count(data?.paidOrganizations),
    conversionRate: count(data?.conversionRate),
    completedTasks: count(data?.completedTasks),
    completionRate: count(data?.completionRate),
    newOrganizations: count(data?.newOrganizations),
    newUsers: count(data?.newUsers),
    organizationGrowth: data?.organizationGrowth ?? null,
    userGrowth: data?.userGrowth ?? null,
    averageRating:
      typeof data?.averageRating === "number" ? data.averageRating : null,
    reviewCount: count(data?.reviewCount),
    openFeedback: count(data?.openFeedback),
    pastDueOrganizations: count(data?.pastDueOrganizations),
  };
}

export default function PlatformAdminDashboard() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchStats() {
    setLoading(true);
    try {
      const res = await fetch("/api/platform/stats");
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(
          typeof data?.error === "string" ? data.error : "Failed to load platform stats"
        );
        return;
      }

      setStats(normalise(data));
      setError(null);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads platform statistics from the server on mount
    fetchStats();
  }, []);

  if (loading) {
    return <PageLoading label="Loading platform stats..." />;
  }

  if (error || !stats) {
    return (
      <div className="w-full">
        <h1 className="mb-4 text-xl font-bold tracking-tight sm:text-2xl">
          Platform overview
        </h1>
        <AlertBanner
          message={error ?? "No statistics were returned."}
          variant="error"
        />
        <button onClick={fetchStats} className={`mt-3 ${SECONDARY_BUTTON}`}>
          Try again
        </button>
      </div>
    );
  }

  const tiers = orderedTiers(stats.tierCounts);
  const totalOrgs = stats.totalOrganizations;
  const suspended = stats.totalOrganizations - stats.activeOrganizations;

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
          Platform overview
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Every tenant on the platform, across all organisations
        </p>
      </div>

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Organisations"
          value={stats.totalOrganizations}
          detail="tenants on the platform"
          accentColour={STAT_ACCENT.indigo}
        />
        <StatTile
          label="Active"
          value={stats.activeOrganizations}
          detail={suspended > 0 ? `${suspended} suspended` : "none suspended"}
          accentColour={STAT_ACCENT.green}
          valueColour={
            stats.activeOrganizations > 0 ? "text-green-600 dark:text-green-400" : ""
          }
        />
        <StatTile
          label="Users"
          value={stats.totalUsers}
          detail="accounts registered"
          accentColour={STAT_ACCENT.blue}
        />
        <StatTile
          label="Tasks"
          value={stats.totalTasks}
          detail="created across all tenants"
          accentColour={STAT_ACCENT.amber}
        />
      </div>

      {/*
        ── Revenue and growth ──

        Above the tier donut, because the donut says how customers are
        DISTRIBUTED and this says what that distribution is worth. A platform
        dashboard whose first answer is "five organisations" and never says
        whether any of them pay is a headcount, not an overview.
      */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="MRR"
          value={`$${stats.mrr.toLocaleString()}`}
          detail={`$${stats.arr.toLocaleString()} annualised`}
          accentColour={STAT_ACCENT.green}
          valueColour={stats.mrr > 0 ? "text-green-600 dark:text-green-400" : ""}
        />
        <StatTile
          label="Paying tenants"
          value={stats.paidOrganizations}
          detail={`${stats.conversionRate}% of all organisations`}
          accentColour={STAT_ACCENT.indigo}
        />
        <StatTile
          label="New orgs · 30d"
          value={stats.newOrganizations}
          detail={growthDetail(stats.organizationGrowth, "vs previous 30 days")}
          accentColour={STAT_ACCENT.blue}
        />
        <StatTile
          label="New users · 30d"
          value={stats.newUsers}
          detail={growthDetail(stats.userGrowth, "vs previous 30 days")}
          accentColour={STAT_ACCENT.amber}
        />
      </div>

      {/*
        Payment failures, and only when there are any.

        A dashboard that reports revenue without reporting the part of it that
        has stopped arriving is reporting a wish. Hidden at zero rather than
        shown as a green tick, because a permanent "0 problems" row trains the
        eye to skip the place a real problem would appear.
      */}
      {stats.pastDueOrganizations > 0 && (
        <div className="mb-4">
          <AlertBanner
            variant="warning"
            message={
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {stats.pastDueOrganizations} organisation
                {stats.pastDueOrganizations === 1 ? "" : "s"} with a failing
                payment — their subscription is past due or unpaid.
              </span>
            }
          />
        </div>
      )}

      {/* ── Subscription distribution ── */}
      <Panel title="Subscription distribution" icon={PieChart}>
        <div className="p-4">
          {/*
            A donut, and an ORDINAL ramp rather than three unrelated hues.
            Free → Pro → Enterprise is a ladder: reordering it would change the
            meaning, so the colour carries the order (one hue, light to dark)
            and the reader gets the ranking without consulting the legend.
            Three arbitrary colours would throw that information away.

            An unrecognised tier falls off the end of the ramp and takes the
            neutral, which is honest — it has no position in a ladder the UI
            does not know about.
          */}
          <Donut
            slices={tiers.map((tier, i) => ({
              key: tier,
              label: tierLabel(tier),
              value: stats.tierCounts[tier] ?? 0,
              colour: i < ORDINAL.length ? ORDINAL[i] : NEUTRAL,
            }))}
            centreLabel="organisations"
            emptyMessage="No organisations yet. The tier split appears once the first tenant signs up."
          />
        </div>
      </Panel>

      {/* ── At a glance ── */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <SummaryRow
          icon={Building2}
          label="Average users per organisation"
          value={
            totalOrgs > 0 ? (stats.totalUsers / totalOrgs).toFixed(1) : "—"
          }
        />
        <SummaryRow
          icon={ListTodo}
          label="Average tasks per organisation"
          value={
            totalOrgs > 0 ? (stats.totalTasks / totalOrgs).toFixed(1) : "—"
          }
        />
        <SummaryRow
          icon={stats.activeOrganizations === totalOrgs ? CheckCircle2 : Users}
          label="Suspended tenants"
          value={suspended}
        />
        {/*
          The three that say whether the product is WORKING, as opposed to how
          much of it exists. Completion rate is the closest thing here to a
          usage signal: tenants who create shifts and never complete them are
          not running their rota on this.
        */}
        <SummaryRow
          icon={CheckCircle2}
          label="Task completion rate"
          value={`${stats.completionRate}%`}
        />
        <SummaryRow
          icon={Star}
          label="Average review"
          value={
            stats.averageRating === null
              ? "—"
              : `${stats.averageRating.toFixed(1)} / 5 · ${stats.reviewCount} review${
                  stats.reviewCount === 1 ? "" : "s"
                }`
          }
        />
        <SummaryRow
          icon={MessageSquare}
          label="Open feedback"
          value={stats.openFeedback}
        />
      </div>
    </div>
  );
}

/**
 * The subtitle under a growth figure.
 *
 * Returns the bare caption when there is no prior period to compare against —
 * a first month has no percentage, and "+100%" from a base of zero is a
 * division nobody meant. Growing from nothing is not growth of any rate.
 */
function growthDetail(change: number | null, caption: string): string {
  if (change === null) return caption;
  const sign = change > 0 ? "+" : "";
  return `${sign}${change}% ${caption}`;
}

function SummaryRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Building2;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="text-base font-semibold tracking-tight">{value}</p>
      </div>
    </div>
  );
}
