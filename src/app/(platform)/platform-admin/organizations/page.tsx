/**
 * Platform Organizations Page (Boundary Layer)
 *
 * Lists all organization tenants with management controls.
 * Platform admin can view details, change subscription tier,
 * and suspend/activate orgs.
 */
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageLoading } from "@/components/ui/page-loading";
import { StatusBadge } from "@/components/ui/status-badge";

interface Organization {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  status: string;
  subscriptionTier: string;
  createdAt: string;
  _count: {
    memberships: number;
    tasks: number;
  };
}

const TIER_STYLES: Record<string, string> = {
  free: "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
  pro: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
  enterprise: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800",
};

export default function PlatformOrganizationsPage() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [changingTierId, setChangingTierId] = useState<string | null>(null);

  async function fetchOrgs() {
    try {
      const res = await fetch("/api/platform/organizations");
      if (!res.ok) throw new Error("Failed to fetch organizations");
      const data = await res.json();
      setOrgs(data.organizations);
      setTotal(data.total);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load organizations"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads the organisation list from the server on mount
    fetchOrgs();
  }, []);

  async function handleToggleStatus(orgId: string) {
    setTogglingId(orgId);
    try {
      const res = await fetch(`/api/platform/organizations/${orgId}`, {
        method: "PATCH",
      });
      if (!res.ok) throw new Error("Failed to update organization");
      await fetchOrgs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleTierChange(orgId: string, newTier: string) {
    setChangingTierId(orgId);
    try {
      const res = await fetch(`/api/platform/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionTier: newTier }),
      });
      if (!res.ok) throw new Error("Failed to update tier");
      await fetchOrgs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update tier");
    } finally {
      setChangingTierId(null);
    }
  }

  if (loading) {
    return <PageLoading label="Loading organizations..." />;
  }

  if (error) {
    return (
      <AlertBanner
        message={
          <>
            {error}
            <button onClick={() => { setError(null); fetchOrgs(); }} className="ml-2 underline">
              Retry
            </button>
          </>
        }
        variant="error"
      />
    );
  }

  const activeCount = orgs.filter((o) => o.status === "active").length;
  const suspendedCount = orgs.filter((o) => o.status === "suspended").length;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Organizations</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {total} total · {activeCount} active
            {suspendedCount > 0 && ` · ${suspendedCount} suspended`}
          </p>
        </div>
      </div>

      {orgs.length === 0 ? (
        <p className="text-muted-foreground">No organizations found.</p>
      ) : (
        <div className="space-y-3">
          {orgs.map((org) => (
            <Card
              key={org.id}
              className={org.status === "suspended" ? "opacity-60" : ""}
            >
              <CardContent className="flex items-center justify-between py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold">{org.name}</h3>
                    <StatusBadge
                      value={org.status}
                      palette="membershipStatus"
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {org.industry || "No industry"} · {org._count.memberships}{" "}
                    members · {org._count.tasks} tasks
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Created{" "}
                    {new Date(org.createdAt).toLocaleDateString()}
                  </p>
                </div>

                <div className="flex items-center gap-3 ml-4">
                  <select
                    value={org.subscriptionTier}
                    onChange={(e) => handleTierChange(org.id, e.target.value)}
                    disabled={changingTierId === org.id}
                    className={`rounded-md border px-2 py-1 text-xs font-medium cursor-pointer disabled:cursor-wait ${
                      TIER_STYLES[org.subscriptionTier] || TIER_STYLES.free
                    }`}
                  >
                    <option value="free">Free</option>
                    <option value="pro">Pro</option>
                    <option value="enterprise">Enterprise</option>
                  </select>

                  <Button
                    variant={
                      org.status === "active" ? "destructive" : "default"
                    }
                    size="sm"
                    disabled={togglingId === org.id}
                    onClick={() => handleToggleStatus(org.id)}
                  >
                    {togglingId === org.id
                      ? "Updating..."
                      : org.status === "active"
                        ? "Suspend"
                        : "Activate"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
