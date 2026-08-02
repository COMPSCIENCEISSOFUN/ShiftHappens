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
import { Building2, CheckCircle2, ListTodo, PieChart, Users } from "lucide-react";
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

      setStats({ ...data, tierCounts: data.tierCounts ?? {} });
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
        <h2 className="mb-4 text-xl font-bold tracking-tight sm:text-2xl">
          Platform overview
        </h2>
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
        <p className="mt-0.5 text-[13px] text-muted-foreground">
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
      </div>
    </div>
  );
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
        <p className="truncate text-[11px] text-muted-foreground">{label}</p>
        <p className="text-[15px] font-semibold tracking-tight">{value}</p>
      </div>
    </div>
  );
}
