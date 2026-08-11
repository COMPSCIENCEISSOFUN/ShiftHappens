/**
 * Company Settings Page (Boundary Layer)
 *
 * Redesigned settings page with:
 * - Hero banner (settings icon, org name badge, plan badge)
 * - Two-column card layout grouped by domain
 * - Radio cards for allocation/acceptance modes
 * - Toggle switches for notification preferences
 * - Independent save per section
 * - Full-width subscription card at the bottom
 *
 * Cards:
 *   Left:  Organization Details | Notification Preferences
 *   Right: Task Configuration | Operating Hours
 *   Full:  Subscription & Billing
 *
 * Note: Work Rules have their own dedicated page (/work-rules)
 *
 * Data flow: Settings page → SettingsService → SettingsRepository (BCE)
 */
"use client";

import {
  asPercentages,
  asWholePercentages,
  DEFAULT_WEIGHTS,
  MAX_SHARE,
  rebalanceWeights,
  WEIGHT_DESCRIPTIONS,
  WEIGHT_KEYS,
  WEIGHT_LABELS,
  weightsProblem,
  type RankingWeights,
} from "@/lib/ranking-weights";
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
import {
  formatHour,
  operatingWindowHours,
  windowWrapsMidnight,
} from "@/lib/business-day";
import {
  OTHER_INDUSTRY,
  industryFromSelection,
  resolveIndustrySelection,
} from "@/lib/industry-templates";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { StatusBadge } from "@/components/ui/status-badge";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { usePermissions } from "@/components/layout/permission-provider";
import { EmptyState } from "@/components/ui/empty-state";
import { Bell, Building2, Clock, CreditCard, Settings, Wrench } from "lucide-react";

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
  taskAcceptanceMode: string;
  experiencedShiftThreshold: number;
  seniorShiftThreshold: number;
  operatingHoursStart: number;
  operatingHoursEnd: number;
  notificationPreferences: string | null;
  /** Already parsed by the service — never a JSON string on the wire. */
  smartAllocationWeights: RankingWeights;
  workingDayHours: number;
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
  const { can } = usePermissions();
  /*
   * The page is reached with `settings:read`, but three different permissions
   * govern what can be SAVED from it, and the catalogue keeps them separate so
   * a "settings viewer" role is a thing an admin can compose. Every save button
   * below names the permission its own route enforces — without these, that
   * viewer saw four save buttons and an upgrade button, all of which 403.
   */
  const canUpdateOrg = can("organization:update");
  const canUpdateSettings = can("settings:update");
  const canManageBilling = can("billing:manage");

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
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [retryingSettings, setRetryingSettings] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionData | null>(
    null
  );
  const [allocationMode, setAllocationMode] = useState("manual");
  const [taskAcceptanceMode, setTaskAcceptanceMode] = useState("auto_accept");
  const [weights, setWeights] = useState<RankingWeights>(DEFAULT_WEIGHTS);
  // Completed-shift counts at which a member is treated as experienced, then
  // senior. Held as strings so the field can be emptied while typing without
  // becoming NaN and blanking the input.
  const [experiencedThreshold, setExperiencedThreshold] = useState("10");
  const [seniorThreshold, setSeniorThreshold] = useState("40");
  const [workingDayHours, setWorkingDayHours] = useState("8");
  // Defaults mirror the database defaults, so the controls show the truth for
  // the moment before the fetch resolves rather than an arbitrary 00:00–00:00.
  const [opStart, setOpStart] = useState(6);
  const [opEnd, setOpEnd] = useState(22);
  const [hoursMessage, setHoursMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [hoursLoading, setHoursLoading] = useState(false);
  const [taskMessage, setTaskMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);

  // ─── Notification state ────────────────────────────────────
  const [notifPrefs, setNotifPrefs] = useState({
    emailNotifications: true,
    taskAssignment: true,
    taskRejection: true,
    hourLimitWarning: true,
    certificationExpiry: true,
  });
  const [notifMessage, setNotifMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [notifLoading, setNotifLoading] = useState(false);

  /* ────────────────────────────────────────────────────────────── */
  /*  Data fetching                                                 */
  /* ────────────────────────────────────────────────────────────── */

  useEffect(() => {
    loadOrgIdentity();
    fetchSettings();
    fetchSubscription();
  }, [orgId]);

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
      const res = await fetch("/api/industry-templates");
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

  /**
   * `settings` gates the whole page, so a failure here has to produce something
   * other than null. It used to leave the page on <PageLoading/> forever with
   * the error banner rendered below that early return, where nothing could
   * reach it. A non-OK body is `{ error }` — storing that made `settings`
   * truthy, so the page rendered with undefined radio values and Save then
   * PATCHed an empty body and reported success.
   */
  async function fetchSettings() {
    setSettingsError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings`);
      const data = await res.json();

      if (!res.ok || typeof data?.allocationMode !== "string") {
        setSettingsError(
          typeof data?.error === "string" ? data.error : "Failed to load settings"
        );
        return;
      }

      setSettings(data);
      setAllocationMode(data.allocationMode);
      setTaskAcceptanceMode(data.taskAcceptanceMode);
      // The service hands these back already parsed, so the screen never has an
      // opinion about a malformed column.
      /*
       * Converted to shares on the way in, not stored raw.
       *
       * This panel shows a percentage beside each label and a slider handle set
       * from the stored number. Those are the same thing only while the four
       * total 100 — which every save guarantees, and which data arriving any
       * other way does not. The ranker normalises, so 60/50/50/40 is a
       * perfectly valid way to express 30/25/25/20, and loading it raw would
       * have shown labels reading 30/25/25/20 beside handles at 60/50/50/40.
       *
       * Ratios are preserved exactly, so this changes nobody's rankings — only
       * whether the screen can contradict itself.
       */
      if (data.smartAllocationWeights) {
        setWeights(asWholePercentages(data.smartAllocationWeights));
      }
      setWorkingDayHours(String(data.workingDayHours));
      setExperiencedThreshold(String(data.experiencedShiftThreshold ?? 10));
      setSeniorThreshold(String(data.seniorShiftThreshold ?? 40));
      // Guarded rather than assigned blindly: these are the only numeric
      // settings on the page, and a null from an older row would otherwise
      // become a NaN in the <select> and silently PATCH back as invalid.
      if (typeof data.operatingHoursStart === "number") setOpStart(data.operatingHoursStart);
      if (typeof data.operatingHoursEnd === "number") setOpEnd(data.operatingHoursEnd);
      if (data.notificationPreferences) {
        try {
          setNotifPrefs((prev) => ({
            ...prev,
            ...JSON.parse(data.notificationPreferences),
          }));
        } catch {
          // Malformed stored JSON shouldn't cost the user the whole page —
          // the defaults above are a usable starting point.
        }
      }
    } catch {
      setSettingsError("Failed to load settings");
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

  /*
   * Derived, not stored. The percentage beside each slider is that dimension's
   * SHARE of the total rather than its raw value, so the four always add to 100
   * on screen however the user has set them — which is what lets the raw values
   * be free.
   */
  const weightShares = asPercentages(weights);
  const weightTotal = WEIGHT_KEYS.reduce((sum, k) => sum + weights[k], 0);
  const weightWarning = weightsProblem(weights);

  function onSaveTaskConfig(e: React.FormEvent) {
    e.preventDefault();
    saveSettings(
      {
        allocationMode,
        taskAcceptanceMode,
        experiencedShiftThreshold: Number(experiencedThreshold),
        seniorShiftThreshold: Number(seniorThreshold),
        smartAllocationWeights: weights,
        workingDayHours: Number(workingDayHours),
      },
      setTaskMessage,
      setTaskLoading,
      "Task configuration updated"
    );
  }

  function onSaveOperatingHours(e: React.FormEvent) {
    e.preventDefault();
    // Saved on its own, like every other card here. Sharing a submit with task
    // configuration would mean a failure in either one reported a single
    // ambiguous error, and an admin adjusting only the hours would silently
    // re-send allocation settings they had not touched.
    saveSettings(
      { operatingHoursStart: opStart, operatingHoursEnd: opEnd },
      setHoursMessage,
      setHoursLoading,
      "Operating hours updated"
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

  /* ────────────────────────────────────────────────────────────── */
  /*  Render                                                        */
  /* ────────────────────────────────────────────────────────────── */

  if (!settings) {
    // Without this branch a failed load sat on the spinner forever, because the
    // only error banner on this page lives further down the same return.
    if (settingsError) {
      return (
        <div className="mx-auto max-w-lg space-y-4 py-12">
          <AlertBanner message={settingsError} variant="error" />
          <Button
            disabled={retryingSettings}
            onClick={async () => {
              if (retryingSettings) return;
              setRetryingSettings(true);
              try {
                await fetchSettings();
              } finally {
                setRetryingSettings(false);
              }
            }}
          >
            {retryingSettings ? "Retrying…" : "Try again"}
          </Button>
        </div>
      );
    }
    return <PageLoading />;
  }

  /*
   * The sidebar no longer links here without `settings:read`, but the URL still
   * resolved — and this page had no check of its own, so it rendered its
   * full surface and every action returned 403.
   *
   * Not a security boundary. The routes enforce this independently; this
   * is so the product does not offer what it will refuse.
   */
  if (!can("settings:read")) {
    return (
      <div className="w-full">
        <EmptyState title="Settings are managed by company admins" description="Allocation mode, operating hours and thresholds are set at the organisation level." />
      </div>
    );
  }

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
            <Settings className="h-7 w-7" aria-hidden="true" />
          </div>

          <div className="flex-1 text-center sm:text-left">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Company settings</h1>
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
                  <Building2 className="h-[18px] w-[18px] text-indigo-500" aria-hidden="true" />
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
            {canUpdateOrg && (
              <CardFooter>
                <Button
                  type="button"
                  onClick={onSaveOrgDetails}
                  disabled={orgLoading}
                >
                  {orgLoading ? "Saving..." : "Save Details"}
                </Button>
              </CardFooter>
            )}
          </Card>

          {/* Card 2: Notification Preferences */}
          <form onSubmit={onSaveNotifications}>
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-pink-50 dark:bg-pink-950/30">
                    <Bell className="h-[18px] w-[18px] text-pink-600" aria-hidden="true" />
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

                  {/* Task rejection */}
                  <div className="flex items-center justify-between py-3.5 first:pt-0 last:pb-0">
                    <div className="pr-4">
                      <p className="text-sm font-medium">Task rejection</p>
                      <p className="text-xs text-muted-foreground">
                        When staff reject an assigned task
                      </p>
                    </div>
                    <Switch
                      checked={notifPrefs.taskRejection}
                      onCheckedChange={(v) =>
                        setNotifPrefs({ ...notifPrefs, taskRejection: v })
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
              {canUpdateSettings && (
                <CardFooter>
                  <Button type="submit" disabled={notifLoading}>
                    {notifLoading ? "Saving..." : "Save Preferences"}
                  </Button>
                </CardFooter>
              )}
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
                    <Wrench className="h-[18px] w-[18px] text-amber-600" aria-hidden="true" />
                  </div>
                  <div>
                    <CardTitle>Task Configuration</CardTitle>
                    <CardDescription>
                      How tasks are allocated and accepted
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
                      description="Admin assigns staff directly to each task"
                    />
                    <RadioCard
                      name="allocationMode"
                      value="suggested"
                      selected={allocationMode === "suggested"}
                      onSelect={setAllocationMode}
                      title="Suggested"
                      description="AI recommends staff, admin confirms assignment"
                    />
                    <RadioCard
                      name="allocationMode"
                      value="auto"
                      selected={allocationMode === "auto"}
                      onSelect={setAllocationMode}
                      title="Auto"
                      description="AI assigns staff automatically based on rules"
                    />
                  </div>
                </div>

                <Separator />

                {/* Ranking Priorities */}
                {/*
                  What the engine weighs when it ranks candidates. These reach
                  BOTH the algorithmic ranker, which multiplies by them, and the
                  AI providers, which are told the ordering in the prompt — the
                  note below says which is which, because a model cannot
                  multiply by 0.30 and a screen that implied otherwise would be
                  making a claim the engine does not keep.
                */}
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <Label>Ranking Priorities</Label>
                    <span className="text-[12px] text-muted-foreground">
                      Total {weightTotal}%
                    </span>
                  </div>
                  <p className="text-[13px] text-muted-foreground">
                    Applied exactly by the built-in ranker, and given to the AI
                    as guidance. Moving one adjusts the others so the four always
                    total 100%, and each number is that priority&rsquo;s real
                    share.
                  </p>

                  <div className="space-y-3 pt-1">
                    {WEIGHT_KEYS.map((key) => (
                      <div key={key} className="space-y-1">
                        <div className="flex items-baseline justify-between">
                          <Label
                            htmlFor={`weight-${key}`}
                            className="text-[13px] font-medium"
                          >
                            {WEIGHT_LABELS[key]}
                          </Label>
                          <span className="text-[12px] tabular-nums text-muted-foreground">
                            {weightShares[key]}%
                          </span>
                        </div>
                        <input
                          id={`weight-${key}`}
                          type="range"
                          min={0}
                          step={5}
                          /* Capped where `weightsProblem` refuses, so the
                             screen cannot compose a set it will then reject. */
                          max={Math.round(MAX_SHARE * 100)}
                          value={weights[key]}
                          /*
                            Rebalanced, not set. Four sliders moving
                            independently made the one question being asked —
                            how much does this matter COMPARED to the rest —
                            unanswerable: dragging workload from 30 to 60 cut
                            availability's real share from 25% to 19% while its
                            own slider still read 25.

                            The rule lives in `ranking-weights` beside the
                            normalisation it has to agree with, not here.
                          */
                          onChange={(e) =>
                            setWeights((prev) =>
                              rebalanceWeights(prev, key, Number(e.target.value))
                            )
                          }
                          aria-label={WEIGHT_LABELS[key]}
                          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-indigo-600"
                        />
                        <p className="text-[12px] text-muted-foreground">
                          {WEIGHT_DESCRIPTIONS[key]}
                        </p>
                      </div>
                    ))}
                  </div>

                  {/*
                    Shown before saving rather than after a 400. The two refusals
                    are both states somebody reaches by dragging one slider to
                    the end, and finding out on submit means undoing a change
                    whose consequence was never visible.
                  */}
                  {weightWarning && (
                    <p className="text-[12px] text-amber-600 dark:text-amber-400">
                      {weightWarning}
                    </p>
                  )}
                </div>

                <Separator />

                {/*
                  Task Acceptance.

                  Both descriptions used to overstate what the setting does, in
                  the same direction — they described the happy path and left
                  out every case where the system asks anyway or refuses to let
                  go.

                  "Staff are automatically assigned without needing to confirm"
                  stopped being true when waiving somebody's stated
                  availability began writing the assignment `pending` on
                  purpose: booking a person onto a day they said they could not
                  work is an ask, not a booking.

                  "Staff must accept or reject each assigned task" was never
                  true for a full-time member. Their rejection is routed to
                  `decline_requested` and waits for a manager, because a
                  contracted employee refusing a rostered shift is a different
                  act from a casual turning down an offer.

                  The line about leaving a shift is the one most worth having.
                  It is the same for everybody and it surprises people: under
                  auto-accept a casual is booked without being asked and then
                  needs approval to get out, since `requestWithdrawal` is the
                  only exit from an accepted assignment and is not gated on
                  employment type.
                */}
                <div className="space-y-2">
                  <Label>Task Acceptance</Label>
                  <div className="space-y-2">
                    <RadioCard
                      name="taskAcceptanceMode"
                      value="auto_accept"
                      selected={taskAcceptanceMode === "auto_accept"}
                      onSelect={setTaskAcceptanceMode}
                      title="Auto Accept"
                      description="Staff are rostered without being asked. Anyone booked over their stated availability is still asked to confirm."
                    />
                    <RadioCard
                      name="taskAcceptanceMode"
                      value="require_acceptance"
                      selected={taskAcceptanceMode === "require_acceptance"}
                      onSelect={setTaskAcceptanceMode}
                      title="Require Acceptance"
                      description="Staff accept or reject each shift. A full-time member's rejection goes to their manager to approve."
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Either way, leaving a shift already accepted is a request a
                    manager approves — for full-time and casual staff alike.
                  </p>
                </div>

                <Separator />

                {/*
                  Seniority thresholds.

                  Configurable rather than fixed because the honest answer is
                  industry-specific: ten shifts is a competent barista and a
                  novice nurse. They are here, under task configuration, because
                  what they change is who can be assigned to a shift — a
                  composition rule reading "at most 1 junior" means whatever
                  these two numbers say it means.
                */}
                <div className="space-y-2">
                  <Label>Seniority thresholds</Label>
                  <p className="text-[11px] text-muted-foreground">
                    Completed shifts in a department before a member counts as
                    experienced, then senior. A manager can pin an individual&apos;s
                    level on the Members page when the count is wrong — a new hire
                    who is experienced elsewhere, for instance.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="experiencedShiftThreshold"
                        className="text-xs font-semibold text-muted-foreground"
                      >
                        Experienced at
                      </Label>
                      <Input
                        id="experiencedShiftThreshold"
                        type="number"
                        min={1}
                        max={500}
                        value={experiencedThreshold}
                        onChange={(e) => setExperiencedThreshold(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="seniorShiftThreshold"
                        className="text-xs font-semibold text-muted-foreground"
                      >
                        Senior at
                      </Label>
                      <Input
                        id="seniorShiftThreshold"
                        type="number"
                        min={1}
                        max={500}
                        value={seniorThreshold}
                        onChange={(e) => setSeniorThreshold(e.target.value)}
                      />
                    </div>
                  </div>
                  {/*
                    Checked here as well as in the service. The server refusal is
                    the one that counts, but an admin should not have to submit
                    to learn that an inverted pair collapses the scale to two
                    levels.
                  */}
                  {Number(seniorThreshold) <= Number(experiencedThreshold) && (
                    <p className="text-[11px] text-red-600 dark:text-red-400">
                      Senior must be higher than experienced, or the senior level
                      can never be reached.
                    </p>
                  )}
                </div>

                <Separator />

                {/*
                  The two most load-bearing numbers on this page, and until now
                  the only ones with no control anywhere.

                  They feed the eligibility break check, the hour alerts, the
                  allocation ranker's workload dimension, and — the reason this
                  was promoted out of "small" — FOUR separate
                  `staffCount * workingDayHours * 7` capacity calculations
                  in reporting. An organisation working twelve-hour shifts saw
                  wrong capacity on every report and got refusals it could not
                  configure away, because the defaults assume an eight-hour day.

                  Not to be confused with the `break_interval` WORK RULES, which
                  have their own full UI and are per-rule and targetable. These
                  are the org-wide defaults. Two mechanisms; this was the
                  unreachable one.
                */}
                <div className="space-y-2">
                  <Label>Standard working day</Label>
                  <p className="text-[11px] text-muted-foreground">
                    How long one person may work in a day. Used for the
                    eligibility hours check, hour warnings, and every capacity
                    figure in reporting — a team of six on an eight-hour day
                    reads as 336 hours of capacity a week.
                  </p>
                  {/*
                    The other half of the cross-reference, the work-rules page
                    carrying the first.

                    Three things cap hours — this one, a `max_hours_daily` rule
                    and a `max_hours_weekly` rule — over three different windows,
                    so they are not duplicates and merging them would lose real
                    checks. What was missing is that neither screen admitted the
                    other existed, so an admin who set 8 here and was refused by
                    a rule saying 6 had nowhere to see that both applied.

                    "Rolling 24 hours" is stated because it is the one that
                    surprises: this window follows the shift, while a daily rule
                    measures the business day.
                  */}
                  <p className="text-[11px] text-muted-foreground">
                    Measured over a rolling 24 hours and applied to everyone.
                    Work rules can add tighter daily or weekly limits for a
                    department or role, and both are checked.
                  </p>
                  {/*
                    Labelled "Working day", not "Break rule", although the column
                    behind it is still `workingDayHours`.

                    Nothing here enforces a BREAK. This number is a daily hours
                    cap and the denominator for capacity, and calling it a break
                    rule sent an admin looking for a rest period it does not
                    control. Rest between shifts is a `break_interval` work rule,
                    targetable per department and carrying its own break length.

                    The org-wide copy of that length — `breakRuleBreakHours` —
                    was stored, validated, seeded and round-trip tested while
                    being read by no eligibility check, no report and no prompt.
                    It is gone. A second input that changed nothing was worse
                    than no input, because it invited an admin to set it and
                    believe something had happened.

                    The column keeps its misleading name until a rename is worth
                    a migration on three databases. The label is what an admin
                    reads, and it is now true.
                  */}
                  <div className="max-w-xs space-y-1.5">
                    <Label
                      htmlFor="workingDayHours"
                      className="text-xs font-semibold text-muted-foreground"
                    >
                      Hours in a working day
                    </Label>
                    <Input
                      id="workingDayHours"
                      type="number"
                      min={1}
                      max={24}
                      value={workingDayHours}
                      onChange={(e) => setWorkingDayHours(e.target.value)}
                      disabled={!canUpdateSettings}
                    />
                  </div>
                </div>
              </CardContent>
              {canUpdateSettings && (
                <CardFooter>
                  <Button type="submit" disabled={taskLoading}>
                    {taskLoading ? "Saving..." : "Save Configuration"}
                  </Button>
                </CardFooter>
              )}
            </Card>
          </form>

          {/*
            Card 4: Operating Hours — its own card rather than a section of Task
            Configuration.

            They are not the same kind of setting. Allocation and acceptance
            describe how work is handed out; operating hours describe when the
            business runs, and the opening hour additionally defines the
            boundary every daily and weekly hour total is measured against.
            Filed under "How tasks are allocated and accepted" that second
            meaning had nowhere to be stated, and an admin changing it would
            have had no reason to think it affected anything but the calendar.
          */}
          <form onSubmit={onSaveOperatingHours}>
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-50 dark:bg-sky-950/30">
                    <Clock className="h-[18px] w-[18px] text-sky-600" aria-hidden="true" />
                  </div>
                  <div>
                    <CardTitle>Operating Hours</CardTitle>
                    <CardDescription>
                      When the business runs, and where the day starts
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {hoursMessage && (
                  <AlertBanner
                    message={hoursMessage.text}
                    variant={
                      hoursMessage.type === "success" ? "success" : "error"
                    }
                  />
                )}

                <div className="space-y-2">
                  <Label>Open from</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Opening hour"
                      value={opStart}
                      onChange={(e) => setOpStart(Number(e.target.value))}
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {formatHour(h)}
                        </option>
                      ))}
                    </select>
                    <span className="text-sm text-muted-foreground">to</span>
                    <select
                      aria-label="Closing hour"
                      value={opEnd}
                      onChange={(e) => setOpEnd(Number(e.target.value))}
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                        <option key={h} value={h}>
                          {formatHour(h)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/*
                  States the LENGTH rather than repeating the two hours, which
                  the dropdowns above already show. It also carries the one
                  thing those dropdowns cannot: that a closing hour at or before
                  the opening hour is a window running past midnight, not a
                  mistake.
                */}
                <p className="text-sm">
                  Open {operatingWindowHours(opStart, opEnd)}{" "}
                  {operatingWindowHours(opStart, opEnd) === 1 ? "hour" : "hours"} a
                  day
                  {windowWrapsMidnight(opStart, opEnd)
                    ? ", running past midnight into the next day."
                    : "."}
                </p>

                <Separator />

                <div className="space-y-1.5">
                  <p className="text-sm font-medium">
                    The day starts at {formatHour(opStart)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    The opening hour is also where one day ends and the next
                    begins, so a shift finishing at 03:00 counts towards the
                    previous day&apos;s hours — the day the people working it
                    would call it. Daily and weekly limits are measured from
                    this boundary, and the calendar draws its grid from it.
                  </p>
                </div>
              </CardContent>
              {canUpdateSettings && (
                <CardFooter>
                  <Button type="submit" disabled={hoursLoading}>
                    {hoursLoading ? "Saving..." : "Save Operating Hours"}
                  </Button>
                </CardFooter>
              )}
            </Card>
          </form>
        </div>
      </div>

      {/* ─── Subscription (full-width) ────────────────────────── */}
      {subscription && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-950/30">
                  <CreditCard className="h-[18px] w-[18px] text-violet-600" aria-hidden="true" />
                </div>
                <div>
                  <CardTitle>Subscription</CardTitle>
                  <CardDescription>
                    Which plan this organisation is on
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
          {/*
            The badge, and a way through. Everything else moved to Billing.

            This card used to carry the usage grid, the feature list, the
            interval toggle and the upgrade button — so a page called Billing
            could report a plan but not change it, while the page that could
            change it was called Settings. Worse, usage then rendered in two
            places from two endpoints, which is a disagreement waiting to
            happen.

            What is left is a fact about the organisation, which is what this
            page is for. The money is one link away.
          */}
          {canManageBilling && (
            <CardContent>
              <a
                href={`/org/${orgId}/billing`}
                className={SECONDARY_BUTTON}
              >
                <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
                Billing and plans
              </a>
            </CardContent>
          )}
        </Card>
      )}

    </div>
  );
}
