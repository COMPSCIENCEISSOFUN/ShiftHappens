/**
 * Company Settings Page (Boundary Layer)
 *
 * Redesigned settings page with:
 * - Hero banner (settings icon, org name badge, plan badge)
 * - Two-column card layout grouped by domain
 * - Radio cards for allocation modes
 * - Toggle switches for notification preferences
 * - Independent save per section
 * - Full-width subscription card at the bottom
 *
 * Cards:
 *   Left:  Organization Details | Notification Preferences
 *   Right: Task Configuration
 *   Full:  Subscription & Billing
 *
 * Note: Work Rules have their own dedicated page (/work-rules)
 *
 * Data flow: Settings page → SettingsService → SettingsRepository (BCE)
 */
"use client";

import { useEffect, useRef, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { TIER_CONFIG } from "@/lib/subscription-tiers";
import {
  OTHER_INDUSTRY,
  industryFromSelection,
  resolveIndustrySelection,
} from "@/lib/industry-templates";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { StatusBadge } from "@/components/ui/status-badge";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface OrgDetails {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  description: string | null;
}

interface Settings {
  allocationMode: string;
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

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Radio Card sub-component                                           */
/* ------------------------------------------------------------------ */

function RadioCard({
  name,
  value,
  selected,
  onSelect,
  title,
  description,
}: {
  name: string;
  value: string;
  selected: boolean;
  onSelect: (v: string) => void;
  title: string;
  description: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border-2 px-4 py-3 transition-colors ${
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/40"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        onChange={() => onSelect(value)}
        className="mt-0.5 accent-primary"
      />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usageColor(percentage: number | null): string {
  if (percentage === null) return "bg-primary";
  if (percentage >= 90) return "bg-red-500";
  if (percentage >= 70) return "bg-amber-500";
  return "bg-primary";
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

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
  /**
   * The same list as `industryOptions`, readable from a callback without a
   * closure over a particular render. State is for rendering the <option>s;
   * this is for classifying a value inside an async handler, where reading the
   * state variable is precisely what caused the bug this file's loadOrgIdentity
   * comment describes.
   */
  const industryOptionsRef = useRef<string[]>([]);

  // ─── Settings state ────────────────────────────────────────
  const [settings, setSettings] = useState<Settings | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionData | null>(
    null
  );
  const [allocationMode, setAllocationMode] = useState("auto");
  const [taskMessage, setTaskMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);

  // ─── Notification state ────────────────────────────────────
  const [notifPrefs, setNotifPrefs] = useState({
    emailNotifications: true,
    taskAssignment: true,
    hourLimitWarning: true,
    certificationExpiry: true,
  });
  const [notifMessage, setNotifMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [notifLoading, setNotifLoading] = useState(false);

  // ─── Billing / upgrade ─────────────────────────────────────
  const [upgradeInterval, setUpgradeInterval] = useState<"month" | "year">(
    "month"
  );
  const [upgrading, setUpgrading] = useState(false);
  const [checkoutBanner, setCheckoutBanner] = useState<
    "success" | "canceled" | null
  >(null);

  /* ────────────────────────────────────────────────────────────── */
  /*  Data fetching                                                 */
  /* ────────────────────────────────────────────────────────────── */

  useEffect(() => {
    loadOrgIdentity();
    fetchSettings();
    fetchSubscription();
  }, [orgId]);

  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get("checkout");
    if (status === "success" || status === "canceled") {
      setCheckoutBanner(status);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  /**
   * Loads the organization and the industry option list as one unit.
   *
   * They must resolve together, because classifying the stored industry needs
   * both. When these were two independent fetches, fetchOrgDetails read
   * `industryOptions` out of a closure captured on the first render — always
   * the initial `[]`, regardless of which request finished first — so every
   * industry, including one picked from this very dropdown, fell through to
   * "Other". The saved value was always correct; only the control was wrong,
   * which is why the page looked right until it was reloaded.
   *
   * Passing the resolved array to resolveIndustrySelection removes the ordering
   * dependency entirely rather than papering over it with an extra effect.
   */
  async function loadOrgIdentity() {
    const [org, options] = await Promise.all([
      fetchOrgDetails(),
      fetchIndustries(),
    ]);

    industryOptionsRef.current = options;
    setIndustryOptions(options);
    if (!org) return;

    setOrgDetails(org);
    setOrgName(org.name);
    setOrgDescription(org.description || "");
    applyIndustry(org.industry, options);
  }

  /** Drives both industry controls from a stored value. */
  function applyIndustry(
    industry: string | null | undefined,
    options: readonly string[]
  ) {
    const selection = resolveIndustrySelection(industry, options);
    setOrgIndustry(selection.select);
    setOrgIndustryCustom(selection.custom);
  }

  async function fetchOrgDetails(): Promise<OrgDetails | null> {
    try {
      const res = await fetch(`/api/organizations/${orgId}`);
      if (!res.ok) return null;
      return (await res.json()) as OrgDetails;
    } catch {
      return null; // Non-critical on initial load
    }
  }

  async function fetchIndustries(): Promise<string[]> {
    try {
      const res = await fetch("/api/platform/templates");
      if (!res.ok) return [];
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data
        .map((t: { name?: string }) => t?.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0);
    } catch {
      return []; // Non-critical — the free-text fallback still holds the value
    }
  }

  async function fetchSettings() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings`);
      const data = await res.json();
      setSettings(data);
      setAllocationMode(data.allocationMode ?? "auto");
      if (data.notificationPreferences) {
        setNotifPrefs((prev) => ({
          ...prev,
          ...JSON.parse(data.notificationPreferences),
        }));
      }
    } catch {
      setTaskMessage({ type: "error", text: "Failed to load settings" });
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

  /* ────────────────────────────────────────────────────────────── */
  /*  Save handlers (one per card)                                  */
  /* ────────────────────────────────────────────────────────────── */

  async function onSaveOrgDetails() {
    setOrgMessage(null);

    const trimmedName = orgName.trim();
    if (!trimmedName) {
      setOrgMessage({ type: "error", text: "Organization name is required" });
      return;
    }

    const industryValue = industryFromSelection(orgIndustry, orgIndustryCustom);

    setOrgLoading(true);

    try {
      const res = await fetch(`/api/organizations/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // industry is sent even when empty: the API reads "" as an explicit
        // clear, and omitting it would leave the old value in place.
        body: JSON.stringify({
          name: trimmedName,
          industry: industryValue,
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
      // Re-derive the controls from what was actually persisted, so the state
      // after Save is identical to the state after a reload. A future mismatch
      // between the two is then visible immediately instead of only on refresh.
      setOrgName(result.name);
      setOrgDescription(result.description || "");
      applyIndustry(result.industry, industryOptionsRef.current);
      setOrgMessage({ type: "success", text: "Organization details updated" });
    } catch {
      setOrgMessage({ type: "error", text: "Something went wrong" });
    } finally {
      setOrgLoading(false);
    }
  }

  async function saveSettings(
    body: Record<string, unknown>,
    setMsg: (m: { type: "success" | "error"; text: string } | null) => void,
    setLoad: (l: boolean) => void,
    successText: string
  ) {
    setMsg(null);
    setLoad(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = await res.json();

      if (!res.ok) {
        setMsg({
          type: "error",
          text: result.error || "Failed to update settings",
        });
        return;
      }

      setSettings(result);
      setMsg({ type: "success", text: successText });
    } catch {
      setMsg({ type: "error", text: "Something went wrong" });
    } finally {
      setLoad(false);
    }
  }

  function onSaveTaskConfig(e: React.FormEvent) {
    e.preventDefault();
    saveSettings(
      { allocationMode },
      setTaskMessage,
      setTaskLoading,
      "Task configuration updated"
    );
  }

  function onSaveNotifications(e: React.FormEvent) {
    e.preventDefault();
    saveSettings(
      { notificationPreferences: notifPrefs },
      setNotifMessage,
      setNotifLoading,
      "Notification preferences updated"
    );
  }

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
      setTaskMessage({
        type: "error",
        text: data.error || "Couldn't start checkout",
      });
    } catch {
      setTaskMessage({ type: "error", text: "Couldn't start checkout" });
    } finally {
      setUpgrading(false);
    }
  }

  /* ────────────────────────────────────────────────────────────── */
  /*  Render                                                        */
  /* ────────────────────────────────────────────────────────────── */

  if (!settings) return <PageLoading />;

  return (
    <div className="space-y-6">
      {/* ─── Hero Banner ──────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-indigo-600 via-violet-600 to-purple-700 px-6 py-7 text-white">
        {/* Dot-grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.8) 1px, transparent 1px)",
            backgroundSize: "16px 16px",
          }}
          aria-hidden="true"
        />

        <div className="relative z-[1] flex flex-col items-center gap-4 sm:flex-row">
          {/* Settings icon */}
          <div className="flex h-13 w-13 shrink-0 items-center justify-center rounded-xl bg-white/[0.18] backdrop-blur-sm">
            <svg
              width="28"
              height="28"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>

          <div className="flex-1 text-center sm:text-left">
            <h1 className="text-2xl font-bold">Company Settings</h1>
            <p className="mt-0.5 text-sm text-white/70">
              Manage your organization, task rules, and preferences
            </p>
          </div>

          {/* Tags */}
          <div className="flex items-center gap-2">
            {orgDetails && (
              <span className="inline-flex items-center rounded-full bg-white/[0.15] px-3 py-1 text-xs font-medium backdrop-blur-sm">
                {orgDetails.name}
              </span>
            )}
            {subscription && (
              <span className="inline-flex items-center rounded-full bg-white/[0.15] px-3 py-1 text-xs font-medium backdrop-blur-sm">
                {subscription.displayName}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ─── Two-column grid ──────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* ─── LEFT COLUMN: Org Details + Notifications ───────── */}
        <div className="space-y-6">
          {/* Card 1: Organization Details */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-950/30">
                  <svg
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    viewBox="0 0 24 24"
                    className="text-indigo-500"
                  >
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </svg>
                </div>
                <div>
                  <CardTitle>Organization Details</CardTitle>
                  <CardDescription>
                    Name, industry, and description
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {orgMessage && (
                <AlertBanner
                  message={orgMessage.text}
                  variant={
                    orgMessage.type === "success" ? "success" : "error"
                  }
                />
              )}

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
                    if (e.target.value !== OTHER_INDUSTRY)
                      setOrgIndustryCustom("");
                  }}
                >
                  <option value="">Not specified</option>
                  {industryOptions.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                  <option value={OTHER_INDUSTRY}>Other</option>
                </select>
                {orgIndustry === OTHER_INDUSTRY && (
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

          {/* Card 2: Notification Preferences */}
          <form onSubmit={onSaveNotifications}>
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-pink-50 dark:bg-pink-950/30">
                    <svg
                      width="18"
                      height="18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      viewBox="0 0 24 24"
                      className="text-pink-600"
                    >
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </svg>
                  </div>
                  <div>
                    <CardTitle>Notification Preferences</CardTitle>
                    <CardDescription>
                      Choose which notifications are sent
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {notifMessage && (
                  <AlertBanner
                    message={notifMessage.text}
                    variant={
                      notifMessage.type === "success" ? "success" : "error"
                    }
                    className="mb-4"
                  />
                )}

                <div className="divide-y">
                  {/* Email notifications */}
                  <div className="flex items-center justify-between py-3.5 first:pt-0 last:pb-0">
                    <div className="pr-4">
                      <p className="text-sm font-medium">
                        Email notifications
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Send notifications via email
                      </p>
                    </div>
                    <Switch
                      checked={notifPrefs.emailNotifications}
                      onCheckedChange={(v) =>
                        setNotifPrefs({ ...notifPrefs, emailNotifications: v })
                      }
                    />
                  </div>

                  {/* Task assignment */}
                  <div className="flex items-center justify-between py-3.5 first:pt-0 last:pb-0">
                    <div className="pr-4">
                      <p className="text-sm font-medium">Task assignment</p>
                      <p className="text-xs text-muted-foreground">
                        When tasks are assigned, unassigned, or rescheduled
                      </p>
                    </div>
                    <Switch
                      checked={notifPrefs.taskAssignment}
                      onCheckedChange={(v) =>
                        setNotifPrefs({ ...notifPrefs, taskAssignment: v })
                      }
                    />
                  </div>

                  {/* Hour limit warnings */}
                  <div className="flex items-center justify-between py-3.5 first:pt-0 last:pb-0">
                    <div className="pr-4">
                      <p className="text-sm font-medium">
                        Hour limit warnings
                      </p>
                      <p className="text-xs text-muted-foreground">
                        When staff approach their weekly hour limit
                      </p>
                    </div>
                    <Switch
                      checked={notifPrefs.hourLimitWarning}
                      onCheckedChange={(v) =>
                        setNotifPrefs({ ...notifPrefs, hourLimitWarning: v })
                      }
                    />
                  </div>

                  {/* Certification expiry */}
                  <div className="flex items-center justify-between py-3.5 first:pt-0 last:pb-0">
                    <div className="pr-4">
                      <p className="text-sm font-medium">
                        Certification expiry
                      </p>
                      <p className="text-xs text-muted-foreground">
                        When staff certifications are about to expire
                      </p>
                    </div>
                    <Switch
                      checked={notifPrefs.certificationExpiry}
                      onCheckedChange={(v) =>
                        setNotifPrefs({ ...notifPrefs, certificationExpiry: v })
                      }
                    />
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <Button type="submit" disabled={notifLoading}>
                  {notifLoading ? "Saving..." : "Save Preferences"}
                </Button>
              </CardFooter>
            </Card>
          </form>
        </div>

        {/* ─── RIGHT COLUMN: Task Configuration ──────────────── */}
        <div className="space-y-6">
          {/* Card 3: Task Configuration */}
          <form onSubmit={onSaveTaskConfig}>
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-950/30">
                    <svg
                      width="18"
                      height="18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      viewBox="0 0 24 24"
                      className="text-amber-600"
                    >
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                  </div>
                  <div>
                    <CardTitle>Task Configuration</CardTitle>
                    <CardDescription>
                      How tasks are allocated
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                {taskMessage && (
                  <AlertBanner
                    message={taskMessage.text}
                    variant={
                      taskMessage.type === "success" ? "success" : "error"
                    }
                  />
                )}

                {/* Allocation Mode */}
                <div className="space-y-2">
                  <Label>Allocation Mode</Label>
                  <div className="space-y-2">
                    <RadioCard
                      name="allocationMode"
                      value="manual"
                      selected={allocationMode === "manual"}
                      onSelect={setAllocationMode}
                      title="Manual"
                      description="Manager assigns staff using eligibility and ranking"
                    />
                    <RadioCard
                      name="allocationMode"
                      value="auto"
                      selected={allocationMode === "auto"}
                      onSelect={setAllocationMode}
                      title="Auto"
                      description="AI assigns eligible staff automatically by default"
                    />
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <Button type="submit" disabled={taskLoading}>
                  {taskLoading ? "Saving..." : "Save Configuration"}
                </Button>
              </CardFooter>
            </Card>
          </form>
        </div>
      </div>

      {/* ─── Subscription & Billing (full-width) ──────────────── */}
      {subscription && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-950/30">
                  <svg
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    viewBox="0 0 24 24"
                    className="text-violet-600"
                  >
                    <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                    <line x1="1" y1="10" x2="23" y2="10" />
                  </svg>
                </div>
                <div>
                  <CardTitle>Subscription & Billing</CardTitle>
                  <CardDescription>
                    Current plan, resource usage, and feature access
                  </CardDescription>
                </div>
              </div>
              <StatusBadge
                value={subscription.tier}
                palette="tier"
                label={subscription.displayName}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Post-checkout banner */}
            {checkoutBanner === "success" && (
              <AlertBanner
                message="Payment received — your plan will update to Pro momentarily. Refresh if it hasn't updated."
                variant="success"
              />
            )}
            {checkoutBanner === "canceled" && (
              <AlertBanner
                message={`Checkout canceled — no charge was made. You're still on the ${subscription.displayName} plan.`}
                variant="warning"
              />
            )}

            {/* Resource usage */}
            <div>
              <p className="text-sm font-medium mb-3">Resource Usage</p>
              <div className="space-y-3">
                {Object.entries(subscription.resources).map(([key, usage]) => (
                  <div key={key} className="flex items-center gap-3">
                    <span className="text-sm w-28 shrink-0 text-muted-foreground">
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

            {/* Feature Access */}
            <div>
              <p className="text-sm font-medium mb-3">Feature Access</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
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
                      <span
                        className={available ? "" : "text-muted-foreground"}
                      >
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

            {/* Pro tier */}
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
    </div>
  );
}
