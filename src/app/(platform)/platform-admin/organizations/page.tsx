/**
 * Platform Organizations Page (Boundary Layer)
 *
 * Every tenant on the platform, with the two controls a platform admin has over
 * them: subscription tier, and suspend / reinstate.
 *
 * ## On the visual language
 *
 * Predates the Phase 12 overhaul — shadcn `Card`, a bare `h1`, no stat tiles,
 * no icons. It now matches Members and Departments.
 *
 * ## What changed beyond the styling
 *
 * - **Suspending an organisation had no confirmation.** It is one click, next
 *   to a dropdown, and it locks every user in that tenant out of the product
 *   until someone reinstates it. Of everything in this application it is the
 *   action with the widest blast radius, and it was the least guarded. It now
 *   goes through the app's `ConfirmDialog`, naming the organisation and the
 *   number of people affected.
 * - **The server's message was discarded** in favour of "Failed to fetch
 *   organizations". Now shown, with a retry.
 * - **A failed tier change left the dropdown showing the new value.** The
 *   `<select>` is driven by `org.subscriptionTier`, so React re-renders it from
 *   state — but state only updates after a successful refetch, and on failure
 *   the browser's own uncontrolled paint of the chosen option stayed on screen.
 *   The list is now refetched on failure too, so the control returns to what
 *   the database actually holds.
 * - **No way to find anything.** The list is unpaginated in the UI and the API
 *   returns fifty. A name/slug filter and a status filter are cheap and make
 *   the page usable past a dozen tenants. Both are client-side over the loaded
 *   page — see the note on `filtered` below.
 * - **No empty state.** A plain grey sentence, where every other list in the
 *   app uses `EmptyState`.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  CheckCircle2,
  PauseCircle,
  Search,
  ShieldAlert,
} from "lucide-react";
import { AlertBanner } from "@/components/ui/alert-banner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import {
  DANGER_BUTTON,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "@/components/ui/button-styles";

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

type StatusFilter = "all" | "active" | "suspended";

const TIER_STYLES: Record<string, string> = {
  free: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
  pro: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
  enterprise:
    "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300",
};

const TIERS = [
  { value: "free", label: "Free" },
  { value: "pro", label: "Pro" },
  { value: "enterprise", label: "Enterprise" },
];

export default function PlatformOrganizationsPage() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [changingTierId, setChangingTierId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [suspendTarget, setSuspendTarget] = useState<Organization | null>(null);

  async function fetchOrgs() {
    try {
      const res = await fetch("/api/platform/organizations");
      const data = await res.json().catch(() => null);

      if (!res.ok || !Array.isArray(data?.organizations)) {
        setError(
          typeof data?.error === "string"
            ? data.error
            : "Failed to load organizations"
        );
        return;
      }

      setOrgs(data.organizations);
      setTotal(typeof data.total === "number" ? data.total : data.organizations.length);
      setError(null);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads the organisation list from the server on mount
    fetchOrgs();
  }, []);

  /** Suspend needs confirming; reinstating is harmless and goes straight through. */
  function requestToggle(org: Organization) {
    if (org.status === "active") {
      setSuspendTarget(org);
      return;
    }
    void applyToggle(org);
  }

  async function applyToggle(org: Organization) {
    setTogglingId(org.id);
    setSuspendTarget(null);
    try {
      const res = await fetch(`/api/platform/organizations/${org.id}`, {
        method: "PATCH",
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(
          typeof data?.error === "string"
            ? data.error
            : `Failed to update ${org.name}`
        );
        return;
      }

      await fetchOrgs();
    } catch {
      setError("Could not reach the server. The change was not saved.");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleTierChange(org: Organization, newTier: string) {
    if (newTier === org.subscriptionTier) return;

    setChangingTierId(org.id);
    try {
      const res = await fetch(`/api/platform/organizations/${org.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionTier: newTier }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(
          typeof data?.error === "string" ? data.error : "Failed to update tier"
        );
      }

      // Refetch either way: on failure this pulls the dropdown back to the tier
      // the database actually holds, rather than leaving the failed choice on
      // screen looking saved.
      await fetchOrgs();
    } catch {
      setError("Could not reach the server. The tier was not changed.");
      await fetchOrgs();
    } finally {
      setChangingTierId(null);
    }
  }

  /**
   * Filtering happens over the loaded page, not the whole table.
   *
   * The API takes limit/offset and defaults to fifty, and this page has never
   * paged. So the filter searches what is on screen — correct today, and
   * honest about it in the footer count rather than implying it searched every
   * tenant.
   */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orgs.filter((org) => {
      if (statusFilter !== "all" && org.status !== statusFilter) return false;
      if (!q) return true;
      return (
        org.name.toLowerCase().includes(q) ||
        org.slug.toLowerCase().includes(q) ||
        (org.industry ?? "").toLowerCase().includes(q)
      );
    });
  }, [orgs, query, statusFilter]);

  if (loading) {
    return <PageLoading label="Loading organizations..." />;
  }

  const activeCount = orgs.filter((o) => o.status === "active").length;
  const suspendedCount = orgs.filter((o) => o.status === "suspended").length;
  const totalMembers = orgs.reduce((sum, o) => sum + o._count.memberships, 0);
  const showingAll = orgs.length >= total;

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
          Organizations
        </h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Every tenant on the platform. Changing a tier or suspending an
          organisation takes effect immediately
        </p>
      </div>

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Total"
          value={total}
          detail={showingAll ? "all shown" : `${orgs.length} loaded`}
          accentColour={STAT_ACCENT.indigo}
        />
        <StatTile
          label="Active"
          value={activeCount}
          detail="operating normally"
          accentColour={STAT_ACCENT.green}
          valueColour={activeCount > 0 ? "text-green-600 dark:text-green-400" : ""}
        />
        <StatTile
          label="Suspended"
          value={suspendedCount}
          detail={suspendedCount > 0 ? "users locked out" : "none"}
          accentColour={STAT_ACCENT.red}
          valueColour={
            suspendedCount > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
          }
        />
        <StatTile
          label="Members"
          value={totalMembers}
          detail="across loaded tenants"
          accentColour={STAT_ACCENT.blue}
        />
      </div>

      {error && (
        <AlertBanner
          message={
            <span className="flex flex-wrap items-center gap-2">
              {error}
              <button
                onClick={() => {
                  setError(null);
                  setLoading(true);
                  fetchOrgs();
                }}
                className="underline underline-offset-2"
              >
                Retry
              </button>
            </span>
          }
          variant="error"
          className="mb-4"
        />
      )}

      {/* ── Filters ── */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, slug or industry"
            aria-label="Search organizations"
            className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground"
          />
        </div>
        <div className="flex gap-1.5">
          {(["all", "active", "suspended"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setStatusFilter(value)}
              aria-pressed={statusFilter === value}
              className={statusFilter === value ? PRIMARY_BUTTON : SECONDARY_BUTTON}
            >
              {value === "all" ? "All" : value === "active" ? "Active" : "Suspended"}
            </button>
          ))}
        </div>
      </div>

      {/* ── List ── */}
      {/*
        `&& !error` matters. Without it a failed load shows the error banner AND
        "No organizations yet" underneath it, telling the reader both that the
        platform is empty and that something broke. An empty list is only news
        when we know it is true.
      */}
      {orgs.length === 0 && !error ? (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Tenants appear here as soon as someone signs up."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Search}
          title="Nothing matches those filters"
          description={
            query.trim()
              ? `No organisation on this page matches "${query.trim()}".`
              : "No organisation on this page has that status."
          }
          action={
            <button
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
              }}
              className={SECONDARY_BUTTON}
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className="space-y-2.5">
          {filtered.map((org) => {
            const suspended = org.status === "suspended";
            const busy = togglingId === org.id;

            return (
              <div
                key={org.id}
                className={`rounded-xl border bg-card p-3.5 transition-opacity sm:p-4 ${
                  suspended
                    ? "border-red-200 opacity-75 dark:border-red-900"
                    : "border-border"
                }`}
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[14px] font-semibold">{org.name}</h3>
                      <StatusBadge value={org.status} palette="membershipStatus" />
                      <span className="text-[11px] text-muted-foreground">
                        /{org.slug}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      {org.industry || "No industry"} · {org._count.memberships}{" "}
                      {org._count.memberships === 1 ? "member" : "members"} ·{" "}
                      {org._count.tasks} {org._count.tasks === 1 ? "task" : "tasks"}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Created {new Date(org.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor={`tier-${org.id}`}>
                      Subscription tier for {org.name}
                    </label>
                    <select
                      id={`tier-${org.id}`}
                      value={org.subscriptionTier}
                      onChange={(e) => handleTierChange(org, e.target.value)}
                      disabled={changingTierId === org.id}
                      className={`h-8 cursor-pointer rounded-lg border px-2.5 text-xs font-medium disabled:cursor-wait disabled:opacity-60 ${
                        TIER_STYLES[org.subscriptionTier] ?? TIER_STYLES.free
                      }`}
                    >
                      {TIERS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                      {/* Keeps an unrecognised tier visible instead of silently
                          showing the first option as if it were selected. */}
                      {!TIERS.some((t) => t.value === org.subscriptionTier) && (
                        <option value={org.subscriptionTier}>
                          {org.subscriptionTier}
                        </option>
                      )}
                    </select>

                    <button
                      onClick={() => requestToggle(org)}
                      disabled={busy}
                      className={suspended ? PRIMARY_BUTTON : DANGER_BUTTON}
                    >
                      {suspended ? (
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {busy ? "Updating…" : suspended ? "Reinstate" : "Suspend"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {filtered.length > 0 && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Showing {filtered.length} of {orgs.length} loaded
          {!showingAll && ` · ${total} on the platform`}
        </p>
      )}

      <ConfirmDialog
        open={suspendTarget !== null}
        title={`Suspend ${suspendTarget?.name ?? ""}?`}
        description={
          suspendTarget
            ? `All ${suspendTarget._count.memberships} ${
                suspendTarget._count.memberships === 1 ? "member" : "members"
              } of this organisation will be locked out until it is reinstated. Their data is not deleted.`
            : ""
        }
        confirmLabel="Suspend"
        variant="destructive"
        loading={togglingId !== null}
        onConfirm={() => suspendTarget && applyToggle(suspendTarget)}
        onCancel={() => setSuspendTarget(null)}
      />

      {suspendedCount > 0 && (
        <p className="mt-4 flex items-start gap-2 text-[11px] text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Suspended tenants keep all their data. Reinstating one restores access
          immediately.
        </p>
      )}
    </div>
  );
}
