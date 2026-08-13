/**
 * Admin Dashboard Component (Boundary Layer)
 *
 * Client component for the Company Admin dashboard view.
 * Fetches data from GET /api/organizations/[orgId]/dashboard
 * and GET /api/organizations/[orgId]/dashboard/ai-recommendations.
 *
 * Layout (matches approved mockup):
 * 1. Greeting with contextual status pill
 * 2. Action items — urgent alerts + inline AI suggestions with divider
 * 3. Key metric stat tiles with micro-visualizations
 * 4. Three-column chart row (completions, tomorrow's schedule, dept workload)
 * 5. Staff utilization bars
 *
 * Each section handles null data gracefully (per-section resilience).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CircleCheck,
  CircleHelp,
  ClipboardList,
  Clock,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { localDateInTimeZone } from "@/lib/timezone";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { NeedsAttentionItem } from "@/components/dashboard/needs-attention";
import {
  LeaveRequestsPanel,
  type LeaveDecision,
  type PendingLeave,
} from "@/components/dashboard/leave-requests-panel";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import {
  AllocationEnginePanel,
  CoveragePanel,
  EligibilityEnginePanel,
  type AllocationEngineStats,
  type EligibilityEngineStats,
} from "@/components/dashboard/engine-panels";
import type { CoverageCell } from "@/components/charts/chart-primitives";
import {
  ResponsePanel,
  SatisfactionPanel,
  type ResponseStats,
  type SatisfactionStats,
} from "@/components/dashboard/feedback-panels";
import { ExportReportButton } from "@/components/dashboard/export-report-button";

/** Payload of GET /api/organizations/[orgId]/reports/engine. */
interface EngineReport {
  allocation: AllocationEngineStats;
  eligibility: EligibilityEngineStats;
  coverage: CoverageCell[];
  response: ResponseStats;
  satisfaction: SatisfactionStats;
}
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";

// ============================================================
// API response types (matches ReportingService output)
// ============================================================

interface KeyMetrics {
  assignmentPipeline: {
    total: number;
    accepted: number;
    pending: number;
    rejected: number;
    completed: number;
  };
  completionRate: {
    current: number;
    previous: number;
    trend: "up" | "down" | "flat";
  };
  hoursLogged: {
    hours: number;
    capacity: number;
    utilization: number;
  };
}

interface TomorrowTask {
  id: string;
  title: string;
  departmentName: string | null;
  departmentColor: string | null;
  timeRange: string | null;
  isUnderstaffed: boolean;
  assignedCount: number;
  requiredHeadcount: number;
}

interface CompletionDay {
  date: string;
  label: string;
  count: number;
}

interface StaffUtilizationItem {
  membershipId: string;
  name: string;
  hoursWorked: number;
  capacity: number;
  percentage: number;
}

interface DepartmentWorkloadItem {
  id: string;
  name: string;
  color: string;
  taskCount: number;
  staffCount: number;
  isImbalanced: boolean;
}

interface RejectionTrendItem {
  staffName: string;
  membershipId: string;
  rejectionCount: number;
  reasons: { reason: string; count: number }[];
}

/** Tasks by TASK status — distinct from the assignment pipeline above. */
interface TaskSummary {
  total: number;
  open: number;
  in_progress: number;
  completed: number;
  cancelled: number;
}

interface CertificationSummary {
  total: number;
  verified: number;
  pending: number;
  rejected: number;
  expiringSoon: number;
  expired: number;
}

interface CoverageSummary {
  upcomingTasks: number;
  fullyStaffed: number;
  understaffed: number;
  unassigned: number;
  coveragePercent: number;
}

interface DashboardData {
  role: string;
  needsAttention: NeedsAttentionItem[] | null;
  keyMetrics: KeyMetrics | null;
  tomorrowsSchedule: TomorrowTask[] | null;
  completionChart: CompletionDay[] | null;
  staffUtilization: StaffUtilizationItem[] | null;
  departmentWorkload: DepartmentWorkloadItem[] | null;
  rejectionTrends: RejectionTrendItem[] | null;
  taskSummary: TaskSummary | null;
  certificationSummary: CertificationSummary | null;
  coverageSummary: CoverageSummary | null;
}

/**
 * The engine's answer to "what should I do first?".
 *
 * `reason` is nullable and often null — the ordering is the contribution, and
 * the service withholds any justification it cannot vouch for rather than
 * printing an unverifiable sentence beside a verified one.
 */
interface PriorityCall {
  entityId: string;
  message: string;
  reason: string | null;
  /** "groq" | "gemini". Never a fallback — there is no algorithmic path here. */
  provider: string;
}

/**
 * What recurs in the free text staff wrote — the one panel here whose content
 * a model produced rather than restated.
 *
 * `quotes` are verbatim and come from our database: the service resolves the
 * line numbers the model cited back against its own array, so the model chooses
 * which comments group together and writes none of the words shown under them.
 */
interface FeedbackTheme {
  theme: string;
  quotes: { text: string; context: string }[];
}

interface FeedbackThemes {
  themes: FeedbackTheme[];
  /** How many comments were read. Ours, counted — the denominator. */
  basedOn: number;
  provider: string | null;
  /** The comments were never read, as opposed to read and unremarkable. */
  unavailable?: boolean;
}

// ============================================================
// Helpers
// ============================================================

