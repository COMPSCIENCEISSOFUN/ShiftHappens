/**
 * Company Settings Page (Boundary Layer)
 *
 * Displays organization details (editable), subscription plan info,
 * and allows Company Admin to configure organization settings:
 * - Organization name, industry, description
 * - Task allocation mode (manual, suggested, auto)
 * - Task acceptance mode (auto-accept or require confirmation)
 * - Break rules (hours worked before break, break duration)
 * - Operating hours (calendar display range)
 * - Notification preferences
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { TIER_CONFIG } from "@/lib/subscription-tiers";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { StatusBadge } from "@/components/ui/status-badge";

interface OrgDetails {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  description: string | null;
}

interface Settings {
  allocationMode: string;
  taskAcceptanceMode: string;
  breakRuleHoursWorked: number;
  breakRuleBreakHours: number;
  operatingHoursStart: number;
  operatingHoursEnd: number;
  notificationPreferences: string | null;
}

interface ResourceUsage {
  current: number;
  limit: number | null;
  percentage: number | null;
}

interface SubscriptionData {
  tier: string;
  displayName: string;
  resources: Record<string, ResourceUsage>;
  features: Record<string, boolean>;
}

const RESOURCE_LABELS: Record<string, string> = {
  members: "Team members",
  active_tasks: "Active tasks",
  departments: "Departments",
  work_rules: "Work rules",
  custom_roles: "Custom roles",
};

const FEATURE_LABELS: Record<string, string> = {
  custom_roles: "Custom roles (RBAC)",
  pdf_export: "PDF report export",
  mass_import: "Mass import (Excel)",
  audit_log: "Audit log",
  priority_support: "Priority support",
};

export default function SettingsPage() {
  const params = useParams();
  const orgId = params.orgId as string;

  // ─── Org details state ─────────────────────────────────────
  const [orgDetails, setOrgDetails] = useState<OrgDetails | null>(null);
  const [orgName, setOrgName] = useState("");
  const [orgIndustry, setOrgIndustry] = useState("");
  const [orgIndustryCustom, setOrgIndustryCustom] = useState("");
  const [orgDescription, setOrgDescription] = useState("");
  const [orgMessage, setOrgMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [orgLoading, setOrgLoading] = useState(false);
  const [industryOptions, setIndustryOptions] = useState<string[]>([]);

  // ─── Settings state ────────────────────────────────────────
  const [settings, setSettings] = useState<Settings | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionData | null>(
    null
  );
  const [allocationMode, setAllocationMode] = useState("manual");
  const [taskAcceptanceMode, setTaskAcceptanceMode] = useState("auto_accept");
  const [breakHoursWorked, setBreakHoursWorked] = useState(6);
  const [breakHours, setBreakHours] = useState(1);
  const [opStart, setOpStart] = useState(6);
  const [opEnd, setOpEnd] = useState(22);
  const [notifPrefs, setNotifPrefs] = useState({
    emailNotifications: true,
    taskAssignment: true,
    taskRejection: true,
    hourLimitWarning: true,
    certificationExpiry: true,
  });
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  // ─── Billing / upgrade ─────────────────────────────────────
  const [upgradeInterval, setUpgradeInterval] = useState<"month" | "year">(
    "month"
  );
  const [upgrading, setUpgrading] = useState(false);
  const [checkoutBanner, setCheckoutBanner] = useState<
    "success" | "canceled" | null
  >(null);

  useEffect(() => {
    fetchOrgDetails();
    fetchSettings();
    fetchSubscription();
    fetchIndustries();
  }, [orgId]);

  // Reflect the ?checkout=success|canceled param Stripe redirects back with.
  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get("checkout");
    if (status === "success" || status === "canceled") {
      setCheckoutBanner(status);
      // Clean the URL so a refresh doesn't re-show the banner.
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function startUpgrade() {
    setUpgrading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval: upgradeInterval, source: "settings" }),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setMessage({ type: "error", text: data.error || "Couldn't start checkout" });
    } catch {
      setMessage({ type: "error", text: "Couldn't start checkout" });
    } finally {
      setUpgrading(false);
    }
  }

  // ─── Org details fetching + saving ─────────────────────────

  async function fetchOrgDetails() {
    try {
      const res = await fetch(`/api/organizations/${orgId}`);
      if (!res.ok) return;
      const data: OrgDetails = await res.json();
      setOrgDetails(data);
      setOrgName(data.name);
      setOrgDescription(data.description || "");

      const industry = data.industry || "";
      if (industryOptions.includes(industry)) {
        setOrgIndustry(industry);
        setOrgIndustryCustom("");
      } else if (industry) {
        setOrgIndustry("other");
        setOrgIndustryCustom(industry);
      } else {
        setOrgIndustry("");
        setOrgIndustryCustom("");
      }
    } catch {
      // Non-critical on initial load
    }
  }

  async function fetchIndustries() {
    try {
      const res = await fetch("/api/platform/templates");
      if (res.ok) {
        const data = await res.json();
        setIndustryOptions(data.map((t: { name: string }) => t.name));
      }
    } catch {
      // Non-critical
    }
  }

  async function onSaveOrgDetails() {
    setOrgMessage(null);

    const trimmedName = orgName.trim();
    if (!trimmedName) {
      setOrgMessage({ type: "error", text: "Organization name is required" });
      return;
    }

    const industryValue =
      orgIndustry === "other" ? orgIndustryCustom.trim() : orgIndustry;

    setOrgLoading(true);

    try {
      const res = await fetch(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          industry: industryValue || "",
          description: orgDescription.trim(),
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        setOrgMessage({
          type: "error",
          text: result.error || "Failed to update organization",
        });
        return;
      }

      setOrgDetails(result);
      setOrgMessage({
        type: "success",
        text: "Organization details updated",
      });
    } catch {
      setOrgMessage({ type: "error", text: "Something went wrong" });
    } finally {
      setOrgLoading(false);
    }
  }

  // ─── Settings fetching + saving ────────────────────────────

  async function fetchSettings() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings`);
      const data = await res.json();
      setSettings(data);
      setAllocationMode(data.allocationMode);
      setTaskAcceptanceMode(data.taskAcceptanceMode);
      setBreakHoursWorked(data.breakRuleHoursWorked);
      setBreakHours(data.breakRuleBreakHours);
      setOpStart(data.operatingHoursStart ?? 6);
      setOpEnd(data.operatingHoursEnd ?? 22);
      if (data.notificationPreferences) {
        setNotifPrefs({
          ...notifPrefs,
          ...JSON.parse(data.notificationPreferences),
        });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to load settings" });
    }
  }

  async function fetchSubscription() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/subscription`);
      if (res.ok) {
        const data = await res.json();
        setSubscription(data);
      }
    } catch {
      // Non-critical
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

    if (opEnd <= opStart) {
      setMessage({
        type: "error",
        text: "Operating end hour must be after start hour",
      });
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(`/api/organizations/${orgId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allocationMode,
          taskAcceptanceMode,
          breakRuleHoursWorked: breakHoursWorked,
          breakRuleBreakHours: breakHours,
          operatingHoursStart: opStart,
          operatingHoursEnd: opEnd,
          notificationPreferences: notifPrefs,
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        setMessage({
          type: "error",
          text: result.error || "Failed to update settings",
        });
        return;
      }

      setSettings(result);
      setMessage({ type: "success", text: "Settings updated successfully" });
    } catch {
      setMessage({ type: "error", text: "Something went wrong" });
    } finally {
      setLoading(false);
    }
  }

  function usageColor(percentage: number | null): string {
    if (percentage === null) return "bg-primary";
    if (percentage >= 90) return "bg-red-500";
    if (percentage >= 70) return "bg-amber-500";
    return "bg-primary";
  }

  function formatHour(h: number): string {
    if (h === 0 || h === 24) return "12 AM (midnight)";
    if (h === 12) return "12 PM (noon)";
    if (h < 12) return `${h} AM`;
    return `${h - 12} PM`;
  }

  if (!settings) return <PageLoading />;

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-2xl font-bold">Company Settings</h2>

      {/* ─── Organization Details ───────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Organization Details</CardTitle>
          <CardDescription>
            Update your organization&apos;s name, industry, and description
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {orgMessage && <AlertBanner message={orgMessage.text} variant={orgMessage.type === "success" ? "success" : "error"} />}

          <div className="space-y-2">
            <Label htmlFor="orgName">Organization Name</Label>
            <Input
              id="orgName"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="e.g. Ocean Grill"
              maxLength={100}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="orgIndustry">Industry</Label>
            <select
              id="orgIndustry"
              className="w-full rounded-md border px-3 py-2 text-sm bg-background"
              value={orgIndustry}
              onChange={(e) => {
                setOrgIndustry(e.target.value);
                if (e.target.value !== "other") setOrgIndustryCustom("");
              }}
            >
              <option value="">Not specified</option>
              {industryOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
              <option value="other">Other</option>
            </select>
            {orgIndustry === "other" && (
              <Input
                value={orgIndustryCustom}
                onChange={(e) => setOrgIndustryCustom(e.target.value)}
                placeholder="Enter your industry"
                maxLength={100}
                className="mt-2"
              />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="orgDescription">Description</Label>
            <textarea
              id="orgDescription"
              className="w-full rounded-md border px-3 py-2 text-sm bg-background min-h-[80px] resize-y"
              value={orgDescription}
              onChange={(e) => setOrgDescription(e.target.value)}
              placeholder="Brief description of your organization"
              maxLength={500}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              {orgDescription.length}/500 characters
            </p>
          </div>
        </CardContent>
        <CardFooter>
          <Button
            type="button"
            onClick={onSaveOrgDetails}
            disabled={orgLoading}
          >
            {orgLoading ? "Saving..." : "Save Details"}
          </Button>
        </CardFooter>
      </Card>

      {/* ─── Subscription Plan Section ─────────────────────────── */}
      {subscription && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Subscription Plan</CardTitle>
                <CardDescription>
                  Your organization&apos;s current plan and resource usage
                </CardDescription>
              </div>
              <StatusBadge value={subscription.tier} palette="tier" label={subscription.displayName} />
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Post-checkout banner */}
            {checkoutBanner === "success" && <AlertBanner message="Payment received — your plan will update to Pro momentarily. Refresh if it hasn't updated." variant="success" />}
            {checkoutBanner === "canceled" && <AlertBanner message={`Checkout canceled — no charge was made. You're still on the ${subscription.displayName} plan.`} variant="warning" />}

            <div>
              <p className="text-sm font-medium mb-3">Resource Usage</p>
              <div className="space-y-3">
                {Object.entries(subscription.resources).map(([key, usage]) => (
                  <div key={key} className="flex items-center gap-3">
                    <span className="text-sm w-28 shrink-0">
                      {RESOURCE_LABELS[key] || key}
                    </span>
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${usageColor(usage.percentage)}`}
                        style={{
                          width:
                            usage.percentage !== null
                              ? `${Math.min(usage.percentage, 100)}%`
                              : "0%",
                        }}
                      />
                    </div>
                    <span className="text-sm text-muted-foreground w-24 text-right tabular-nums">
                      {usage.limit !== null
                        ? `${usage.current} / ${usage.limit}`
                        : `${usage.current} (no limit)`}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            <div>
              <p className="text-sm font-medium mb-3">Feature Access</p>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(subscription.features).map(
                  ([key, available]) => (
                    <div key={key} className="flex items-center gap-2 text-sm">
                      <span
                        className={
                          available
                            ? "text-green-600 dark:text-green-400"
                            : "text-muted-foreground"
                        }
                      >
                        {available ? "✓" : "✗"}
                      </span>
                      <span className={available ? "" : "text-muted-foreground"}>
                        {FEATURE_LABELS[key] || key}
                      </span>
                    </div>
                  )
                )}
              </div>
            </div>

            {/* Upgrade to Pro (free tier only) */}
            {subscription.tier === "free" && (
              <>
                <Separator />
                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium">Upgrade to Pro</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {TIER_CONFIG.pro.tagline}
                      </p>
                    </div>
                    <p className="text-lg font-bold whitespace-nowrap">
                      $
                      {upgradeInterval === "year"
                        ? TIER_CONFIG.pro.yearlyPrice
                        : TIER_CONFIG.pro.monthlyPrice}
                      <span className="text-xs font-normal text-muted-foreground">
                        /{upgradeInterval === "year" ? "yr" : "mo"}
                      </span>
                    </p>
                  </div>

                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Billing:</span>
                    <div className="inline-flex rounded-md border p-0.5">
                      <button
                        type="button"
                        onClick={() => setUpgradeInterval("month")}
                        className={`rounded px-3 py-1 text-xs transition-colors ${
                          upgradeInterval === "month"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Monthly
                      </button>
                      <button
                        type="button"
                        onClick={() => setUpgradeInterval("year")}
                        className={`rounded px-3 py-1 text-xs transition-colors ${
                          upgradeInterval === "year"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Annual
                        <span className="ml-1 text-[10px] opacity-80">
                          (2 months free)
                        </span>
                      </button>
                    </div>
                  </div>

                  <Button
                    type="button"
                    onClick={startUpgrade}
                    disabled={upgrading}
                  >
                    {upgrading ? "Redirecting…" : "Upgrade to Pro"}
                  </Button>
                </div>
              </>
            )}

            {/* Pro tier — enterprise is contact-sales */}
            {subscription.tier === "pro" && (
              <>
                <Separator />
                <p className="text-sm text-muted-foreground">
                  You&apos;re on the Pro plan. Need higher limits or audit logs?
                  Contact us about Enterprise.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Settings Form ─────────────────────────────────────── */}
      <form onSubmit={onSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Task Allocation</CardTitle>
            <CardDescription>
              Configure how tasks are allocated to staff
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {message && <AlertBanner message={message.text} variant={message.type === "success" ? "success" : "error"} />}

            <div className="space-y-2">
              <Label htmlFor="allocationMode">Allocation Mode</Label>
              <select
                id="allocationMode"
                className="w-full rounded-md border px-3 py-2 text-sm bg-background"
                value={allocationMode}
                onChange={(e) => setAllocationMode(e.target.value)}
              >
                <option value="manual">
                  Manual — Admin assigns staff directly
                </option>
                <option value="suggested">
                  Suggested — AI recommends, admin confirms
                </option>
                <option value="auto">
                  Auto — AI assigns automatically
                </option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="taskAcceptanceMode">Task Acceptance</Label>
              <select
                id="taskAcceptanceMode"
                className="w-full rounded-md border px-3 py-2 text-sm bg-background"
                value={taskAcceptanceMode}
                onChange={(e) => setTaskAcceptanceMode(e.target.value)}
              >
                <option value="auto_accept">
                  Auto Accept — Staff auto-assigned
                </option>
                <option value="require_acceptance">
                  Require Acceptance — Staff must confirm
                </option>
              </select>
            </div>

            <Separator />

            <p className="text-base font-medium">Break Rules</p>
            <p className="text-sm text-muted-foreground">
              Mandatory break requirements after consecutive hours worked
            </p>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="breakRuleHoursWorked">
                  Hours before break required
                </Label>
                <Input
                  id="breakRuleHoursWorked"
                  type="number"
                  min={1}
                  max={24}
                  value={breakHoursWorked}
                  onChange={(e) => setBreakHoursWorked(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="breakRuleBreakHours">
                  Minimum break duration (hours)
                </Label>
                <Input
                  id="breakRuleBreakHours"
                  type="number"
                  min={1}
                  max={24}
                  value={breakHours}
                  onChange={(e) => setBreakHours(Number(e.target.value))}
                />
              </div>
            </div>

            <Separator />

            <p className="text-base font-medium">Operating Hours</p>
            <p className="text-sm text-muted-foreground">
              The daily operating window shown on the calendar. Tasks outside
              these hours won&apos;t appear in the calendar grid.
            </p>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="opStart">Opens at</Label>
                <select
                  id="opStart"
                  className="w-full rounded-md border px-3 py-2 text-sm bg-background"
                  value={opStart}
                  onChange={(e) => setOpStart(Number(e.target.value))}
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>
                      {formatHour(i)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="opEnd">Closes at</Label>
                <select
                  id="opEnd"
                  className="w-full rounded-md border px-3 py-2 text-sm bg-background"
                  value={opEnd}
                  onChange={(e) => setOpEnd(Number(e.target.value))}
                >
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                    <option key={h} value={h}>
                      {formatHour(h)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Currently set to {formatHour(opStart)} — {formatHour(opEnd)} (
              {opEnd - opStart} hours)
            </p>

            <Separator />

            <p className="text-base font-medium">Notifications</p>
            <p className="text-sm text-muted-foreground">
              Configure which notifications are enabled
            </p>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={notifPrefs.emailNotifications}
                  onChange={(e) =>
                    setNotifPrefs({
                      ...notifPrefs,
                      emailNotifications: e.target.checked,
                    })
                  }
                />
                Email notifications
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={notifPrefs.taskAssignment}
                  onChange={(e) =>
                    setNotifPrefs({
                      ...notifPrefs,
                      taskAssignment: e.target.checked,
                    })
                  }
                />
                Task assignment notifications
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={notifPrefs.taskRejection}
                  onChange={(e) =>
                    setNotifPrefs({
                      ...notifPrefs,
                      taskRejection: e.target.checked,
                    })
                  }
                />
                Task rejection notifications
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={notifPrefs.hourLimitWarning}
                  onChange={(e) =>
                    setNotifPrefs({
                      ...notifPrefs,
                      hourLimitWarning: e.target.checked,
                    })
                  }
                />
                Hour limit warning notifications
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={notifPrefs.certificationExpiry}
                  onChange={(e) =>
                    setNotifPrefs({
                      ...notifPrefs,
                      certificationExpiry: e.target.checked,
                    })
                  }
                />
                Certification expiry notifications
              </label>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={loading}>
              {loading ? "Saving..." : "Save Settings"}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}