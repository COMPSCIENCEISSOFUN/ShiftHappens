/**
 * Platform Admin Dashboard (Boundary Layer)
 *
 * Overview page showing platform-wide statistics
 * and subscription tier distribution.
 * Only accessible to platform admins.
 */
"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface PlatformStats {
  totalOrganizations: number;
  activeOrganizations: number;
  totalUsers: number;
  totalTasks: number;
}

interface Organization {
  id: string;
  subscriptionTier: string;
  status: string;
}

const TIER_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  enterprise: "Enterprise",
};

const TIER_COLORS: Record<string, string> = {
  free: "text-gray-700 bg-gray-100",
  pro: "text-blue-700 bg-blue-50",
  enterprise: "text-purple-700 bg-purple-50",
};

export default function PlatformAdminDashboard() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [tierCounts, setTierCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const [statsRes, orgsRes] = await Promise.all([
          fetch("/api/platform/stats"),
          fetch("/api/platform/organizations"),
        ]);

        if (!statsRes.ok) throw new Error("Failed to fetch stats");
        if (!orgsRes.ok) throw new Error("Failed to fetch organizations");

        const statsData = await statsRes.json();
        const orgsData = await orgsRes.json();

        setStats(statsData);

        const counts: Record<string, number> = {
          free: 0,
          pro: 0,
          enterprise: 0,
        };
        for (const org of orgsData.organizations as Organization[]) {
          const tier = org.subscriptionTier || "free";
          counts[tier] = (counts[tier] || 0) + 1;
        }
        setTierCounts(counts);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load stats"
        );
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="text-muted-foreground">Loading platform stats...</div>
    );
  }

  if (error) {
    return <div className="text-red-500">{error}</div>;
  }

  if (!stats) return null;

  const statCards = [
    { title: "Total organizations", value: stats.totalOrganizations },
    { title: "Active organizations", value: stats.activeOrganizations },
    { title: "Total users", value: stats.totalUsers },
    { title: "Total tasks", value: stats.totalTasks },
  ];

  const totalOrgs = stats.totalOrganizations || 1;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Platform overview</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {statCards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{card.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Subscription distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-6">
            {(["free", "pro", "enterprise"] as const).map((tier) => {
              const count = tierCounts[tier] || 0;
              const pct =
                totalOrgs > 0 ? Math.round((count / totalOrgs) * 100) : 0;

              return (
                <div key={tier} className="flex items-center gap-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TIER_COLORS[tier]}`}
                  >
                    {TIER_LABELS[tier]}
                  </span>
                  <div>
                    <p className="text-lg font-semibold">{count}</p>
                    <p className="text-xs text-muted-foreground">{pct}%</p>
                  </div>
                </div>
              );
            })}
          </div>

          {totalOrgs > 0 && (
            <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-gray-100">
              {(["free", "pro", "enterprise"] as const).map((tier) => {
                const count = tierCounts[tier] || 0;
                const pct = (count / totalOrgs) * 100;
                if (pct === 0) return null;

                const barColors: Record<string, string> = {
                  free: "bg-gray-400",
                  pro: "bg-blue-400",
                  enterprise: "bg-purple-400",
                };

                return (
                  <div
                    key={tier}
                    className={`${barColors[tier]}`}
                    style={{ width: `${pct}%` }}
                  />
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