/**
 * One row of the action list.
 *
 * There is one list, and every row in it is computed deterministically from
 * the database. The model no longer contributes rows.
 *
 * ## What was here before, and why it went
 *
 * The dashboard rendered alerts AND a parallel list of AI recommendations
 * built from the same data. The recommendations restated the alerts — and
 * where one attached itself to an alert, its reasoning could contradict the
 * row it sat under ("Only 2/3 staff are assigned" beneath "0/3 assigned").
 *
 * A model handed the same facts as a rule engine will always say the same
 * things, less precisely. Its contribution now is ORDER, not content: see
 * PriorityCall.
 */
interface ActionItem {
  key: string;
  severity: "danger" | "warning" | "info";
  message: string;
  actionLabel: string;
  actionUrl: string;
  entityId?: string;
  /** True when the action POSTs rather than navigating — the nudge. */
  actionPost?: boolean;
}

/**
 * The alert list, with the engine's pick lifted to the top.
 *
 * Sorting by severity alone put five identical-looking danger rows in
 * whatever order they were computed. The pick, when there is one, goes first —
 * that ordering IS the smart engine's output, so burying it in position four
 * would discard the only thing it was asked for.
 */
function buildActionItems(
  alerts: NeedsAttentionItem[] | null,
  pickedEntityId: string | null
): ActionItem[] {
  const items: ActionItem[] = (alerts ?? []).map((alert, i) => ({
    key: `${alert.type}-${alert.entityId ?? i}`,
    severity: alert.severity,
    message: alert.message,
    actionLabel: alert.actionLabel,
    actionUrl: alert.actionUrl,
    entityId: alert.entityId,
    actionPost: alert.actionPost,
  }));

  const weight = { danger: 0, warning: 1, info: 2 } as const;
  return items.sort((a, b) => {
    if (pickedEntityId) {
      if (a.entityId === pickedEntityId) return -1;
      if (b.entityId === pickedEntityId) return 1;
    }
    return weight[a.severity] - weight[b.severity];
  });
}


function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getStatusPill(items: NeedsAttentionItem[] | null): {
  severity: "good" | "warn" | "bad";
  message: string;
} {
  if (!items || items.length === 0) {
    return { severity: "good", message: "All clear — no items need attention" };
  }
  const dangerCount = items.filter((i) => i.severity === "danger").length;
  if (dangerCount > 0 || items.length >= 3) {
    return {
      severity: "bad",
      message: `${items.length} item${items.length !== 1 ? "s" : ""} need${items.length === 1 ? "s" : ""} action`,
    };
  }
  return {
    severity: "warn",
    message: `${items.length} item${items.length !== 1 ? "s" : ""} need${items.length === 1 ? "s" : ""} action before tomorrow`,
  };
}

/**
 * Needs-attention severity → icon.
 *
 * This was an emoji table (`⚠ ⏳ 📋`) whose container tint was computed
 * separately in a JSX ternary, so shape and colour could drift apart. Emoji are
 * also the wrong primitive: they are OS-supplied colour bitmaps, so they cannot
 * inherit `currentColor` and were the only marks in these rows that ignored the
 * theme, and Windows, macOS and Android each draw them as a visibly different
 * picture. Same reasoning — and the same `{ Icon, tint, tone }` shape — as
 * `certification-state-icon.tsx` and `notification-icon.tsx`.
 *
 * Shape choices follow what the reporting service actually emits:
 *
 * - `danger` is an understaffed task, the only severity `getStatusPill` above
 *   escalates the greeting pill on. A triangle, matching the same red-on-alert
 *   pairing used for `cert_rejected` in `notification-icon.tsx`.
 * - `warning` covers pending acceptances and expiring certifications. Both are
 *   "a deadline is approaching" rather than "something is wrong", which is why
 *   it is a clock and not a second triangle — amber + `Clock` is already how
 *   `hour_limit_warning` and `pending` read elsewhere.
 * - `info` is the certification verification queue, so a list.
 */
interface SeverityIcon {
  Icon: LucideIcon;
  /** Container tint. */
  tint: string;
  /** Stroke colour. Every entry carries a dark variant or is theme-neutral. */
  tone: string;
}

const SEVERITY_ICON: Record<string, SeverityIcon> = {
  danger: {
    Icon: TriangleAlert,
    tint: "bg-red-50 dark:bg-red-950",
    tone: "text-red-600 dark:text-red-400",
  },
  warning: {
    Icon: Clock,
    tint: "bg-amber-50 dark:bg-amber-950",
    tone: "text-amber-600 dark:text-amber-400",
  },
  info: {
    Icon: ClipboardList,
    tint: "bg-indigo-50 dark:bg-indigo-950",
    tone: "text-indigo-600 dark:text-indigo-400",
  },
};

/**
 * `needsAttention` comes off `res.json()` and is only *typed* as a closed
 * union, so an unrecognised severity is genuinely reachable. It renders as a
 * neutral question mark rather than borrowing `info`'s clipboard, which is the
 * call `certification-state-icon.tsx` makes and for the same reason: an
 * unrecognised value showing up as a legitimate one turns a visible bug into an
 * invisible one. The previous `|| "📋"` fallback did exactly that.
 */
const UNKNOWN_SEVERITY: SeverityIcon = {
  Icon: CircleHelp,
  tint: "bg-muted",
  tone: "text-muted-foreground",
};

function severityIcon(severity: string): SeverityIcon {
  // `hasOwnProperty`, not `??` or `||`. SEVERITY_ICON is a plain object
  // literal, so it inherits from Object.prototype: a lookup of "constructor"
  // or "toString" returns an inherited member, the fallback never fires, and
  // JSX is handed a Function to destructure `Icon` off — crashing the row.
  return Object.prototype.hasOwnProperty.call(SEVERITY_ICON, severity)
    ? SEVERITY_ICON[severity]
    : UNKNOWN_SEVERITY;
}

/**
 * How many action rows are shown before the list is folded.
 *
 * The original supervisor note on this dashboard was "too many numbers but not
 * much information". A thirteen-row action list is that same failure in a
 * different shape: nobody triages thirteen things, they scroll past all of
 * them. The panel's job is what to do next, not everything that is true.
 *
 * The rest are one click away rather than gone, because suppressing a genuine
 * alert would be worse than burying it.
 */
const ACTION_PREVIEW = 6;

const BUTTON_NEUTRAL = "border-border bg-card text-muted-foreground hover:bg-muted";

// ============================================================
// Skeleton loader
// ============================================================

function DashboardSkeleton() {
  return (
    <div>
      <div className="mb-7">
        <div className="h-8 w-64 rounded bg-muted animate-pulse" />
        <div className="mt-2 h-4 w-96 rounded bg-muted animate-pulse" />
        <div className="mt-3 h-8 w-72 rounded-full bg-muted animate-pulse" />
      </div>
      <div className="mb-8 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-xl bg-muted animate-pulse" />
        ))}
      </div>
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-32 rounded-xl bg-muted animate-pulse" />
        ))}
      </div>
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-64 rounded-xl bg-muted animate-pulse" />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Main component
// ============================================================

interface AdminDashboardProps {
  orgId: string;
  orgName: string;
  userName?: string;
}

export default function AdminDashboard({ orgId, orgName, userName }: AdminDashboardProps) {
  const searchParams = useSearchParams();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [priority, setPriority] = useState<PriorityCall | null>(null);
  /**
   * The engine was asked about this list and did not answer.
   *
   * Distinct from having no strong opinion, which is also `call: null`. The
   * badge disappeared identically for a rate limit, a timeout, a missing key
   * and "fewer than two alerts" — so a manager who had come to rely on it had
   * no way to know the engine had stopped answering a fortnight ago.
   */
  const [priorityUnavailable, setPriorityUnavailable] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackThemes | null>(null);
  const [engine, setEngine] = useState<EngineReport | null>(null);
  const [engineLoading, setEngineLoading] = useState(true);
  const [showAllActions, setShowAllActions] = useState(false);
  /**
   * Per-row state for the availability nudge.
   *
   * Kept here rather than in the row so the button can report back — a request
   * that vanishes without acknowledgement gets sent three more times, and the
   * recipient gets three notifications.
   */
  const [nudged, setNudged] = useState<Record<string, "sending" | "sent">>({});

  /*
   * Which half of the dashboard is on screen.
   *
   * ## Why two views rather than one long page
   *
   * The page answered two questions at once — "is today covered?" and "how are
   * we doing?" — with twelve regions at identical visual weight, so the eye had
   * nowhere to land and every visit meant reading all of it. They are different
   * questions asked at different frequencies: coverage every morning, trends
   * occasionally.
   *
   * ## Why tabs and not a second route
   *
   * A separate page is only found by people who already know it exists, and
   * this one is opened by every user. A tab is visible from where they already
   * are. It also matches the status pills on Tasks, which is the pattern this
   * product already uses for "same data, different slice".
   *
   * ## Why it lives in the URL
   *
   * So a link to the trends view is a link to the trends view. Read once on
   * mount rather than kept in sync both ways — a tab that rewrites history on
   * every click turns the back button into an undo button for a segmented
   * control, which is not what anybody presses it for.
   */
  const [view, setView] = useState<"today" | "trends">(
    () => (searchParams?.get("view") === "trends" ? "trends" : "today")
  );
  const trendsRequested = useRef(false);
  const [leave, setLeave] = useState<PendingLeave[]>([]);

  async function sendNudge(key: string, url: string) {
    setNudged((prev) => ({ ...prev, [key]: "sending" }));
    try {
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) throw new Error("Request failed");
      setNudged((prev) => ({ ...prev, [key]: "sent" }));
    } catch {
      // Dropped back to its original label rather than showing an error banner
      // for something this small — the manager can simply press it again.
      setNudged((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  /*
   * Today's data on mount. The trend data is NOT fetched here.
   *
   * `fetchEngineReport` asks for thirty days of allocation history and
   * `fetchFeedbackThemes` summarises free text — the two slowest calls this
   * page makes, and neither says anything about whether today is covered.
   * Every user opens this page daily to answer that one question, so paying
   * for both on every visit was paying for a report almost nobody had scrolled
   * to. They now run the first time somebody opens Trends.
   */
  useEffect(() => {
    fetchDashboard();
    fetchAIRecommendations();
    fetchLeave();
  }, [orgId]);

  /*
   * Trend data, once, the first time that tab is opened.
   *
   * `trendsRequested` rather than `engine === null`: a report that legitimately
   * comes back empty would otherwise be re-requested on every switch back, and
   * a failed one would retry forever. This asks once and lets the panels show
   * their own empty state.
   */
  useEffect(() => {
    if (view !== "trends" || trendsRequested.current) return;
    trendsRequested.current = true;
    fetchFeedbackThemes();
    fetchEngineReport();
  }, [view]);

  async function fetchDashboard() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/organizations/${orgId}/dashboard`);
      if (!res.ok) {
        setError("Failed to load dashboard");
        return;
      }
      const result = await res.json();
      setData(result);
    } catch {
      setError("Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  /**
   * The engine report backs the collapsed "Smart engine" section.
   *
   * Fetched alongside the dashboard rather than on expand: it is one request,
   * the panels are the slowest thing on the page to read, and fetching on
   * expand would mean a spinner every time somebody opens it. Failure is
   * silent for the same reason the AI recommendations are — a dashboard that
   * refuses to render because an optional panel is unavailable is worse than
   * one missing a panel.
   */
  async function fetchEngineReport() {
    try {
      setEngineLoading(true);
      const res = await fetch(
        `/api/organizations/${orgId}/reports/engine?days=30`
      );
      const body = await res.json().catch(() => null);
      if (res.ok && body?.allocation) setEngine(body);
    } catch {
      // Non-critical.
    } finally {
      setEngineLoading(false);
    }
  }

  /**
   * Leave awaiting a decision. Its own request and its own failure — an
   * approvals list that cannot load must not take the dashboard with it.
   */
  async function fetchLeave() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/leave?view=pending`);
      const body = await res.json();
      // `view=pending` is everything undecided — live AND lapsed. A manager who
      // never opens the leave page still needs to see that something went
      // unanswered; the page defaults to the live ones because it has a Lapsed
      // filter beside it.
      setLeave(res.ok && Array.isArray(body?.rows) ? body.rows : []);
    } catch {
      setLeave([]);
    }
  }

  async function decideLeave(id: string, decision: LeaveDecision) {
    const res = await fetch(`/api/organizations/${orgId}/leave/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    // Refetched rather than spliced out locally: approving changes who is
    // eligible for shifts on this page, and a list that disagrees with the
    // server about what was decided is worse than a round trip.
    if (res.ok) await fetchLeave();
  }

  async function fetchAIRecommendations() {
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/dashboard/ai-recommendations`
      );
      if (res.ok) {
        const body = await res.json();
        setPriority(body.call ?? null);
        setPriorityUnavailable(Boolean(body.unavailable));
      }
    } catch {
      // Non-critical. No pick simply means the list keeps its own order — the
      // page is fully usable without the engine having an opinion.
    }
  }

  /**
   * Themes are slower than the priority call — it reads one list of alerts,
   * this reads every comment in the window — so it is its own request and its
   * own failure. Silent on error: an absent panel is a smaller problem than a
   * dashboard that will not render.
   */
  async function fetchFeedbackThemes() {
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/dashboard/feedback-themes`
      );
      if (res.ok) setFeedback(await res.json());
    } catch {
      // Non-critical.
    }
  }

  if (loading) return <DashboardSkeleton />;

  if (error) {
    return (
      <div>
        <h2 className="mb-6 text-2xl font-bold">{orgName}</h2>
        <AlertBanner
          message={
            <>
              {error}
              <button onClick={fetchDashboard} className="ml-2 underline">
                Retry
              </button>
            </>
          }
          variant="error"
        />
      </div>
    );
  }

  if (!data) return null;

  const status = getStatusPill(data.needsAttention);
  // One list. See mergeActionItems for why the two used to duplicate.
  const actionItems = buildActionItems(data.needsAttention, priority?.entityId ?? null);
  const shownActions = showAllActions ? actionItems : actionItems.slice(0, ACTION_PREVIEW);

  return (
    <div>
      {/* ════════════════════════════════════════════════════ */}
      {/* 1. Greeting + Status Pill + page actions            */}
      {/*                                                     */}
      {/* The export button sits with the greeting rather     */}
      {/* than beside a chart, because the PDF is built from  */}
      {/* four sections of this page and attaching it to one  */}
      {/* of them would say it exports that one. Same place   */}
      {/* Tasks puts New Task and Members puts Invite User.   */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">
            {getGreeting()}{userName ? `, ${userName}` : ""}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Here&apos;s what needs your attention at {orgName} today.
          </p>
          <div
            className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${
              status.severity === "good"
                ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
                : status.severity === "warn"
                  ? "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400"
                  : "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400"
            }`}
          >
            <span className="relative inline-block h-2 w-2 rounded-full bg-current dashboard-status-pulse" />
            {status.message}
          </div>
        </div>

        <ExportReportButton orgId={orgId} />
      </div>

      {/*
        Today / Trends.

        Deliberately the same shape as the status pills on Tasks — this product
        already has a control that means "same subject, different slice", and
        inventing a second one for the same job is how two pages come to feel
        like two products.

        The counter beside Today is the number of things actually waiting, so
        the tab itself answers the question most people opened the page to ask
        before they have read anything else on it.
      */}
      <div className="mb-5 flex items-center gap-2" role="tablist" aria-label="Dashboard view">
        {([
          { id: "today" as const, label: "Today", count: actionItems.length },
          { id: "trends" as const, label: "Trends", count: null },
        ]).map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={view === tab.id}
            onClick={() => setView(tab.id)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-all ${
              view === tab.id
                ? "border-indigo-600 bg-indigo-600 text-white shadow-sm"
                : "border-border bg-card text-muted-foreground hover:border-indigo-300 hover:text-foreground"
            }`}
          >
            {tab.label}
            {tab.count !== null && tab.count > 0 && (
              <span
                className={`rounded-full px-1.5 text-xs font-semibold ${
                  view === tab.id
                    ? "bg-white/20 text-white"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* 0. Leave awaiting a decision                        */}
      {/*                                                     */}
      {/* First thing under the tabs, because it is the only  */}
      {/* item on this page where somebody else is blocked    */}
      {/* until the reader acts.                              */}
      {/* ════════════════════════════════════════════════════ */}
      {view === "today" && leave.length > 0 && (
        <div className="mb-7">
          <LeaveRequestsPanel requests={leave} onDecide={decideLeave} />
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* 2. Action Items + Inline AI Suggestions             */}
      {/*                                                     */}
      {/* The primary read. This is the section the Today tab */}
      {/* exists to put in front of somebody, and the count   */}
      {/* on that tab is this list's length.                  */}
      {/* ════════════════════════════════════════════════════ */}
      {view === "today" && actionItems.length > 0 && (
        <CollapsibleSection
          title="Needs your action"
          storageKey="dashboard-needs-action"
          count={actionItems.length}
          defaultOpen
        >
          {/*
            One muted line, not an error. The list is complete and correctly
            ordered without the engine — only the "start here" hint is missing —
            so this says what is absent without implying the panel is broken.
          */}
          {/*
            Two different silences, and they now say different things.

            A provider outage used to mean no pick at all. It now falls back to
            the most SEVERE alert, chosen by rule — so the old sentence would
            be denying a suggestion that is visibly highlighted two rows below
            it. Which of the two is showing depends on whether a call came
            back, not on `unavailable` alone.
          */}
          {priorityUnavailable && priority && (
            <p className="mb-2 text-xs text-muted-foreground">
              The assistant is unavailable, so this is simply the most serious
              item on the list — picked by rule, not by the engine.
            </p>
          )}
          {priorityUnavailable && !priority && (
            <p className="mb-2 text-xs text-muted-foreground">
              The assistant couldn&apos;t suggest where to start right now. The
              list below is complete and in its usual order.
            </p>
          )}

          {shownActions.map((item) => {
            const { Icon, tint, tone } = severityIcon(item.severity);
            const isPicked =
              Boolean(priority) && item.entityId === priority!.entityId;

            return (
              /*
                The indigo treatment marks the ONE row the engine picked.

                It said "a model touched" until the priority call gained an
                algorithmic fallback, at which point the same highlight could
                appear with no model involved anywhere. The mark still means
                "start here"; what picked it is stated in the line above the
                list rather than left to the colour, because a colour cannot
                carry that distinction and was never going to.
                It used to mark four alert types flagged `isAiInsight`, every
                one of which was a SQL join with a threshold — the sparkle was
                decoration on a database query, and it made the panel's real
                model output indistinguishable from the rest.
              */
              <div
                key={item.key}
                className={`mb-2 flex items-start gap-3.5 rounded-xl border p-3.5 transition-shadow hover:shadow-sm ${
                  isPicked
                    ? "border-indigo-200 bg-indigo-50/30 dark:border-indigo-800 dark:bg-indigo-950/30"
                    : "border-border bg-card"
                }`}
              >
                {/* Decorative: the message beside it already says what this is. */}
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${
                    isPicked ? "text-white" : tint
                  }`}
                  style={
                    isPicked
                      ? { background: "linear-gradient(135deg, #4f46e5, #7c3aed)" }
                      : undefined
                  }
                  aria-hidden="true"
                >
                  {isPicked ? (
                    <Sparkles className="h-4 w-4" />
                  ) : (
                    <Icon className={`h-[18px] w-[18px] ${tone}`} />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">
                    {item.message}
                    {/*
                      Marks the row the engine chose to lead with. The badge
                      claims only what happened — a model picked this one — and
                      the row's words are still ours.
                    */}
                    {isPicked && (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-[5px] bg-indigo-50 px-[7px] py-0.5 align-middle text-xs font-bold text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                        START HERE
                      </span>
                    )}
                  </p>
                  {/*
                    Shown ONLY on the picked row, and only when the engine gave
                    a reason we could vouch for. Every other row's facts are
                    already stated above; a model sentence beneath them could
                    only repeat or contradict them, which it did.
                  */}
                  {isPicked && priority?.reason && (
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {priority.reason}
                    </p>
                  )}
                </div>

                {item.actionPost ? (
                  <button
                    type="button"
                    disabled={nudged[item.key] === "sending"}
                    onClick={() => sendNudge(item.key, item.actionUrl)}
                    className={`shrink-0 rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition-all ${BUTTON_NEUTRAL} disabled:opacity-50`}
                  >
                    {nudged[item.key] === "sent"
                      ? "Asked"
                      : nudged[item.key] === "sending"
                        ? "Asking…"
                        : item.actionLabel}
                  </button>
                ) : (
                  <Link href={item.actionUrl}>
                    <button
                      className={`shrink-0 rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition-all ${
                        item.severity === "danger"
                          ? "border-indigo-500 bg-indigo-600 text-white hover:opacity-90"
                          : BUTTON_NEUTRAL
                      }`}
                    >
                      {item.actionLabel}
                    </button>
                  </Link>
                )}
              </div>
            );
          })}

          {actionItems.length > ACTION_PREVIEW && (
            <button
              type="button"
              onClick={() => setShowAllActions(!showAllActions)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground"
            >
              {showAllActions
                ? "Show fewer"
                : `Show all ${actionItems.length} items`}
            </button>
          )}
        </CollapsibleSection>
      )}

      {/*
        Nothing waiting — said out loud rather than left as a gap.

        With the action list and the leave queue both empty, Today would
        otherwise open on a schedule card and no explanation, which reads as a
        page that failed to load rather than as good news. This is the answer to
        the question the tab was opened to ask.
      */}
      {view === "today" && actionItems.length === 0 && leave.length === 0 && (
        <div className="mb-7 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3.5 dark:border-emerald-900 dark:bg-emerald-950/40">
          <CircleCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
              Nothing needs you right now
            </p>
            <p className="mt-0.5 text-xs text-emerald-800 dark:text-emerald-300">
              No unfilled shifts, no approvals waiting. Tomorrow&apos;s schedule
              is below.
            </p>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* 2b. What staff are saying                           */}
      {/*                                                     */}
      {/* Kept out of the action list on purpose. Every row   */}
      {/* above is something to DO; this is something to      */}
      {/* KNOW, and mixing them would either put an           */}
      {/* Assign button on a quotation or leave a row in the  */}
      {/* action list with nothing to press.                  */}
      {/* ════════════════════════════════════════════════════ */}
      {/*
        Rendered whenever enough comments were READ, not only when themes came
        back. "We read 31 comments and found nothing recurring" is a real
        answer and the service populates `basedOn` specifically so it can be
        given — without this, an empty result, a failed model call and an org
        with no feedback at all looked identical on screen.
      */}
      {/* Trends: what people said is something to KNOW, and the fetch behind
          it is one of the two deferred until this tab is opened. */}
      {view === "trends" && feedback && feedback.basedOn >= 5 && (
        <CollapsibleSection
          title="What staff are saying"
          storageKey="dashboard-feedback-themes"
          count={feedback.themes.length}
          defaultOpen
        >
          <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {/*
              The denominator is ours and it is the honest frame: three themes
              out of eight comments is a different claim from three out of
              eighty, and the reader cannot tell which without being told.
            */}
            Read from {feedback.basedOn} comment
            {feedback.basedOn !== 1 ? "s" : ""} left on shifts in the last two
            months.
          </p>

          {feedback.themes.map((theme, i) => (
            <div
              key={`theme-${i}`}
              className="mb-2 rounded-xl border border-indigo-200 bg-indigo-50/30 p-3.5 dark:border-indigo-800 dark:bg-indigo-950/30"
            >
              <p className="text-sm font-semibold text-foreground">
                {theme.theme}
              </p>
              <div className="mt-2 space-y-1.5">
                {theme.quotes.map((quote, q) => (
                  <div
                    key={`quote-${i}-${q}`}
                    className="border-l-2 border-indigo-300 pl-2.5 dark:border-indigo-700"
                  >
                    {/*
                      Verbatim. The service resolved the line numbers the model
                      cited back against its own array, so these are staff
                      words, not the model's reproduction of them — a
                      paraphrase shown inside quotation marks would put
                      sentences in someone's mouth.
                    */}
                    <p className="text-sm italic leading-snug text-foreground">
                      &ldquo;{quote.text}&rdquo;
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {quote.context}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/*
            Two different empty states, because they mean opposite things.
            This printed the "nothing recurring" line either way — an
            affirmative claim that the comments WERE read and analysed, made
            when both providers had failed. A panel that reads as merely
            uneventful is one nobody investigates.
          */}
          {feedback.themes.length === 0 &&
            (feedback.unavailable ? (
              <p className="rounded-xl border border-dashed border-amber-300 px-3.5 py-3 text-sm text-amber-700 dark:border-amber-800 dark:text-amber-400">
                Couldn&apos;t read the comments right now — the assistant did not
                answer. Nothing has been analysed; try again shortly.
              </p>
            ) : (
              <p className="rounded-xl border border-dashed border-border px-3.5 py-3 text-sm text-muted-foreground">
                Nothing recurring in what people wrote — the comments did not
                group into a shared subject.
              </p>
            ))}
        </CollapsibleSection>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* 3. Key Metric Stat Tiles                            */}
      {/*                                                     */}
      {/* Trends. These are period figures — how much got     */}
      {/* done, how utilisation moved — not the state of      */}
      {/* today, which is what the tab above them answers.    */}
      {/* ════════════════════════════════════════════════════ */}
      {view === "trends" && data.keyMetrics && (
        <MetricsTiles metrics={data.keyMetrics} completionChart={data.completionChart} />
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/*
        4. The chart row, split by which question it answers.

        These three sat side by side as equals. Two of them look backwards —
        what got done this week, how the departments compare — and one looks at
        the shift somebody has to staff by tomorrow morning. Tomorrow's schedule
        therefore goes to Today, where it is read, and the other two stay with
        the rest of the analysis.
      */}
      {view === "today" && (
        <div className="mb-8">
          <Card className="overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-bold">
                Tomorrow&apos;s schedule
              </CardTitle>
              {data.tomorrowsSchedule && (
                <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400">
                  {data.tomorrowsSchedule.length} task{data.tomorrowsSchedule.length !== 1 ? "s" : ""}
                </span>
              )}
            </CardHeader>
            <CardContent>
              <TomorrowsList tasks={data.tomorrowsSchedule} orgId={orgId} />
            </CardContent>
          </Card>
        </div>
      )}

      {view === "trends" && (
        <div className="mb-8 grid gap-4 md:grid-cols-2">
          {/* Completions this week */}
          <Card className="overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-bold">
                Completions this week
              </CardTitle>
              {data.completionChart && (
                <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
                  {data.completionChart.reduce((s, d) => s + d.count, 0)} total
                </span>
              )}
            </CardHeader>
            <CardContent>
              <CompletionChart days={data.completionChart} />
            </CardContent>
          </Card>

          {/* Department workload */}
          <Card className="overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-bold">
                Department workload
              </CardTitle>
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                this week
              </span>
            </CardHeader>
            <CardContent>
              <WorkloadBars departments={data.departmentWorkload} />
            </CardContent>
          </Card>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* 5. Staff Utilization — a 7-day average, so Trends.  */}
      {/* ════════════════════════════════════════════════════ */}
      {view === "trends" && (
        <div className="mb-8 grid gap-4 md:grid-cols-2">
          <Card className="overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-sm font-bold">
                Staff utilization
              </CardTitle>
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                7-day avg
              </span>
            </CardHeader>
            <CardContent>
              <UtilizationBars staff={data.staffUtilization} />
            </CardContent>
          </Card>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* 6. Engine charts                                    */}
      {/*                                                     */}
      {/* Sitting with the other charts rather than behind a  */}
      {/* separate "Smart engine" heading. Grouping them by   */}
      {/* what produced them made the reader hunt for them;   */}
      {/* they answer the same kind of question as the charts */}
      {/* above and belong in the same place. Which engine    */}
      {/* produced each one is on the panel itself.           */}
      {/* ════════════════════════════════════════════════════ */}
      {view === "trends" && engine && (
        <div className="mb-8 space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <AllocationEnginePanel stats={engine.allocation} />
            <EligibilityEnginePanel stats={engine.eligibility} />
          </div>
          {/*
            Response and satisfaction sit beside the engine panels but carry no
            engine mark, because no engine produced them — they are recorded
            fact about what people did and said. Badging them to match their
            neighbours is exactly the dishonesty the marks were introduced to
            stop.

            Guarded individually: this endpoint gained two fields after the
            first three shipped, so a cached or older response can arrive
            without them, and a missing key must not blank the panels above.
          */}
          <div className="grid gap-4 lg:grid-cols-2">
            {engine.response && <ResponsePanel stats={engine.response} />}
            {engine.satisfaction && <SatisfactionPanel stats={engine.satisfaction} />}
          </div>
          <CoveragePanel cells={engine.coverage} />
        </div>
      )}

      {view === "trends" && engineLoading && !engine && (
        <div className="mb-6 h-10 rounded-xl bg-muted/40 animate-pulse" />
      )}
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

/** Three key metric tiles with micro-visualizations */
function MetricsTiles({
  metrics,
  completionChart,
}: {
  metrics: KeyMetrics;
  completionChart: CompletionDay[] | null;
}) {
  const { assignmentPipeline: pipeline, completionRate, hoursLogged } = metrics;

  // Build sparkline data from completion chart (last 7 days)
  const sparkData = completionChart
    ? completionChart.map((d) => d.count)
    : [0, 0, 0, 0, 0, 0, 0];
  const sparkMax = Math.max(...sparkData, 1);

  // Pipeline proportions
  const pipeTotal = Math.max(pipeline.total, 1);
  const acceptedPct = (pipeline.accepted / pipeTotal) * 100;
  const pendingPct = (pipeline.pending / pipeTotal) * 100;
  const rejectedPct = (pipeline.rejected / pipeTotal) * 100;

  // Capacity utilization
  const capacityPct =
    hoursLogged.capacity > 0
      ? Math.round((hoursLogged.hours / hoursLogged.capacity) * 100)
      : 0;

  return (
    <div className="mb-8 grid gap-4 md:grid-cols-3">
      {/* Completion rate with sparkline */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          Completion rate
        </p>
        <p className="mt-1 text-3xl font-bold leading-none text-foreground">
          {completionRate.current}%
        </p>
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
          <span
            className={`font-semibold ${
              completionRate.trend === "up"
                ? "text-emerald-600 dark:text-emerald-400"
                : completionRate.trend === "down"
                  ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground"
            }`}
          >
            {completionRate.trend === "up"
              ? "↑"
              : completionRate.trend === "down"
                ? "↓"
                : "→"}{" "}
            {Math.abs(completionRate.current - completionRate.previous)}%
          </span>
          vs last week
        </p>
        {/* Sparkline */}
        <div className="mt-2 flex items-end gap-0.5" style={{ height: 20 }}>
          {sparkData.map((val, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm"
              style={{
                height: `${Math.max((val / sparkMax) * 100, 8)}%`,
                backgroundColor: "#4f46e5",
                opacity: i === sparkData.length - 1 ? 0.6 : 0.2,
                minWidth: 3,
              }}
            />
          ))}
        </div>
      </div>

      {/* Hours this week with progress bar */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          Hours this week
        </p>
        <p className="mt-1 text-3xl font-bold leading-none text-foreground">
          {hoursLogged.hours}h
        </p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          of {hoursLogged.capacity}h capacity
        </p>
        <div
          className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(capacityPct, 100)}%`,
              background: "linear-gradient(90deg, #4f46e5, #7c3aed)",
            }}
          />
        </div>
        <p className="mt-1 text-right text-xs text-muted-foreground">
          {capacityPct}% utilization
        </p>
      </div>

      {/* Assignment pipeline with stacked bar */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          Assignment pipeline
        </p>
        <p className="mt-1 text-3xl font-bold leading-none text-foreground">
          {pipeline.total}
        </p>
        {/* Stacked bar */}
        <div className="mt-2.5 flex h-2.5 overflow-hidden rounded-full">
          {acceptedPct > 0 && (
            <div
              style={{
                width: `${acceptedPct}%`,
                backgroundColor: "#1baf7a",
                marginRight: 2,
              }}
              className="rounded-l-full"
            />
          )}
          {pendingPct > 0 && (
            <div
              style={{
                width: `${pendingPct}%`,
                backgroundColor: "#eb6834",
                marginRight: 2,
              }}
            />
          )}
          {rejectedPct > 0 && (
            <div
              style={{
                width: `${rejectedPct}%`,
                backgroundColor: "#e34948",
              }}
              className="rounded-r-full"
            />
          )}
        </div>
        {/* Legend */}
        <div className="mt-2 flex gap-3.5 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#1baf7a" }}
            />
            <span className="font-bold text-foreground">{pipeline.accepted}</span>{" "}
            accepted
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#eb6834" }}
            />
            <span className="font-bold text-foreground">{pipeline.pending}</span>{" "}
            pending
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#e34948" }}
            />
            <span className="font-bold text-foreground">{pipeline.rejected}</span>{" "}
            rejected
          </span>
        </div>
      </div>
    </div>
  );
}

/** Completions bar chart (7 days) */
function CompletionChart({ days }: { days: CompletionDay[] | null }) {
  if (!days) {
    return <EmptyState title="Could not load completions" />;
  }

  if (days.every((d) => d.count === 0)) {
    return <EmptyState title="No completed tasks in the last 7 days" />;
  }

  const maxCount = Math.max(...days.map((d) => d.count), 1);
  // `day.date` is produced server-side in organisation time (see
  // ReportingService.getCompletionTrend). Deriving "today" from toISOString()
  // compares a UTC date against org-time dates, so between midnight and the
  // UTC offset today's bar tested as "future" — rendering a faded dash and
  // putting the highlight on yesterday.
  const todayStr = localDateInTimeZone();

  return (
    <div>
      <div className="flex items-end gap-2" style={{ height: 110 }}>
        {days.map((day) => {
          const isToday = day.date === todayStr;
          const isFuture = day.date > todayStr;
          const heightPct = day.count > 0 ? (day.count / maxCount) * 90 : 10;

          return (
            <div
              key={day.date}
              className="flex flex-1 flex-col items-center gap-1"
            >
              <span className="text-xs font-semibold text-muted-foreground">
                {day.count > 0 ? day.count : isFuture ? "–" : "0"}
              </span>
              <div
                className="w-full rounded-t"
                style={{
                  maxWidth: 24,
                  height: `${heightPct}%`,
                  minHeight: day.count > 0 ? 4 : 2,
                  backgroundColor: isToday
                    ? "#4f46e5"
                    : isFuture
                      ? "rgba(42,120,214,0.3)"
                      : "#2a78d6",
                  borderRadius: "4px 4px 0 0",
                }}
              />
              <span
                className={`text-xs ${
                  isToday
                    ? "font-semibold text-indigo-600 dark:text-indigo-400"
                    : "text-muted-foreground"
                }`}
              >
                {day.label}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-0.5 h-px bg-border" />
    </div>
  );
}

/** Tomorrow's schedule task list */
function TomorrowsList({
  tasks,
  orgId,
}: {
  tasks: TomorrowTask[] | null;
  orgId: string;
}) {
  if (!tasks) {
    return <EmptyState title="Could not load schedule" />;
  }

  if (tasks.length === 0) {
    return <EmptyState title="No tasks scheduled for tomorrow" />;
  }

  return (
    <div className="space-y-0">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center gap-3 border-b border-muted py-2.5 last:border-b-0"
        >
          <div
            className="h-7 w-1 shrink-0 rounded-sm"
            style={{
              backgroundColor: task.departmentColor || "#94A3B8",
            }}
          />
          <span className="flex-1 truncate text-sm font-medium text-foreground">
            {task.title}
          </span>
          {task.timeRange && (
            <span className="text-xs font-medium text-muted-foreground">
              {task.timeRange}
            </span>
          )}
          {task.isUnderstaffed ? (
            <Link href={`/org/${orgId}/tasks`}>
              <span className="rounded-md bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600 dark:bg-red-950 dark:text-red-400">
                needs {task.requiredHeadcount - task.assignedCount}
              </span>
            </Link>
          ) : (
            <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
              staffed
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Department workload horizontal bars */
function WorkloadBars({
  departments,
}: {
  departments: DepartmentWorkloadItem[] | null;
}) {
  if (!departments) {
    return <EmptyState title="Could not load workload" className="py-4" />;
  }

  if (departments.length === 0) {
    return <EmptyState title="No departments found" className="py-4" />;
  }

  const maxTasks = Math.max(...departments.map((d) => d.taskCount), 1);

  return (
    <div className="space-y-0">
      {departments.map((dept) => (
        <div
          key={dept.id}
          className="flex items-center gap-3 border-b border-muted py-2.5 last:border-b-0"
        >
          <div className="flex w-[80px] items-center gap-2 shrink-0 md:w-[100px]">
            <div
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: dept.color }}
            />
            <span className="truncate text-xs md:text-sm font-medium text-foreground">
              {dept.name}
            </span>
          </div>
          <div className="flex-1 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(dept.taskCount / maxTasks) * 100}%`,
                backgroundColor: dept.color,
              }}
            />
          </div>
          <span
            className={`text-xs whitespace-nowrap text-right min-w-[60px] md:min-w-[90px] ${
              dept.isImbalanced
                ? "font-semibold text-amber-600 dark:text-amber-400"
                : "text-muted-foreground"
            }`}
          >
            {dept.taskCount} tasks · {dept.staffCount} staff
          </span>
        </div>
      ))}
    </div>
  );
}

/** Staff utilization horizontal bars */
function UtilizationBars({
  staff,
}: {
  staff: StaffUtilizationItem[] | null;
}) {
  if (!staff) {
    return <EmptyState title="Could not load utilization" />;
  }

  if (staff.length === 0) {
    return <EmptyState title="No staff members found" />;
  }

  return (
    <div className="space-y-1">
      {staff.slice(0, 8).map((s) => (
        <div key={s.membershipId} className="flex items-center gap-2.5 py-1">
          <span className="w-[100px] truncate text-sm font-medium text-foreground">
            {s.name}
          </span>
          <div className="flex-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(s.percentage, 100)}%`,
                backgroundColor:
                  s.percentage < 50 ? "#eb6834" : "#2a78d6",
              }}
            />
          </div>
          <span
            className={`w-9 text-right text-xs font-bold ${
              s.percentage < 50
                ? "text-amber-600 dark:text-amber-400"
                : "text-foreground"
            }`}
          >
            {s.percentage}%
          </span>
        </div>
      ))}
    </div>
  );
}
