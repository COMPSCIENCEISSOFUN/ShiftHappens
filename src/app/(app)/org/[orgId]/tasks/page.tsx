/**
 * Tasks Management Page (Boundary Layer)
 *
 * Admin/Manager can view all tasks, create new tasks,
 * assign staff, and manage task lifecycle.
 * Supports filtering by status, department, and priority.
 *
 * Layout (visual overhaul — Phase 13):
 * 1. Page header with title + actions
 * 2. Stat tiles (computed from task list)
 * 3. AI natural-language creation bar
 * 4. Pill-style status filters + department dropdown
 * 5. Create task form (collapsible)
 * 6. Task cards with dept color bars, staffing indicators,
 *    icon-based actions, assignment panels, AI suggestions
 */
"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { Label } from "@/components/ui/label";
import {
  parseRecurrencePattern,
  describeRecurrence,
  type RecurrenceFreq,
} from "@/lib/recurrence";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { AiResultBanner } from "@/components/tasks/ai-result-banner";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import { Clock, Lock, Plus, Sparkles, SquarePen, Trash2, Users, Zap } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import { toDateTimeLocalValue } from "@/lib/timezone";
import { OperatingHoursNotice } from "@/components/tasks/operating-hours-notice";
import { reasonLabel } from "@/lib/decline-reasons";
import {
  DATE_RANGE_MESSAGE,
  parseDateRange,
  withinDateRange,
} from "@/lib/date-range";
import {
  countOccupied,
  remainingSlots as slotsLeft,
  canHoldClockTimes,
} from "@/lib/assignment-status";
import { CompositionRulesEditor } from "@/components/tasks/composition-rules-editor";
import { PendingLeaveFlag } from "@/components/tasks/pending-leave-flag";
import { useAssignData } from "@/components/tasks/use-assign-data";
import {
  annotateSelection,
  describeRule,
  parseCompositionRules,
  type CompositionCandidate,
  type CompositionRule,
} from "@/lib/composition-rules";
import { usePermissions } from "@/components/layout/permission-provider";
import {
  CertificationPicker,
  type CertificationOption,
} from "@/components/certifications/certification-picker";
import { usePlan } from "@/components/layout/plan-provider";
import { LimitNotice } from "@/components/ui/plan-gate";
import { TASK_LIST_READERS } from "@/lib/permissions";
import { cn } from "@/lib/utils";

// ============================================================
// Constants
// ============================================================

/**
 * Runners-up shown beneath the engine's picks, on top of the seats being
 * filled. A FIXED number, not a proportion of headcount.
 *
 * `getSuggestions` applies no cap — it returns every eligible member, ranked.
 * The picks block rendered all of them, so a shift for two in a small demo org
 * showed three rows and looked deliberate, while a shift for five in a
 * thirty-person org would have listed twenty-five. Scaling the allowance with
 * headcount would make the big case worse, not better.
 *
 * Two is enough for the job these rows do: the top pick is occasionally
 * unavailable in a way the engine cannot see, and the manager wants the next
 * name without re-running anything. Beyond that it is a duplicate of the member
 * grid below, where every eligible member already carries their rank and score —
 * and a panel repeating a list it is sitting on top of is the same fault the
 * dashboard's recommendation list had.
 */
const MAX_ALTERNATES = 2;

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

// ============================================================
// Helpers
// ============================================================

/** Readable summary of a stored recurrence pattern, or null if unreadable. */
function describeRecurrenceOf(raw: string | null): string | null {
  const pattern = parseRecurrencePattern(raw);
  return pattern ? describeRecurrence(pattern) : null;
}

/**
 * Adds or removes one certificate name from a selection.
 *
 * Case-insensitive, because that is how eligibility compares them: a task
 * carrying "food safety" from before the list existed must be un-toggled by
 * the "Food Safety" chip rather than gaining a second copy of itself.
 */
function toggleCert(current: string[], name: string): string[] {
  const key = name.trim().toLowerCase();
  const without = current.filter((c) => c.trim().toLowerCase() !== key);
  return without.length === current.length ? [...current, name.trim()] : without;
}

/** Initials from a name string, e.g. "Sarah Lim" → "SL". */
function initials(name: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/** Deterministic avatar colour from a string. */
const AVATAR_COLORS = [
  "bg-indigo-600", "bg-blue-600", "bg-emerald-600", "bg-orange-600",
  "bg-violet-600", "bg-rose-600", "bg-teal-600", "bg-amber-600",
];
function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ============================================================
// Interfaces
// ============================================================

/**
 * Maps a failed check to the `ruleOverridden` key recorded for waiving it.
 *
 * This screen used to post `ruleOverridden: "all"` for every waiver, whatever
 * had actually blocked the member. Two things went wrong with that. The audit
 * could not answer "waved past WHAT", which is most of the value of recording
 * it. And waiving somebody's stated unavailability — a question about consent —
 * became indistinguishable from waiving a missing certificate, which is a
 * question about competence and involves no consent at all. Only the first
 * should turn an assignment into an ask.
 */
const RULE_KEY: Record<string, string> = {
  availability: "availability",
  scheduling: "scheduling",
  workRules: "work_rules",
  hoursLimit: "hours_limit",
  certifications: "certification",
};

/** A ranked replacement for a shift somebody is asking to come off. */
interface CoverOption {
  membershipId: string;
  name: string;
  rank: number;
  score: number;
}

/**
 * Four states, not a list and a boolean.
 *
 * "Not asked yet" and "asked, and nobody is available" are opposite answers and
 * an empty array cannot tell them apart — which matters more here than usual,
 * because **nobody available is the single most useful thing this panel can
 * say**. A manager who reads an empty box as "not loaded" approves the request
 * and finds out afterwards.
 */
type CoverState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; options: CoverOption[] };

/**
 * Ranked cover for the shift under decision.
 *
 * Rendered inside the withdrawal and decline boxes, above the buttons,
 * deliberately: the question a manager is answering is "can I let them off",
 * and the answer to that is on this line rather than on the assign panel they
 * would otherwise have to go and open.
 *
 * It does not offer to assign anybody. Approving is what frees the slot, and
 * the same ranking runs again on approval when the organisation is in `auto`
 * mode — so a button here would either duplicate that or race it.
 */
function CoverOptions({
  state,
  onFind,
}: {
  taskId: string;
  state: CoverState | undefined;
  onFind: () => void;
}) {
  if (!state) {
    return (
      <button
        type="button"
        onClick={onFind}
        className="mt-2 rounded-md border border-orange-300 bg-white/60 px-2.5 py-1 text-[11px] font-medium text-orange-800 hover:bg-white dark:border-orange-800 dark:bg-transparent dark:text-orange-300 dark:hover:bg-orange-950"
      >
        Who could cover?
      </button>
    );
  }

  if (state.status === "loading") {
    return (
      <p className="mt-2 text-[11px] text-orange-700 dark:text-orange-400">
        Checking who is free…
      </p>
    );
  }

  if (state.status === "failed") {
    return (
      <button
        type="button"
        onClick={onFind}
        className="mt-2 rounded-md border border-orange-300 bg-white/60 px-2.5 py-1 text-[11px] font-medium text-orange-800 hover:bg-white dark:border-orange-800 dark:bg-transparent dark:text-orange-300 dark:hover:bg-orange-950"
      >
        Couldn&apos;t check — try again
      </button>
    );
  }

  if (state.options.length === 0) {
    return (
      <p className="mt-2 text-[11px] font-semibold text-orange-900 dark:text-orange-200">
        Nobody else is eligible for this shift.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <p className="text-[11px] text-orange-700 dark:text-orange-400">
        Could cover: {state.options.map((o) => o.name).join(", ")}
      </p>
    </div>
  );
}

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  requiredHeadcount: number;
  requiredCertifications: string[];
  compositionRules: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  isRecurring: boolean;
  recurringPattern: string | null;
  /** Set on tasks generated from a recurring series. */
  parentTaskId: string | null;
  department: { id: string; name: string; color?: string } | null;
  createdBy: { id: string; name: string | null };
  assignments: {
    id: string;
    status: string;
    clockInTime: string | null;
    clockOutTime: string | null;
    withdrawalReason: string | null;
    withdrawalNotes: string | null;
    /** Set once a full-time member has declined, before and after approval. */
    rejectionReason: string | null;
    rejectionNotes: string | null;
    membership: { user: { id: string; name: string | null } };
  }[];
}

interface Department {
  id: string;
  name: string;
  color?: string;
}

interface Member {
  id: string;
  role: string;
  status: string;
  user: { id: string; name: string | null; email: string };
}

// ============================================================
// Main component
// ============================================================

export default function TasksPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  // Recurrence controls on the create form ("" = does not repeat)
  const [repeatFreq, setRepeatFreq] = useState<"" | RecurrenceFreq>("");
  const [repeatInterval, setRepeatInterval] = useState(1);
  const [repeatDays, setRepeatDays] = useState<number[]>([]);
  const [repeatUntil, setRepeatUntil] = useState("");
  /*
   * This page carried no permission checks at all, so every visitor saw every
   * action. Once custom roles became enforceable that produced a real mismatch:
   * a "Shift Lead" granted `tasks:assign` gets the Tasks link, arrives here,
   * and is offered Edit, Delete and the status dropdown — three controls whose
   * endpoints will refuse them.
   *
   * Each flag names the permission the matching route enforces, so what is
   * offered and what will be allowed come from one source.
   */
  const { can, canAny } = usePermissions();
  const plan = usePlan();
  const canCreate = can("tasks:create");
  const canUpdate = can("tasks:update");
  const canDelete = can("tasks:delete");
  const canAssign = can("tasks:assign");
  /*
   * Its own permission, not part of `tasks:assign`. Rostering somebody decides
   * the future; amending a clock time rewrites the record of what already
   * happened, on the field the hours totals are built from.
   */
  const canCorrectClock = can("assignments:correct_clock");

  const canSuggest = can("allocation:use_suggestions");
  const canAutoAllocate = can("allocation:auto_allocate");

  const [assigningTaskId, setAssigningTaskId] = useState<string | null>(null);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  // membershipId → reason, when a manager overrides an ineligible staff member
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({});
  // Shown inside the assign panel — the page-level banner is off-screen there.
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterDept, setFilterDept] = useState("");
  /*
   * The shift-date range. Filtered in the browser, like the two above it: this
   * page already holds every task it can show, so a round trip would buy
   * nothing and would make these three filters work in two different ways.
   *
   * The RULE is shared, though — `parseDateRange` and `withinDateRange`, the
   * same pair the leave register and the certificates page use. What differs
   * between the screens is where the rows come from, not what a date range
   * means, and the timezone half of that is not something to get right three
   * times.
   */
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  /** Which assignment's clock form is open, if any. */
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  /*
   * Everything the assign panel knows about a shift comes from one hook, shared
   * with the calendar's assign modal. Six pieces of state and four fetches used
   * to live here and three of the four had no counterpart on the calendar,
   * which is how assigning from the calendar could build a shift the
   * composition rules would have flagged. See `use-assign-data` for why the
   * fetching is shared and the markup is not.
   */
  const {
    eligibility,
    loadingEligibility,
    composition,
    pendingLeave,
    suggestions,
    loadingSuggestions,
    load: loadAssignData,
    loadSuggestions,
    reset: resetAssignData,
  } = useAssignData(orgId);
  /*
   * Stays here: whether the ranking is on screen is this panel's state, not a
   * fact about the shift. The calendar shows its suggestions always and has no
   * equivalent.
   */
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [naturalInput, setNaturalInput] = useState("");
  const [parsing, setParsing] = useState(false);
  /** Which fields the request never stated. Empty ⇒ no form was needed. */
  const [parseGaps, setParseGaps] = useState<string[]>([]);
  /** True when both providers were down and keywords produced the parse. */
  const [parseDegraded, setParseDegraded] = useState(false);
  /** The task a clean parse just created, for the result banner. */
  const [aiResult, setAiResult] = useState<{
    taskId: string;
    title: string;
    assigned: number;
    required: number;
  } | null>(null);
  const [undoing, setUndoing] = useState(false);
  // "suggested" | "auto" — auto-assign is only offered in "auto" mode.
  // ("manual" was a third mode until 2026-08-13; rows were migrated to
  // "suggested" and the stored value kept its name.)
  const [allocationMode, setAllocationMode] = useState<string>("suggested");
  const [autoAssigningId, setAutoAssigningId] = useState<string | null>(null);
  /**
   * Ranked replacements, keyed by the ASSIGNMENT being decided rather than by
   * the task.
   *
   * A shift can have two people asking to come off it at once, and keying by
   * task would show one manager's answer under the other's request.
   */
  /*
   * Deep link: `/org/<id>/tasks?task=<taskId>`.
   *
   * The assistant, and the dashboard's alerts, name a specific shift and then
   * sent the reader to a list of every shift to find it again — which is the
   * defect the certification alerts already have a comment about ("every one
   * of these alerts names a subset and used to land the reader on All").
   *
   * A parameter rather than a route, because the target is a row on this page
   * and not a page of its own. Nothing here is gated on it: an unknown or
   * filtered-out id simply does not match, and the list renders as normal.
   */
  const searchParams = useSearchParams();
  const focusTaskId = searchParams.get("task");
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const [cover, setCover] = useState<Record<string, CoverState>>({});

  // Operating hours, for the out-of-hours notice. Defaults mirror the database
  // defaults so the notice never compares against a window nobody set.
  const [opStart, setOpStart] = useState(6);
  const [opEnd, setOpEnd] = useState(22);

  // Mirrors of the two schedule inputs on each form. The inputs themselves stay
  // UNCONTROLLED — the AI parser writes into them through the DOM, and making
  // them controlled would mean that write is discarded on the next render.
  // These shadow values exist only to drive the notice, so a stale one costs a
  // warning and never a wrong submission.
  const [createSchedule, setCreateSchedule] = useState({ start: "", end: "" });
  // Composition rules are structured objects, so they are held in state rather
  // than as form fields — FormData would flatten them to strings.
  const [createComposition, setCreateComposition] = useState<CompositionRule[]>([]);
  const [editComposition, setEditComposition] = useState<CompositionRule[]>([]);
  /*
   * Required certificates, for the same reason as the composition rules above:
   * a selection is not a form field. They were a comma-separated text box until
   * the organisation gained a list of recognised names — see
   * `CertificationPicker` for why that box was the bug.
   */
  const [certTypes, setCertTypes] = useState<CertificationOption[]>([]);
  const [createCerts, setCreateCerts] = useState<string[]>([]);
  const [editCerts, setEditCerts] = useState<string[]>([]);
  const [editSchedule, setEditSchedule] = useState({ start: "", end: "" });

  // ── Data fetching ────────────────────────────────

  useEffect(() => {
    fetchTasks();
    fetchDepartments();
    fetchMembers();
    fetchSettings();
    fetchOperatingHours();
    fetchCertificationTypes();
  }, [orgId]);

  /**
   * Loads the task list.
   *
   * The `res.ok` and `Array.isArray` guards are the whole point. A 403 or a 500
   * returns `{ error }` — an OBJECT — and the previous version handed that
   * straight to `setTasks`. Every `tasks.filter(...)` below then threw
   * "tasks.filter is not a function" and the page died with a blank screen and
   * a console stack trace, telling the user nothing about what had gone wrong.
   *
   * The server's own message is surfaced rather than a generic one, because
   * when this fails in a deployed environment that message is the only clue
   * anyone gets.
   */
  /**
   * The organisation's recognised certificates.
   *
   * Readable by any member, because the staff member's own certificate screen
   * shows the same list as suggestions — see the route's docblock. A failure
   * leaves the list empty, and the picker says so rather than rendering an
   * unexplained blank.
   */
  async function fetchCertificationTypes() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/certification-types`);
      if (!res.ok) return;
      setCertTypes(await res.json());
    } catch {
      // Non-fatal: a task can still be created without a certificate
      // requirement, and one already on a task is shown regardless.
    }
  }

  /*
   * Scroll the named shift into view once the list is on screen, and mark it.
   *
   * Depends on `loading` rather than on `tasks`, deliberately: the element
   * cannot exist before the first render that has data, and re-running on
   * every refetch would yank a manager's scroll position back mid-edit — the
   * board refreshes after every assignment.
   *
   * The highlight is temporary and the scroll is not repeated, so this fires
   * once per arrival. `focusTaskId` staying in the URL is intentional: a
   * reload should land in the same place, and stripping it would need a
   * history rewrite for a cosmetic gain.
   */
  useEffect(() => {
    if (loading || !focusTaskId) return;

    const element = document.getElementById(`task-${focusTaskId}`);
    // No match is an ordinary outcome, not a fault: the shift may be filtered
    // out, completed, or in another department. The list renders as normal.
    if (!element) return;

    element.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: the DOM node only exists after the list has rendered, so this cannot be derived during render
    setHighlightId(focusTaskId);

    // Long enough to find with your eye, short enough that it does not read as
    // a permanent state of the row.
    const clear = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(clear);
  }, [loading, focusTaskId]);

  async function fetchTasks() {
    // Any cached "who could cover" answer describes the board as it was before
    // this refetch, so it goes with it.
    forgetCover();
    try {
      const res = await fetch(`/api/organizations/${orgId}/tasks`);
      const data = await res.json();

      if (!res.ok || !Array.isArray(data)) {
        setError(
          typeof data?.error === "string" ? data.error : "Failed to load tasks"
        );
        return;
      }

      setTasks(data);
      setError(null);
      // Returned as well as stored, so a caller that has just created a task
      // can read its staffing back — `setTasks` will not have reached state by
      // the time the next line runs.
      return data as Task[];
    } catch {
      setError("Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }

  async function fetchDepartments() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`);
      const data = await res.json();
      setDepartments(Array.isArray(data) ? data : []);
    } catch {}
  }

  async function fetchSettings() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings`);
      if (!res.ok) return;
      const data = await res.json();
      setAllocationMode(data.allocationMode ?? "suggested");
    } catch {}
  }

  /**
   * Operating hours come from the member-scoped route, not `/settings`, because
   * managers reach this page too and the admin-only read would 403 for them —
   * leaving the out-of-hours notice silently comparing against the 6–22
   * defaults instead of the organisation's actual hours.
   */
  async function fetchOperatingHours() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings/display`);
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.operatingHoursStart === "number") setOpStart(data.operatingHoursStart);
      if (typeof data.operatingHoursEnd === "number") setOpEnd(data.operatingHoursEnd);
    } catch {}
  }

  async function fetchMembers() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/members`);
      const data = await res.json();
      // Same shape trap as fetchTasks. Here the `.filter` threw INSIDE the try,
      // so the empty catch swallowed it and the assign panel simply showed no
      // staff — a failure that looked like an empty organisation.
      if (!res.ok || !Array.isArray(data)) return;
      setMembers(
        data.filter(
          (m: Member) => m.status === "active" && m.role !== "company_admin"
        )
      );
    } catch {}
  }

  /**
   * The AI ranking, on demand.
   *
   * The fetch moved into `useAssignData`; the other three things this does did
   * not, because they are all this panel's business rather than facts about the
   * shift. Toggling the list shut is presentation. Auto-ticking the top
   * candidates depends on how many seats are left and on what the manager has
   * already selected. And the error belongs to the button that was pressed.
   *
   * `null` back from the hook means the request failed; `[]` means it succeeded
   * and ranked nobody, which happens whenever every candidate is already busy.
   * Reporting the second as a failure would train managers to ignore the
   * message.
   */
  async function fetchSuggestions(taskId: string, force = false) {
    // Toggle visibility if already loaded (unless force-fetching)
    if (!force && suggestions.length > 0) {
      setShowSuggestions(!showSuggestions);
      return;
    }

    setShowSuggestions(true);
    const list = await loadSuggestions(taskId);
    if (list === null) {
      setError("Failed to get AI suggestions");
      return;
    }

    // Seats still to fill, NOT the full headcount. Sliced on
    // requiredHeadcount, a shift needing 3 with 1 already assigned
    // auto-selected 3 more — the server refuses that (assignStaff checks
    // currentCount + selected against requiredHeadcount), so the manager met
    // "Assignment exceeds required headcount" after the panel had proposed the
    // over-selection itself.
    const task = tasks.find((t) => t.id === taskId);
    const remaining = task
      ? slotsLeft(task.requiredHeadcount, task.assignments)
      : 1;
    setSelectedMembers(list.slice(0, remaining).map((s) => s.membershipId));
  }

  // ── Handlers ─────────────────────────────────────

  /** Lets the system pick and assign the best-fit staff for a task (US-65). */
  async function onAutoAssign(taskId: string) {
    setError(null);
    setAutoAssigningId(taskId);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/auto-allocate`,
        { method: "POST" }
      );

      if (!res.ok) {
        setError(await readError(res, "Auto-assign failed"));
        return;
      }

      const assignments = await res.json().catch(() => []);
      toast.success(
        `Auto-assigned ${Array.isArray(assignments) ? assignments.length : ""} staff`.trim()
      );
      fetchTasks();
    } catch {
      setError("Something went wrong");
    } finally {
      setAutoAssigningId(null);
    }
  }

  async function onParseNaturalLanguage() {
    if (!naturalInput.trim()) return;
    setParsing(true);
    setError(null);

    try {
      const res = await fetch(`/api/organizations/${orgId}/tasks/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: naturalInput }),
      });

      if (!res.ok) {
        setError("Failed to parse task description");
        return;
      }

      const parsed = await res.json();

      /*
       * The gate: a form only opens when the request left something out.
       *
       * This page always opened one, filled it in, and waited — which reads as
       * a slower way to type a task rather than as automation. The parser now
       * reports what it could not determine, so the ordinary case (a request
       * that says what, when and where) is created and staffed without anybody
       * confirming it, and the form is kept for the cases that genuinely need
       * an answer.
       *
       * `parsedBy: "keywords"` always asks: both providers were down, so the
       * schedule was dropped and the department matched only on a verbatim
       * name. Its own comment in the parser says as much.
       */
      const gaps: string[] = parsed.missing ?? [];
      if (gaps.length === 0 && parsed.parsedBy !== "keywords") {
        await createFromParse(parsed);
        setNaturalInput("");
        return;
      }

      setParseGaps(gaps);
      setParseDegraded(parsed.parsedBy === "keywords");
      setShowCreate(true);
      setNaturalInput("");

      setTimeout(() => {
        const form = document.querySelector("form") as HTMLFormElement;
        if (!form) return;

        const titleInput = form.querySelector('[name="title"]') as HTMLInputElement;
        const descInput = form.querySelector('[name="description"]') as HTMLTextAreaElement;
        const deptSelect = form.querySelector('[name="departmentId"]') as HTMLSelectElement;
        const prioritySelect = form.querySelector('[name="priority"]') as HTMLSelectElement;
        const headcountInput = form.querySelector('[name="requiredHeadcount"]') as HTMLInputElement;
        const startInput = form.querySelector('[name="scheduledStart"]') as HTMLInputElement;
        const endInput = form.querySelector('[name="scheduledEnd"]') as HTMLInputElement;

        if (titleInput) titleInput.value = parsed.title || "";
        if (descInput) descInput.value = parsed.description || "";
        if (deptSelect && parsed.departmentId) deptSelect.value = parsed.departmentId;
        if (prioritySelect) prioritySelect.value = parsed.priority || "medium";
        if (headcountInput) headcountInput.value = String(parsed.requiredHeadcount || 1);
        // slice(0, 16) used to strip the offset and hand the UTC wall clock to
        // a local input — wrong, but it cancelled the parser emitting local
        // times labelled as UTC. Both sides are now correct: the parser returns
        // a true instant, and this converts it to the viewer's local time.
        if (startInput && parsed.scheduledStart) {
          startInput.value = toDateTimeLocalValue(new Date(parsed.scheduledStart));
        }
        if (endInput && parsed.scheduledEnd) {
          endInput.value = toDateTimeLocalValue(new Date(parsed.scheduledEnd));
        }
        // Writing `.value` through the DOM does not fire React's onChange, so
        // the notice would otherwise keep judging the previous times — or none
        // at all — after the parser filled the form in.
        setCreateSchedule({
          start: startInput?.value ?? "",
          end: endInput?.value ?? "",
        });
      }, 100);
    } catch {
      setError("Something went wrong");
    } finally {
      setParsing(false);
    }
  }

  /**
   * Create straight from a clean parse, then say what happened.
   *
   * Staffing is read back from a refreshed list rather than from the create
   * response: allocation runs inside `TaskService.create`, so the row it
   * returns predates it and would report nobody assigned on a shift the engine
   * had just filled.
   */
  async function createFromParse(parsed: {
    title: string;
    description?: string | null;
    departmentId?: string | null;
    priority?: string;
    requiredHeadcount?: number;
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
  }) {
    try {
      const res = await fetch(`/api/organizations/${orgId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: parsed.title,
          description: parsed.description || undefined,
          departmentId: parsed.departmentId || undefined,
          priority: parsed.priority || "medium",
          requiredHeadcount: parsed.requiredHeadcount || 1,
          scheduledStart: parsed.scheduledStart ?? undefined,
          scheduledEnd: parsed.scheduledEnd ?? undefined,
        }),
      });
      const created = await res.json().catch(() => null);
      if (!res.ok || !created?.id) {
        setError(created?.error || "Could not create the task");
        return;
      }

      const refreshed = await fetchTasks();
      const placed = refreshed?.find((task) => task.id === created.id);
      // The shared rule, like everywhere else that counts a shift's people: a
      // rejected row is a row with nobody on it.
      const assigned = placed ? countOccupied(placed.assignments) : 0;

      setAiResult({
        taskId: created.id,
        title: created.title,
        assigned,
        required: placed?.requiredHeadcount ?? parsed.requiredHeadcount ?? 1,
      });
    } catch {
      setError("Could not create the task");
    }
  }

  /** Remove a task the AI just made. Assigned staff are told it is cancelled. */
  async function undoAiResult() {
    if (!aiResult) return;
    setUndoing(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${aiResult.taskId}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error || "Could not undo — delete it from the list instead");
        return;
      }
      setAiResult(null);
      await fetchTasks();
    } catch {
      setError("Could not undo — delete it from the list instead");
    } finally {
      setUndoing(false);
    }
  }

  async function onCreateTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A double click used to POST twice, and for a repeating task that meant two
    // full series of generated occurrences to clean up by hand. Checked here as
    // well as on the button because the second click lands before React
    // repaints `disabled`.
    if (creating) return;

    const form = event.currentTarget;
    setError(null);

    const formData = new FormData(form);

    const taskData: Record<string, unknown> = {
      title: formData.get("title"),
      description: formData.get("description") || undefined,
      departmentId: formData.get("departmentId") || undefined,
      priority: formData.get("priority"),
      requiredHeadcount: Number(formData.get("requiredHeadcount")) || 1,
    };

    /*
     * Required certifications come from component state, not the form.
     *
     * They were a comma-separated text box until the organisation gained a list
     * of recognised certificates — see `CertificationPicker`. Same reason the
     * composition rules below are not in the form: a FormData round-trip would
     * flatten a structured selection into a string.
     */
    if (createCerts.length > 0) taskData.requiredCertifications = createCerts;

    // Composition rules live in component state rather than the form, because
    // they are structured objects and a FormData round-trip would flatten them.
    if (createComposition.length > 0) taskData.compositionRules = createComposition;

    const start = formData.get("scheduledStart") as string;
    const end = formData.get("scheduledEnd") as string;
    if (start) taskData.scheduledStart = new Date(start).toISOString();
    if (end) taskData.scheduledEnd = new Date(end).toISOString();

    // Recurrence — the schedule defines the time-of-day every occurrence inherits,
    // so a repeating task must have one.
    if (repeatFreq) {
      if (!start || !end) {
        setError("A repeating task needs a start and end time");
        return;
      }

      const pattern: Record<string, unknown> = {
        freq: repeatFreq,
        interval: repeatInterval || 1,
      };
      if (repeatFreq === "weekly" && repeatDays.length > 0) {
        pattern.days = [...repeatDays].sort((a, b) => a - b);
      }
      if (repeatUntil) pattern.until = repeatUntil;

      taskData.isRecurring = true;
      taskData.recurringPattern = JSON.stringify(pattern);
    }

    setCreating(true);

    try {
      const res = await fetch(`/api/organizations/${orgId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskData),
      });

      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(result.error || "Failed to create task");
        return;
      }

      setShowCreate(false);
      // The parser's question has been answered by creating the task.
      setParseGaps([]);
      setParseDegraded(false);
      /*
       * Clear the selections the form does NOT own.
       *
       * The text inputs are reset by React when the form unmounts; these two
       * live in component state, so without this the next task opened the form
       * already carrying the previous one's certificate requirements and
       * composition rules — silently, since both render as chips rather than as
       * text somebody would notice.
       */
      setCreateCerts([]);
      setCreateComposition([]);
      toast.success(
        repeatFreq
          ? "Recurring task created — upcoming occurrences generated"
          : "Task created successfully"
      );
      form.reset();
      setRepeatFreq("");
      setRepeatInterval(1);
      setRepeatDays([]);
      setRepeatUntil("");
      fetchTasks();
    } catch {
      setError("Something went wrong");
    } finally {
      setCreating(false);
    }
  }

  /**
   * Pulls an error message out of a failed response. A failing response is not
   * guaranteed to carry a JSON body (a routing 404 has none), so parsing must
   * never throw — otherwise the real reason is swallowed.
   */
  async function readError(res: Response, fallback: string): Promise<string> {
    const body = await res.json().catch(() => null);
    return body?.error || `${fallback} (HTTP ${res.status})`;
  }

  async function onAssignStaff(taskId: string) {
    setAssignError(null);

    /*
     * One at a time.
     *
     * This handler writes override records and then assigns, so a double-click
     * fired two overlapping runs: the second reached `assign` after the first
     * had created rows, hit the unique constraint on (taskId, membershipId),
     * and reported a failure over a assignment that had in fact succeeded.
     * `my-tasks` guards its actions this way already.
     */
    if (assigning) return;
    setAssigning(true);
    try {
      await runAssign(taskId);
    } finally {
      setAssigning(false);
    }
  }

  async function runAssign(taskId: string) {
    if (selectedMembers.length === 0) {
      setAssignError("Select at least one member");
      return;
    }
    setError(null);

    // Any selected member that is ineligible must have an override reason.
    const missingReason = selectedMembers.find((id) => {
      const elig = eligibility[id];
      return elig && !elig.eligible && !overrideReasons[id]?.trim();
    });
    if (missingReason) {
      setAssignError("Provide an override reason for each flagged staff member");
      return;
    }

    try {
      // Record eligibility overrides for flagged members before assigning.
      // One row per rule actually broken, so the audit says what was waived and
      // `assignStaff` can tell a consent waiver from a competence one.
      for (const membId of selectedMembers) {
        const elig = eligibility[membId];
        const reason = overrideReasons[membId]?.trim();
        if (!elig || elig.eligible || !reason) continue;

        const broken = Object.keys(RULE_KEY).filter(
          (k) => elig.checks[k] && !elig.checks[k].eligible
        );

        /*
         * A member flagged with no identifiable failed check still gets a row.
         * Composition and other whole-roster rules block from outside `checks`,
         * and dropping the override would leave the assignment unauthorised —
         * `assignStaff` refuses it, so the manager would see a rejection with no
         * way to act on it.
         */
        const rules = broken.length > 0 ? broken.map((k) => RULE_KEY[k]) : ["all"];

        for (const ruleOverridden of rules) {
          const ovRes = await fetch(
            `/api/organizations/${orgId}/tasks/${taskId}/eligibility/override`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ membershipId: membId, reason, ruleOverridden }),
            }
          );
          if (!ovRes.ok) {
            setAssignError(await readError(ovRes, "Failed to record override"));
            return;
          }
        }
      }

      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/assign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ membershipIds: selectedMembers }),
        }
      );

      if (!res.ok) {
        setAssignError(await readError(res, "Failed to assign staff"));
        return;
      }

      setAssigningTaskId(null);
      setSelectedMembers([]);
      setOverrideReasons({});
      setAssignError(null);
      toast.success("Staff assigned successfully");
      fetchTasks();
    } catch (err) {
      setAssignError(
        err instanceof Error ? err.message : "Something went wrong"
      );
    }
  }

  async function onDeleteTask(taskId: string) {
    if (!confirm("Are you sure you want to delete this task?")) return;
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        const result = await res.json();
        setError(result.error || "Failed to delete task");
        return;
      }

      fetchTasks();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onUpdateStatus(taskId: string, status: string) {
    setError(null);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }
      );

      if (!res.ok) {
        const result = await res.json();
        setError(result.error || "Failed to update status");
        return;
      }

      fetchTasks();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onUpdateTask(event: React.FormEvent<HTMLFormElement>, taskId: string) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);

    const updateData: Record<string, unknown> = {
      title: formData.get("editTitle"),
      description: formData.get("editDescription") || undefined,
      departmentId: formData.get("editDepartment") || undefined,
      priority: formData.get("editPriority"),
      requiredHeadcount: Number(formData.get("editHeadcount")) || 1,
      // Always send the parsed list so clearing the field removes requirements.
      requiredCertifications: editCerts,
      // Sent unconditionally for the same reason: an omitted key means "leave
      // them alone", so removing the last rule would otherwise never save.
      compositionRules: editComposition,
    };

    const start = formData.get("editStart") as string;
    const end = formData.get("editEnd") as string;
    if (start) updateData.scheduledStart = new Date(start).toISOString();
    if (end) updateData.scheduledEnd = new Date(end).toISOString();

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updateData),
        }
      );

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to update task");
        return;
      }

      setEditingTaskId(null);
      toast.success("Task updated");
      fetchTasks();
    } catch {
      setError("Something went wrong");
    }
  }

  /**
   * Amend a recorded clock pair.
   *
   * Times are read from `datetime-local` inputs, which give a wall-clock string
   * with no zone. `new Date(...)` on that is the BROWSER's zone, which is what
   * the manager typed and meant — the same treatment the task scheduling form
   * already uses, and the reason the value is converted here rather than being
   * posted as text for the server to guess at.
   */
  async function onCorrectClock(
    assignmentId: string,
    values: { clockIn: string; clockOut: string; reason: string }
  ) {
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/assignments/${assignmentId}/clock`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clockInTime: values.clockIn
              ? new Date(values.clockIn).toISOString()
              : null,
            clockOutTime: values.clockOut
              ? new Date(values.clockOut).toISOString()
              : null,
            reason: values.reason,
          }),
        }
      );

      if (!res.ok) {
        setError(await readError(res, "Failed to correct the clock time"));
        return;
      }

      setCorrectingId(null);
      fetchTasks();
    } catch {
      setError("Failed to correct the clock time");
    }
  }

  async function onCancelAssignment(assignmentId: string) {
    if (!confirm("Are you sure you want to unassign this staff member?")) return;
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/assignments/${assignmentId}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        const result = await res.json();
        setError(result.error || "Failed to cancel assignment");
        return;
      }

      fetchTasks();
    } catch {
      setError("Something went wrong");
    }
  }

  /**
   * Who could take this shift, for the manager deciding whether to release
   * somebody from it.
   *
   * On demand rather than on render. Several requests can be open on one board
   * and this is a ranking pass over every eligible member, so fetching them all
   * because a page loaded would spend the work on requests nobody is currently
   * answering. One press, once per assignment — the answer is cached until the
   * page refetches, because nothing about it changes while the manager reads
   * it.
   */
  /**
   * Forget every cached ranking.
   *
   * Called whenever the board is refetched. Without it the cache was never
   * invalidated at all: a manager who checked cover, denied the request, and
   * met the same request an hour later was shown the hour-old answer — and
   * keying by assignment id makes that MORE likely, not less, because denying a
   * withdrawal reverts the row and keeps its id.
   */
  function forgetCover() {
    setCover({});
  }

  async function findCover(assignmentId: string, taskId: string) {
    setCover((prev) => ({ ...prev, [assignmentId]: { status: "loading" } }));
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/cover-options`
      );
      if (!res.ok) {
        setCover((prev) => ({ ...prev, [assignmentId]: { status: "failed" } }));
        return;
      }
      const body = await res.json();
      setCover((prev) => ({
        ...prev,
        [assignmentId]: {
          status: "ready",
          options: Array.isArray(body?.options) ? body.options : [],
        },
      }));
    } catch {
      setCover((prev) => ({ ...prev, [assignmentId]: { status: "failed" } }));
    }
  }

  async function onResolveWithdrawal(
    assignmentId: string,
    decision: "approve" | "deny"
  ) {
    setError(null);
    try {
      const res = await fetch(
        `/api/assignments/${assignmentId}/withdrawal?orgId=${orgId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        }
      );
      if (!res.ok) {
        const result = await res.json();
        setError(result.error || "Failed to resolve withdrawal");
        return;
      }
      fetchTasks();
    } catch {
      setError("Something went wrong");
    }
  }

  /**
   * Resolve a full-time member's decline request.
   *
   * Separate endpoint from the withdrawal decision, and separate handler,
   * because the two resolve different states — see `decline_requested` in
   * `src/lib/assignment-status.ts`. Denying a withdrawal returns the row to
   * accepted; denying a decline returns it to pending.
   */
  async function onResolveDecline(
    assignmentId: string,
    decision: "approve" | "deny"
  ) {
    setError(null);
    try {
      const res = await fetch(
        `/api/assignments/${assignmentId}/decline?orgId=${orgId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        }
      );
      if (!res.ok) {
        const result = await res.json();
        setError(result.error || "Failed to resolve decline");
        return;
      }
      fetchTasks();
    } catch {
      setError("Something went wrong");
    }
  }

  function toggleMemberSelection(membId: string) {
    setSelectedMembers((prev) =>
      prev.includes(membId)
        ? prev.filter((id) => id !== membId)
        : [...prev, membId]
    );
  }

  // ── Derived filtered lists ────────────────────────
  // Always fetch ALL tasks; filter client-side so pill counts stay accurate.

  const deptTasks = filterDept
    ? tasks.filter((t) => t.department?.id === filterDept)
    : tasks;

  const statusTasks = filterStatus
    ? deptTasks.filter((t) => t.status === filterStatus)
    : deptTasks;

  /*
   * A reversed range narrows NOTHING rather than everything.
   *
   * `withinDateRange` returns true for a range carrying a problem, so a
   * half-typed "to" before the "from" leaves the list alone while the notice
   * below explains itself. Filtering on it would empty the screen, and an empty
   * screen reads as "there is no work that week" — the wrong answer, delivered
   * confidently.
   *
   * An unscheduled task is OUT whenever a range is set: it is not in August,
   * and including it because it has no date to exclude it by would put every
   * unscheduled task in every range at once.
   */
  const dateRange = parseDateRange(filterFrom, filterTo);
  const displayedTasks = statusTasks.filter((t) =>
    withinDateRange(t.scheduledStart, dateRange)
  );

  // ── Computed stats ───────────────────────────────
  // Stat tiles: global (all tasks, no filters).
  const openCount = tasks.filter((t) => t.status === "open").length;
  const inProgressCount = tasks.filter((t) => t.status === "in_progress").length;
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const needsStaffCount = tasks.filter(
    (t) => t.status === "open" && countOccupied(t.assignments) < t.requiredHeadcount
  ).length;

  // Filter pill counts: scoped to current department so "All" is consistent.
  const statusCounts: Record<string, number> = {
    "": deptTasks.length,
    open: deptTasks.filter((t) => t.status === "open").length,
    in_progress: deptTasks.filter((t) => t.status === "in_progress").length,
    completed: deptTasks.filter((t) => t.status === "completed").length,
    cancelled: deptTasks.filter((t) => t.status === "cancelled").length,
  };

  // ── Loading state ────────────────────────────────

  /*
   * Placed BELOW every hook, deliberately — a guard above them makes each
   * useState and useEffect conditional, which React forbids.
   *
   * The permission set is the same constant the GET route enforces, so the
   * page and the endpoint refuse for the same reason. Stating it twice is how
   * the sidebar and the routes came to disagree in the first place.
   */
  if (!canAny(...TASK_LIST_READERS)) {
    return (
      <EmptyState
        icon={Lock}
        title="You don't have access to Tasks"
        description="Managing shifts requires one of the task permissions. Ask a company admin if you need access."
      />
    );
  }

  if (loading) return <PageLoading />;

  // ════════════════════════════════════════════════════════════
  //  R E N D E R
  // ════════════════════════════════════════════════════════════

  return (
    <div>
      {/* ──────────────────────────────────────────────── */}
      {/* 1. Page header                                   */}
      {/* ──────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Tasks</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Manage and assign shifts across your organization
          </p>
        </div>
        <div className="flex gap-2">
          {canCreate && <LimitNotice resource="active_tasks" noun="active tasks" />}
          {canCreate && (
            /*
              The cap counts tasks that are neither completed nor cancelled, so
              finishing work frees capacity — which is why the figure beside
              this button says "active tasks" rather than "tasks".
            */
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={!showCreate && plan.atLimit("active_tasks")}
              onClick={() => {
                // A form opened by hand is not answering the parser, so the
                // "I could not work out…" line goes with it. Left behind, it
                // would ask about a request nobody made.
                setParseGaps([]);
                setParseDegraded(false);
                setShowCreate(!showCreate);
              }}
            >
              {showCreate ? (
                "Cancel"
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Create Task
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* ──────────────────────────────────────────────── */}
      {/* 2. Stat tiles                                    */}
      {/* ──────────────────────────────────────────────── */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {/* Total */}
        <div className="relative overflow-hidden rounded-xl border border-border bg-card p-4">
          <div className="absolute right-0 top-0 h-12 w-12 rounded-bl-[48px] bg-indigo-500/[0.08]" />
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Total Tasks</p>
          <p className="mt-1 text-2xl font-bold tracking-tight">{tasks.length}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            across {departments.length} department{departments.length !== 1 ? "s" : ""}
          </p>
        </div>
        {/* Open */}
        <div className="relative overflow-hidden rounded-xl border border-border bg-card p-4">
          <div className="absolute right-0 top-0 h-12 w-12 rounded-bl-[48px] bg-blue-500/[0.08]" />
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Open</p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-blue-600 dark:text-blue-400">{openCount}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {needsStaffCount > 0
              ? `${needsStaffCount} need${needsStaffCount !== 1 ? "" : "s"} staff`
              : "all staffed"}
          </p>
        </div>
        {/* In progress */}
        <div className="relative overflow-hidden rounded-xl border border-border bg-card p-4">
          <div className="absolute right-0 top-0 h-12 w-12 rounded-bl-[48px] bg-amber-500/[0.08]" />
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">In Progress</p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400">{inProgressCount}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">active now</p>
        </div>
        {/* Completed */}
        <div className="relative overflow-hidden rounded-xl border border-border bg-card p-4">
          <div className="absolute right-0 top-0 h-12 w-12 rounded-bl-[48px] bg-emerald-500/[0.08]" />
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Completed</p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">{completedCount}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">this period</p>
        </div>
      </div>

      {/* ──────────────────────────────────────────────── */}
      {/* 3. AI natural-language creation bar              */}
      {/* ──────────────────────────────────────────────── */}
      <div className="mb-4 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-1 transition-shadow focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500/10 dark:focus-within:border-indigo-500 dark:focus-within:ring-indigo-400/10">
        {/* Sparkle icon */}
        <Sparkles className="h-[18px] w-[18px] shrink-0 text-indigo-500" aria-hidden="true" />
        <Input
          placeholder='Try: "I need 2 kitchen staff tomorrow morning for prep"'
          value={naturalInput}
          onChange={(e) => setNaturalInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onParseNaturalLanguage();
          }}
          className="flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
        <Button
          size="sm"
          onClick={onParseNaturalLanguage}
          disabled={parsing || !naturalInput.trim()}
          className={cn(PRIMARY_BUTTON, "shrink-0")}
        >
          {parsing ? "Parsing..." : "AI Create"}
        </Button>
      </div>

      {/*
        What the last AI Create actually did. Shown instead of a confirmation
        step, not as well as one: a clean request is created and staffed
        immediately, and this is where somebody finds out and can take it back.
      */}
      {aiResult && (
        <AiResultBanner
          title={aiResult.title}
          assigned={aiResult.assigned}
          required={aiResult.required}
          undoing={undoing}
          onUndo={undoAiResult}
          onDismiss={() => setAiResult(null)}
        />
      )}

      {/* ──────────────────────────────────────────────── */}
      {/* Alerts                                           */}
      {/* ──────────────────────────────────────────────── */}
      {error && <AlertBanner message={error} variant="error" className="mb-4" />}

      {/* ──────────────────────────────────────────────── */}
      {/* 4. Filters — pill buttons + department dropdown  */}
      {/* ──────────────────────────────────────────────── */}
      <div className="mb-5 flex items-center gap-2 overflow-x-auto pb-1">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilterStatus(f.value)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-all ${
              filterStatus === f.value
                ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-300"
                : "border-border bg-card text-muted-foreground hover:border-indigo-300 hover:text-indigo-600 dark:hover:border-indigo-600 dark:hover:text-indigo-400"
            }`}
          >
            {f.label}
            <span
              className={`inline-flex min-w-[18px] items-center justify-center rounded-full px-1 py-0 text-[11px] font-bold ${
                filterStatus === f.value
                  ? "bg-indigo-600 text-white dark:bg-indigo-500"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {statusCounts[f.value] ?? 0}
            </span>
          </button>
        ))}

        <div className="mx-1 h-6 w-px shrink-0 bg-border" />

        <input
          type="date"
          value={filterFrom}
          max={filterTo || undefined}
          onChange={(e) => setFilterFrom(e.target.value)}
          aria-label="Shifts on or after"
          className="h-[34px] shrink-0 rounded-full border border-border bg-card px-3 text-[13px] text-muted-foreground transition-colors hover:border-indigo-300 dark:hover:border-indigo-600"
        />
        <input
          type="date"
          value={filterTo}
          min={filterFrom || undefined}
          onChange={(e) => setFilterTo(e.target.value)}
          aria-label="Shifts on or before"
          className="h-[34px] shrink-0 rounded-full border border-border bg-card px-3 text-[13px] text-muted-foreground transition-colors hover:border-indigo-300 dark:hover:border-indigo-600"
        />
        {(filterFrom || filterTo) && (
          <button
            type="button"
            onClick={() => {
              setFilterFrom("");
              setFilterTo("");
            }}
            className="shrink-0 rounded-full px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Clear dates
          </button>
        )}

        <div className="mx-1 h-6 w-px shrink-0 bg-border" />

        <select
          className="shrink-0 appearance-none rounded-full border border-border bg-card py-1.5 pl-3 pr-7 text-[13px] text-muted-foreground transition-colors hover:border-indigo-300 dark:hover:border-indigo-600"
          value={filterDept}
          onChange={(e) => setFilterDept(e.target.value)}
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "right 8px center",
          }}
        >
          <option value="">All departments</option>
          {departments.map((dept) => (
            <option key={dept.id} value={dept.id}>{dept.name}</option>
          ))}
        </select>
      </div>

      {/*
        Said out loud, rather than left to be inferred from an empty list. The
        list is deliberately unfiltered while this shows, so the reader can see
        their range is the problem and not the data.
      */}
      {dateRange.problem && (
        <AlertBanner
          message={DATE_RANGE_MESSAGE[dateRange.problem]}
          variant="error"
          className="mb-4"
        />
      )}

      {/* ──────────────────────────────────────────────── */}
      {/* 5. Create task form (collapsible)                */}
      {/* ──────────────────────────────────────────────── */}
      {showCreate && canCreate && (
        <div className="task-create-form mb-5 rounded-xl border border-border bg-card">
          <div className="border-t-[3px] border-t-indigo-600 rounded-t-xl" />
          <form onSubmit={onCreateTask} className="p-5">
            <p className="mb-5 flex items-center gap-2 text-base font-bold">
              <Plus className="h-[18px] w-[18px] text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
              New Task
            </p>

            {/*
              Only present when AI Create could not answer something. It names
              the field rather than saying "check this" — a form that asks for
              a review of nothing in particular is one people learn to skip.
            */}
            {(parseGaps.length > 0 || parseDegraded) && (
              <div className="mb-5 rounded-lg border border-indigo-200 bg-indigo-50/70 px-3 py-2 dark:border-indigo-900 dark:bg-indigo-950/40">
                <p className="text-xs font-medium text-indigo-900 dark:text-indigo-200">
                  {parseGaps.includes("schedule") && parseGaps.includes("department")
                    ? "I could not work out when this should happen or which department it belongs to — fill those in and I will staff it."
                    : parseGaps.includes("schedule")
                      ? "I could not work out when this should happen — give me a start and end and I will staff it."
                      : parseGaps.includes("department")
                        ? "I could not tell which department this belongs to — pick one and I will staff it."
                        : parseGaps.includes("title")
                          ? "I could not work out a title for this — name it and I will staff it."
                          : "Check this before creating it."}
                </p>
                {parseDegraded && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                    AI was unavailable, so this was filled in from keywords —
                    dates and departments are likely to be missing.
                  </p>
                )}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="title" className="text-xs font-semibold text-muted-foreground">Title</Label>
                <Input id="title" name="title" required placeholder="e.g. Morning prep — salad station" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="description" className="text-xs font-semibold text-muted-foreground">Description</Label>
                <textarea
                  id="description"
                  name="description"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px] focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/10"
                  placeholder="What needs to be done..."
                />
              </div>
              {/*
                ── The three short answers, on one line ──

                Department, Priority and Headcount are a select, a select and a
                number. In the outer two-column grid the third one landed beside
                the certification picker, so a one-line input sat next to a
                block five rows tall and left a hole under itself. Their own
                three-column row keeps short things with short things.
              */}
              <div className="grid gap-4 sm:col-span-2 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="departmentId" className="text-xs font-semibold text-muted-foreground">Department</Label>
                <select
                  id="departmentId"
                  name="departmentId"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">No department</option>
                  {departments.map((dept) => (
                    <option key={dept.id} value={dept.id}>{dept.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="priority" className="text-xs font-semibold text-muted-foreground">Priority</Label>
                <select
                  id="priority"
                  name="priority"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  defaultValue="medium"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="requiredHeadcount" className="text-xs font-semibold text-muted-foreground">Required headcount</Label>
                <Input id="requiredHeadcount" name="requiredHeadcount" type="number" min={1} max={50} defaultValue={1} />
              </div>
              </div>
              {/*
                ── Where the shift sits in time ──

                Start and End are ONE decision and belong side by side. They
                were separated by the two tall fields above them: a two-column
                grid gives every child one cell, so the certification picker and
                the composition editor — both several rows high — pushed Start
                to the right of one row and End to the left of the next.
                Diagonally opposite, with the thing they bracket in between.
              */}
              <div className="space-y-1.5">
                <Label htmlFor="scheduledStart" className="text-xs font-semibold text-muted-foreground">Start time</Label>
                <Input
                  id="scheduledStart"
                  name="scheduledStart"
                  type="datetime-local"
                  onChange={(e) =>
                    setCreateSchedule((s) => ({ ...s, start: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="scheduledEnd" className="text-xs font-semibold text-muted-foreground">End time</Label>
                <Input
                  id="scheduledEnd"
                  name="scheduledEnd"
                  type="datetime-local"
                  onChange={(e) =>
                    setCreateSchedule((s) => ({ ...s, end: e.target.value }))
                  }
                />
              </div>
              <div className="sm:col-span-2">
                <OperatingHoursNotice
                  start={createSchedule.start}
                  end={createSchedule.end}
                  operatingHoursStart={opStart}
                  operatingHoursEnd={opEnd}
                />
              </div>

              {/*
                ── The two wide ones, full width ──

                A chip cloud and a rule builder. Both grow — the picker with the
                number of recognised certificates, the editor with each rule
                added — so pairing either with a single-line field guarantees
                one of the two looks abandoned. Given the whole row they simply
                use it.
              */}
              <div className="space-y-1.5 sm:col-span-2">
                <CertificationPicker
                  options={certTypes}
                  selected={createCerts}
                  onToggle={(name) => setCreateCerts(toggleCert(createCerts, name))}
                  orgId={orgId}
                  canManageList={can("certifications:review")}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <CompositionRulesEditor
                  rules={createComposition}
                  onChange={setCreateComposition}
                />
              </div>

              {/* ─── Recurrence ─────────────────────── */}
              <div className="space-y-3 rounded-lg border border-border p-3.5 sm:col-span-2">
                <div className="space-y-1.5">
                  <Label htmlFor="repeatFreq" className="text-xs font-semibold text-muted-foreground">Repeats</Label>
                  <select
                    id="repeatFreq"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm sm:w-48"
                    value={repeatFreq}
                    onChange={(e) => setRepeatFreq(e.target.value as "" | RecurrenceFreq)}
                  >
                    <option value="">Does not repeat</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>

                {repeatFreq && (
                  <>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Every</span>
                      <Input
                        type="number"
                        min={1}
                        max={52}
                        value={repeatInterval}
                        onChange={(e) => setRepeatInterval(Number(e.target.value) || 1)}
                        className="h-8 w-20"
                      />
                      <span className="text-muted-foreground">
                        {repeatFreq === "daily"
                          ? repeatInterval > 1 ? "days" : "day"
                          : repeatFreq === "weekly"
                            ? repeatInterval > 1 ? "weeks" : "week"
                            : repeatInterval > 1 ? "months" : "month"}
                      </span>
                    </div>

                    {repeatFreq === "weekly" && (
                      <div className="space-y-1.5">
                        <Label className="text-[11px] text-muted-foreground">On these days (defaults to the start day)</Label>
                        <div className="flex flex-wrap gap-1.5">
                          {WEEKDAYS.map((d) => {
                            const on = repeatDays.includes(d.value);
                            return (
                              <button
                                key={d.value}
                                type="button"
                                onClick={() =>
                                  setRepeatDays((prev) =>
                                    prev.includes(d.value)
                                      ? prev.filter((x) => x !== d.value)
                                      : [...prev, d.value]
                                  )
                                }
                                className={`flex h-[30px] w-[34px] items-center justify-center rounded-md border text-xs font-medium transition-colors ${
                                  on
                                    ? "border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500"
                                    : "border-border hover:bg-muted"
                                }`}
                              >
                                {d.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {repeatFreq === "monthly" && (
                      <p className="text-[11px] text-muted-foreground">
                        Repeats on the same day of the month as the start date. Months without that day are skipped.
                      </p>
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor="repeatUntil" className="text-[11px] text-muted-foreground">Until (optional)</Label>
                      <Input
                        id="repeatUntil"
                        type="date"
                        value={repeatUntil}
                        onChange={(e) => setRepeatUntil(e.target.value)}
                        className="h-8 w-44"
                      />
                    </div>

                    <p className="text-[11px] text-muted-foreground">
                      Occurrences are created about 2 weeks ahead and topped up over time, so a long series won&apos;t flood your task list.
                    </p>
                  </>
                )}
              </div>

              <div className="flex gap-2 pt-1 sm:col-span-2">
                <Button type="submit" disabled={creating} className={PRIMARY_BUTTON}>
                  {creating ? "Creating…" : "Create Task"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={creating}
                  onClick={() => {
                    setParseGaps([]);
                    setParseDegraded(false);
                    setShowCreate(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* ──────────────────────────────────────────────── */}
      {/* 6. Task list                                     */}
      {/* ──────────────────────────────────────────────── */}
      {displayedTasks.length === 0 ? (
        <EmptyState title="No tasks found" description="Create a task to get started, or adjust your filters." />
      ) : (
        <div className="flex flex-col gap-3">
          {displayedTasks.map((task) => {
            const deptColor = task.department?.color || "#6366f1";
            // Rows that still hold a slot — NOT assignments.length.
            //
            // Counting every row meant a shift both assignees had REJECTED
            // rendered "2/3 staff" with an amber bar, while the dashboard read
            // the same shift as "needs 3 more staff (0/3 assigned)". Same data,
            // same moment, two numbers.
            const assigned = countOccupied(task.assignments);
            const needed = task.requiredHeadcount;
            const fillPct = needed > 0 ? Math.min(100, Math.round((assigned / needed) * 100)) : 0;
            const staffingClass =
              assigned >= needed
                ? "text-emerald-600 dark:text-emerald-400"
                : assigned > 0
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-500 dark:text-red-400";
            const barFillClass =
              assigned >= needed
                ? "bg-emerald-500"
                : assigned > 0
                  ? "bg-amber-500"
                  : "bg-red-500";
            const isCompleted = task.status === "completed" || task.status === "cancelled";
            const hasWithdrawal = task.assignments.some((a) => a.status === "withdrawal_requested");

            return (
              <div
                key={task.id}
                id={`task-${task.id}`}
                className={`group overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-sm ${
                  isCompleted ? "opacity-70" : ""
                } ${
                  highlightId === task.id
                    ? "border-indigo-500 ring-2 ring-indigo-500/30"
                    : "border-border"
                }`}
              >
                <div className="flex">
                  {/* Department colour bar */}
                  <div className="w-1.5 shrink-0 rounded-l-xl" style={{ backgroundColor: deptColor }} />

                  <div className="min-w-0 flex-1 px-4 py-4 sm:px-5">
                    {/* ── Title ───────────────────── */}
                    <h3 className="truncate text-base font-semibold tracking-tight">{task.title}</h3>

                    {/* ── Badges ──────────────────── */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <StatusBadge value={task.status} palette="taskStatus" />
                      <StatusBadge value={task.priority} palette="priority" />
                      {task.isRecurring && (
                        <span
                          className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300"
                          title={describeRecurrenceOf(task.recurringPattern) ?? undefined}
                        >
                          ↻ {describeRecurrenceOf(task.recurringPattern) ?? "repeats"}
                        </span>
                      )}
                      {task.parentTaskId && (
                        <span className="rounded-full border border-violet-200 bg-violet-50/60 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-400">
                          ↻ from series
                        </span>
                      )}
                    </div>

                    {/* ── Meta row ────────────────── */}
                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-muted-foreground">
                      {/* Department */}
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: deptColor }} />
                        {task.department?.name || "No department"}
                      </span>

                      {/* Schedule */}
                      {task.scheduledStart && (
                        <span className="flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
                          {new Date(task.scheduledStart).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          {task.scheduledEnd && (
                            <> — {new Date(task.scheduledEnd).toLocaleString([], { hour: "numeric", minute: "2-digit" })}</>
                          )}
                        </span>
                      )}

                      {/* Staffing */}
                      <span className="flex items-center gap-2">
                        <span className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-muted">
                          <span className={`block h-full rounded-full ${barFillClass}`} style={{ width: `${fillPct}%` }} />
                        </span>
                        <span className={`text-[12px] font-semibold ${staffingClass}`}>
                          {assigned}/{needed} staff
                        </span>
                      </span>

                      {/* Certifications */}
                      {task.requiredCertifications?.length > 0 &&
                        task.requiredCertifications.map((cert) => (
                          <span
                            key={cert}
                            className="rounded-full border border-purple-200 bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300"
                          >
                            {cert}
                          </span>
                        ))}

                      {/*
                        Composition rules, shown on the card rather than only in
                        the edit form. A manager refused an assignment needs to
                        see the constraint where they are working, not after
                        opening a form to find out why. Rendered with the same
                        describeRule() the refusal message uses, so the wording
                        matches exactly.
                      */}
                      {parseCompositionRules(task.compositionRules).map((rule, i) => (
                        <span
                          key={`comp-${i}`}
                          className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300"
                        >
                          {describeRule(rule)}
                        </span>
                      ))}
                    </div>

                    {/* ── Description ─────────────── */}
                    {task.description && editingTaskId !== task.id && (
                      <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{task.description}</p>
                    )}

                    {/* ── Actions ─────────────────── */}
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-3">
                      {/* Assign */}
                      {task.status === "open" && canAssign && (
                        <button
                          type="button"
                          onClick={async () => {
                            const newId = assigningTaskId === task.id ? null : task.id;
                            setAssigningTaskId(newId);
                            setSelectedMembers([]);
                            setOverrideReasons({});
                            setAssignError(null);
                            setShowSuggestions(false);
                            /*
                             * Clears eligibility too, which the four separate
                             * clears here did not: opening a second shift
                             * showed the first shift's verdicts until its own
                             * request came back.
                             */
                            resetAssignData();
                            if (newId) {
                              // One call, three concurrent requests — none of
                              // the three answers depends on the others, and
                              // the panel is already open and empty while they
                              // run.
                              await loadAssignData(newId);
                              // In "suggested" mode, auto-fetch AI suggestions
                              if (allocationMode === "suggested") {
                                fetchSuggestions(newId, true);
                              }
                            }
                          }}
                          className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors ${
                            assigningTaskId === task.id
                              ? "border-indigo-500 bg-indigo-50 text-indigo-600 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-400"
                              : "border-border bg-card text-muted-foreground hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:border-indigo-500 dark:hover:bg-indigo-950 dark:hover:text-indigo-400"
                          }`}
                        >
                          <Users className="h-3.5 w-3.5" aria-hidden="true" />
                          Assign
                        </button>
                      )}

                      {/* AI Suggest */}
                      {canSuggest && task.status === "open" && assigningTaskId === task.id && (
                        <button
                          type="button"
                          onClick={() => fetchSuggestions(task.id)}
                          disabled={loadingSuggestions || loadingEligibility}
                          className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:border-indigo-500 dark:hover:bg-indigo-950 dark:hover:text-indigo-400"
                        >
                          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                          AI Suggest
                        </button>
                      )}

                      {/* Auto-assign */}
                      {canAutoAllocate &&
                        allocationMode === "auto" &&
                        task.status === "open" &&
                        assigned < needed && (
                          <button
                            type="button"
                            onClick={() => onAutoAssign(task.id)}
                            disabled={autoAssigningId === task.id}
                            className="flex h-8 items-center gap-1.5 rounded-lg border border-indigo-300 bg-card px-2.5 text-[12px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-600 dark:text-indigo-400 dark:hover:bg-indigo-950"
                          >
                            <Zap className="h-3 w-3" aria-hidden="true" />
                            {autoAssigningId === task.id ? "Assigning..." : "Auto-assign"}
                          </button>
                        )}

                      {/* Edit */}
                      {canUpdate && (
                      <button
                        type="button"
                        onClick={() => {
                          const opening = editingTaskId !== task.id;
                          setEditingTaskId(opening ? task.id : null);
                          // Seeded from the task so an ALREADY out-of-hours
                          // shift is flagged the moment the form opens, rather
                          // than only after someone happens to touch a time
                          // field.
                          setEditSchedule(
                            opening
                              ? {
                                  start: task.scheduledStart
                                    ? toDateTimeLocalValue(new Date(task.scheduledStart))
                                    : "",
                                  end: task.scheduledEnd
                                    ? toDateTimeLocalValue(new Date(task.scheduledEnd))
                                    : "",
                                }
                              : { start: "", end: "" }
                          );
                          // Seeded from the stored JSON so the form opens
                          // showing the rules the task already has; without
                          // this, saving an unrelated edit would submit an
                          // empty list and silently delete them.
                          setEditComposition(
                            opening ? parseCompositionRules(task.compositionRules) : []
                          );
                          // Seeded the same way and for the same reason: an
                          // edit that opened with an empty selection would
                          // delete the task's requirements on save.
                          setEditCerts(
                            opening ? [...(task.requiredCertifications ?? [])] : []
                          );
                        }}
                        className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors ${
                          editingTaskId === task.id
                            ? "border-indigo-500 bg-indigo-50 text-indigo-600 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-400"
                            : "border-border bg-card text-muted-foreground hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:border-indigo-500 dark:hover:bg-indigo-950 dark:hover:text-indigo-400"
                        }`}
                      >
                        <SquarePen className="h-[13px] w-[13px]" aria-hidden="true" />
                        Edit
                      </button>
                      )}

                      {/* Status dropdown — a status change is a task update. */}
                      {canUpdate && (
                      <select
                        className="h-8 appearance-none rounded-lg border border-border bg-card py-0 pl-2.5 pr-7 text-[12px] font-medium text-muted-foreground transition-colors hover:border-indigo-300 dark:hover:border-indigo-600"
                        value={task.status}
                        onChange={(e) => onUpdateStatus(task.id, e.target.value)}
                        style={{
                          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                          backgroundRepeat: "no-repeat",
                          backgroundPosition: "right 6px center",
                        }}
                      >
                        <option value="open">Open</option>
                        <option value="in_progress">In Progress</option>
                        <option value="completed">Completed</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                      )}

                      {canDelete && (
                      <>
                      <div className="mx-0.5 h-5 w-px bg-border/60" />

                      {/* Delete */}
                      <button
                        type="button"
                        onClick={() => onDeleteTask(task.id)}
                        className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:hover:border-red-700 dark:hover:bg-red-950 dark:hover:text-red-400"
                      >
                        <Trash2 className="h-[13px] w-[13px]" aria-hidden="true" />
                        Delete
                      </button>
                      </>
                      )}
                    </div>

                    {/* ── Edit form ───────────────── */}
                    {editingTaskId === task.id && (
                      <div className="mt-3 rounded-lg border border-border bg-muted/30 p-4 dark:bg-muted/10">
                        <form onSubmit={(e) => onUpdateTask(e, task.id)} className="space-y-3">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1 sm:col-span-2">
                              <Label className="text-xs font-semibold text-muted-foreground">Title</Label>
                              <Input name="editTitle" defaultValue={task.title} required />
                            </div>
                            <div className="space-y-1 sm:col-span-2">
                              <Label className="text-xs font-semibold text-muted-foreground">Description</Label>
                              <textarea
                                name="editDescription"
                                defaultValue={task.description || ""}
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px]"
                                placeholder="Task details..."
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs font-semibold text-muted-foreground">Department</Label>
                              <select name="editDepartment" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" defaultValue={task.department?.id || ""}>
                                <option value="">No department</option>
                                {departments.map((dept) => (
                                  <option key={dept.id} value={dept.id}>{dept.name}</option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs font-semibold text-muted-foreground">Priority</Label>
                              <select name="editPriority" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" defaultValue={task.priority}>
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                                <option value="urgent">Urgent</option>
                              </select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs font-semibold text-muted-foreground">Required headcount</Label>
                              <Input name="editHeadcount" type="number" min={1} max={50} defaultValue={task.requiredHeadcount} />
                            </div>
                            <div className="space-y-1">
                              <CertificationPicker
                                options={certTypes}
                                selected={editCerts}
                                onToggle={(name) => setEditCerts(toggleCert(editCerts, name))}
                                orgId={orgId}
                                canManageList={can("certifications:review")}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <CompositionRulesEditor
                                rules={editComposition}
                                onChange={setEditComposition}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs font-semibold text-muted-foreground">Start time</Label>
                              <Input
                                name="editStart"
                                type="datetime-local"
                                defaultValue={task.scheduledStart ? toDateTimeLocalValue(new Date(task.scheduledStart)) : ""}
                                onChange={(e) =>
                                  setEditSchedule((s) => ({ ...s, start: e.target.value }))
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs font-semibold text-muted-foreground">End time</Label>
                              <Input
                                name="editEnd"
                                type="datetime-local"
                                defaultValue={task.scheduledEnd ? toDateTimeLocalValue(new Date(task.scheduledEnd)) : ""}
                                onChange={(e) =>
                                  setEditSchedule((s) => ({ ...s, end: e.target.value }))
                                }
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <OperatingHoursNotice
                                start={editSchedule.start}
                                end={editSchedule.end}
                                operatingHoursStart={opStart}
                                operatingHoursEnd={opEnd}
                              />
                            </div>
                          </div>
                          <div className="flex gap-2 pt-1">
                            <Button type="submit" size="sm">Save Changes</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => setEditingTaskId(null)}>Cancel</Button>
                          </div>
                        </form>
                      </div>
                    )}

                    {/* ── Assignments ─────────────── */}
                    {task.assignments.length > 0 && editingTaskId !== task.id && (
                      <div className="mt-3 border-t border-border/50 pt-3">
                        <p className="mb-2 text-[12px] font-semibold text-muted-foreground">
                          Assigned Staff
                        </p>
                        <div className="space-y-1">
                          {task.assignments.map((a) => (
                            <div key={a.id}>
                              <div className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 text-sm transition-colors hover:bg-muted/50">
                                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${avatarColor(a.membership.user.id)}`}>
                                  {initials(a.membership.user.name)}
                                </div>
                                <span className="font-medium">{a.membership.user.name || "Unnamed"}</span>
                                <StatusBadge value={a.status} palette="assignmentStatus" className="text-[10px]" />
                                {a.clockInTime && (
                                  <span className="text-[11px] text-muted-foreground">
                                    In: {new Date(a.clockInTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                                  </span>
                                )}
                                {a.clockOutTime && (
                                  <span className="text-[11px] text-muted-foreground">
                                    Out: {new Date(a.clockOutTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                                  </span>
                                )}
                                {/*
                                  Permission AND status. This was gated on the
                                  permission alone, so "Add times" appeared
                                  beside a REJECTED assignment — inviting a
                                  manager to record hours for somebody who was
                                  never on the shift, against the column every
                                  hours total and capacity figure is built from.

                                  `canHoldClockTimes` rather than a status list
                                  written here: clocking in requires `accepted`,
                                  and the rule belongs beside the other
                                  status questions rather than in an eighth
                                  hand-rolled copy.
                                */}
                                {canCorrectClock && canHoldClockTimes(a.status) && (
                                  <button
                                    type="button"
                                    className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                                    onClick={() =>
                                      setCorrectingId(
                                        correctingId === a.id ? null : a.id
                                      )
                                    }
                                  >
                                    {a.clockInTime || a.clockOutTime
                                      ? "Correct"
                                      : "Add times"}
                                  </button>
                                )}
                                {canAssign &&
                                  a.status !== "completed" &&
                                  a.status !== "withdrawal_requested" &&
                                  // A decline awaiting a decision has its own
                                  // Approve control below, which records the
                                  // member's reason. Unassign here would free
                                  // the same slot with no reason attached and
                                  // leave the request unanswered.
                                  a.status !== "decline_requested" && (
                                  <button
                                    type="button"
                                    className="ml-auto text-[11px] text-red-500 hover:underline"
                                    onClick={() => onCancelAssignment(a.id)}
                                  >
                                    Unassign
                                  </button>
                                )}
                              </div>

                              {/*
                                The correction form.

                                Both times are editable, not just the missing
                                one — a mistyped start is as common as a
                                forgotten finish, and a form that only let you
                                add the second would send the manager to the
                                database for the first.

                                Clearing both is a legitimate correction
                                (clocked in on the wrong shift), which is why
                                nothing here is `required`. The service refuses
                                the combinations that are not.
                              */}
                              {/*
                                The status guard is repeated here, not only on
                                the button. The list refreshes after every
                                action, so a row whose decline is approved while
                                this form is open becomes `rejected` underneath
                                it — and an open form outlives the control that
                                opened it.
                              */}
                              {correctingId === a.id && canHoldClockTimes(a.status) && (
                                <form
                                  className="ml-9 mt-2 space-y-2 rounded-lg border border-border bg-muted/30 p-3"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    const form = new FormData(e.currentTarget);
                                    onCorrectClock(a.id, {
                                      clockIn: String(form.get("clockIn") ?? ""),
                                      clockOut: String(form.get("clockOut") ?? ""),
                                      reason: String(form.get("reason") ?? ""),
                                    });
                                  }}
                                >
                                  <p className="text-[11px] text-muted-foreground">
                                    {a.membership.user.name || "This member"} will
                                    be told their times were changed, and the
                                    previous values are kept in the audit log.
                                  </p>
                                  <div className="grid gap-2 sm:grid-cols-2">
                                    <label className="space-y-1">
                                      <span className="text-[11px] font-medium text-muted-foreground">
                                        Clocked in
                                      </span>
                                      <Input
                                        type="datetime-local"
                                        name="clockIn"
                                        defaultValue={
                                          a.clockInTime
                                            ? toDateTimeLocalValue(new Date(a.clockInTime))
                                            : ""
                                        }
                                        className="h-9 text-xs"
                                      />
                                    </label>
                                    <label className="space-y-1">
                                      <span className="text-[11px] font-medium text-muted-foreground">
                                        Clocked out
                                      </span>
                                      <Input
                                        type="datetime-local"
                                        name="clockOut"
                                        defaultValue={
                                          a.clockOutTime
                                            ? toDateTimeLocalValue(new Date(a.clockOutTime))
                                            : ""
                                        }
                                        className="h-9 text-xs"
                                      />
                                    </label>
                                  </div>
                                  <Input
                                    name="reason"
                                    required
                                    maxLength={500}
                                    placeholder="Why are you changing this?"
                                    className="h-9 text-xs"
                                  />
                                  <div className="flex flex-wrap gap-2">
                                    <button type="submit" className={PRIMARY_BUTTON}>
                                      Save correction
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setCorrectingId(null)}
                                      className={SECONDARY_BUTTON}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </form>
                              )}

                              {/* Full-time decline awaiting a decision */}
                              {canAssign && a.status === "decline_requested" && (
                                <div className="ml-9 mt-1 rounded-lg border border-orange-200 bg-orange-50 p-2.5 dark:border-orange-900 dark:bg-orange-950/40">
                                  <p className="text-xs text-orange-800 dark:text-orange-300">
                                    <strong>{a.membership.user.name}</strong> asked to be taken off this shift
                                    {a.rejectionReason ? ` — ${reasonLabel(a.rejectionReason)}` : ""}
                                  </p>
                                  {a.rejectionNotes && (
                                    <p className="mt-0.5 text-[11px] text-orange-700 dark:text-orange-400">
                                      &ldquo;{a.rejectionNotes}&rdquo;
                                    </p>
                                  )}
                                  <CoverOptions
                                    taskId={task.id}
                                    state={cover[a.id]}
                                    onFind={() => findCover(a.id, task.id)}
                                  />
                                  {/* Says what each button DOES, not just yes
                                      and no. Denying returns the shift to
                                      pending — the member is still rostered and
                                      still has to answer — and a bare "Deny"
                                      does not tell a manager that. */}
                                  <div className="mt-2 flex gap-2">
                                    <button
                                      type="button"
                                      className="rounded-md bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-700"
                                      onClick={() => onResolveDecline(a.id, "approve")}
                                    >
                                      Approve &amp; free the slot
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-muted"
                                      onClick={() => onResolveDecline(a.id, "deny")}
                                    >
                                      Keep them rostered
                                    </button>
                                  </div>
                                </div>
                              )}

                              {/* Withdrawal request */}
                              {canAssign && a.status === "withdrawal_requested" && (
                                <div className="ml-9 mt-1 rounded-lg border border-orange-200 bg-orange-50 p-2.5 dark:border-orange-900 dark:bg-orange-950/40">
                                  <p className="text-xs text-orange-800 dark:text-orange-300">
                                    <strong>{a.membership.user.name}</strong> requested to withdraw
                                    {a.withdrawalReason ? ` — ${reasonLabel(a.withdrawalReason)}` : ""}
                                  </p>
                                  {/* Withdrawal reasons are now one of eight
                                      values so they can be counted. The reason
                                      alone rarely says enough to decide on, so
                                      the staff member's own words are shown
                                      underneath when they gave any. */}
                                  {a.withdrawalNotes && (
                                    <p className="mt-0.5 text-[11px] text-orange-700 dark:text-orange-400">
                                      &ldquo;{a.withdrawalNotes}&rdquo;
                                    </p>
                                  )}
                                  <CoverOptions
                                    taskId={task.id}
                                    state={cover[a.id]}
                                    onFind={() => findCover(a.id, task.id)}
                                  />
                                  <div className="mt-2 flex gap-2">
                                    <button
                                      type="button"
                                      className="rounded-md bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-700"
                                      onClick={() => onResolveWithdrawal(a.id, "approve")}
                                    >
                                      Approve &amp; unassign
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-muted"
                                      onClick={() => onResolveWithdrawal(a.id, "deny")}
                                    >
                                      Deny
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── Assign staff panel ─────── */}
                    {assigningTaskId === task.id && (() => {
                      /*
                       * Seats still to fill. `assigned` already excludes people
                       * who rejected or withdrew (see countOccupied), so this is
                       * the number the server will accept — the panel and
                       * `assignStaff` now agree on the ceiling instead of the
                       * panel proposing selections the API refuses.
                       */
                      const remainingSlots = slotsLeft(needed, task.assignments);

                      /*
                       * Composition annotations, recomputed on every render so
                       * they follow the ticks.
                       *
                       * `candidateEffect` answers "would this person fill the
                       * gap, or break a rule?" — the question a manager is
                       * actually asking while choosing. Before this the only
                       * feedback was the refusal AFTER picking the wrong person,
                       * which tells them they were wrong without telling them
                       * who is right.
                       */
                      const { evaluation: compEval, effects: compEffects } =
                        annotateSelection({
                          rules: composition?.rules ?? [],
                          members: composition?.members ?? [],
                          assignedMembershipIds:
                            composition?.assignedMembershipIds ?? [],
                          selectedMembershipIds: selectedMembers,
                          requiredHeadcount:
                            composition?.requiredHeadcount ?? needed,
                        });

                      /*
                       * Unanswered leave, by member. A shift crossing midnight
                       * covers two dates and somebody can have asked for either
                       * — the endpoint returns both, and the first one found is
                       * the one shown, because two warnings on one candidate is
                       * noise when the action is identical.
                       */
                      const leaveByMember = new Map(
                        pendingLeave.map((l) => [l.membershipId, l])
                      );

                      /*
                       * Who could take the shift instead: eligible, not already
                       * selected, and — the part that matters — not carrying
                       * their own unanswered request. Offering a replacement
                       * who has also asked for the day off is worse than
                       * offering nobody.
                       *
                       * Ordered by the engine's ranking when it has been
                       * fetched, so "Pick Jamie instead" is the same Jamie the
                       * AI Suggest panel would have put first.
                       */
                      const alternatives = members
                        .filter((m) => {
                          const elig = eligibility[m.id];
                          return (
                            (elig ? elig.eligible : true) &&
                            !leaveByMember.has(m.id) &&
                            !selectedMembers.includes(m.id)
                          );
                        })
                        .map((m) => ({
                          membershipId: m.id,
                          name: m.user.name || m.user.email,
                          rank: suggestions.find((sg) => sg.membershipId === m.id)?.rank,
                        }))
                        .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

                      // Split members into eligible / ineligible for grouped display
                      const eligibleMembers = members.filter((m) => {
                        const elig = eligibility[m.id];
                        return elig ? elig.eligible : true;
                      });
                      const ineligibleMembers = members.filter((m) => {
                        const elig = eligibility[m.id];
                        return elig && !elig.eligible;
                      });

                      return (
                        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-muted/30 dark:bg-muted/10">
                          {/* Panel header */}
                          <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
                            <p className="text-[13px] font-semibold">
                              Select staff to assign
                              {assigned < needed && (
                                <span className="ml-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/50 dark:text-amber-400">
                                  need {needed - assigned} more
                                </span>
                              )}
                            </p>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 text-[11px]"
                              onClick={() => fetchSuggestions(task.id)}
                              disabled={loadingSuggestions || loadingEligibility}
                            >
                              <Sparkles className="h-3 w-3" aria-hidden="true" />
                              {loadingSuggestions
                                ? "Loading..."
                                : suggestions.length > 0 && showSuggestions
                                  ? "Hide"
                                  : "AI Suggest"}
                            </Button>
                          </div>

                          {/*
                            Live rule status.
                            Three states, not two: met, not met but still
                            reachable, and out of reach. The middle one is the
                            common case while a shift is half-filled and must
                            not be coloured like a problem.
                          */}
                          {compEval && compEval.rules.length > 0 && (
                            <div className="border-b border-border/50 bg-card/40 px-4 py-2">
                              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                                Composition rules
                              </p>
                              <div className="mt-1 space-y-0.5">
                                {compEval.rules.map((r, i) => (
                                  <p
                                    key={i}
                                    className={`text-[11px] ${
                                      r.satisfied
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : r.feasible
                                          ? "text-muted-foreground"
                                          : "font-medium text-amber-700 dark:text-amber-400"
                                    }`}
                                  >
                                    {r.satisfied ? "✓" : r.feasible ? "○" : "⚠"} {r.description}
                                    {!r.satisfied && ` — ${r.matched} so far`}
                                  </p>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* AI Recommendations — compact chip row */}
                          {suggestions.length > 0 && showSuggestions && (
                            <div className="border-b border-indigo-200 bg-indigo-50/60 px-4 py-2.5 dark:border-indigo-800/50 dark:bg-indigo-950/30">
                              {/*
                                The heading used to read "top {requiredHeadcount}
                                auto-selected" above a list of every suggestion
                                the engine returned — so a shift with two seats
                                announced "top 2" and then listed three people,
                                and there was no way to tell which two were
                                actually ticked.

                                The extra names are worth keeping: the ranking
                                is the engine's output, and a manager who knows
                                the top pick is unavailable in practice wants
                                the next one without re-running anything. They
                                just have to be labelled as alternates rather
                                than presented as picks.
                              */}
                              <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                                <Sparkles className="h-[11px] w-[11px]" aria-hidden="true" />
                                {remainingSlots > 0
                                  ? `AI picks — top ${Math.min(remainingSlots, suggestions.length)} auto-selected`
                                  : "AI ranking — this shift is already full"}
                              </p>
                              <div className="space-y-2">
                                {suggestions.slice(0, remainingSlots + MAX_ALTERNATES).map((s, i) => {
                                  const isAlternate = i >= remainingSlots;
                                  const member = members.find((m) => m.id === s.membershipId);
                                  const eligEntry = Object.values(eligibility).find(
                                    (e) => e.membershipId === s.membershipId
                                  );
                                  const name = member?.user.name || member?.user.email || eligEntry?.memberName || "Unknown";
                                  return (
                                    <div
                                      key={s.membershipId}
                                      className={`rounded-lg border px-3 py-2 ${
                                        isAlternate
                                          ? "border-border bg-card/60"
                                          : "border-indigo-200 bg-white dark:border-indigo-700 dark:bg-indigo-950/60"
                                      }`}
                                    >
                                      <div className="flex items-center gap-1.5">
                                        <span
                                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
                                            isAlternate
                                              ? "bg-indigo-300 dark:bg-indigo-800"
                                              : "bg-indigo-600 dark:bg-indigo-500"
                                          }`}
                                        >
                                          {s.rank}
                                        </span>
                                        <span className="text-[13px] font-medium text-foreground">{name}</span>
                                        <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-800 dark:text-indigo-300">
                                          {s.score}/100
                                        </span>
                                        {isAlternate && (
                                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                            alternate
                                          </span>
                                        )}
                                      </div>
                                      {s.explanation && (
                                        <p className="mt-1 pl-6.5 text-[11px] leading-relaxed text-indigo-700/80 dark:text-indigo-300/70">
                                          {s.explanation}
                                        </p>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                              {suggestions.length > remainingSlots + MAX_ALTERNATES && (
                                <p className="mt-2 text-[11px] text-muted-foreground">
                                  {suggestions.length - remainingSlots - MAX_ALTERNATES} more
                                  ranked candidate
                                  {suggestions.length - remainingSlots - MAX_ALTERNATES !== 1
                                    ? "s"
                                    : ""}{" "}
                                  — every eligible member below carries their rank and score.
                                </p>
                              )}
                            </div>
                          )}

                          {/* Member list body */}
                          <div className="px-4 py-3">
                            {loadingEligibility ? (
                              <p className="py-4 text-center text-sm text-muted-foreground">Checking staff eligibility...</p>
                            ) : (
                              <>
                                {/* Eligible members — 2-column grid */}
                                {eligibleMembers.length > 0 && (
                                  <div className="max-h-[280px] overflow-y-auto">
                                    <div className="grid gap-1.5 sm:grid-cols-2">
                                      {eligibleMembers.map((m) => {
                                        const suggestion = suggestions.find((s) => s.membershipId === m.id);
                                        const selected = selectedMembers.includes(m.id);
                                        // Against the seats LEFT, not the headcount — see remainingSlots.
                                        const atLimit = !selected && selectedMembers.length >= remainingSlots;

                                        return (
                                          <label
                                            key={m.id}
                                            className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                                              selected
                                                ? "border-indigo-400 bg-indigo-50/80 dark:border-indigo-600 dark:bg-indigo-950/40"
                                                : "border-transparent hover:bg-muted/60"
                                            } ${atLimit ? "opacity-40" : ""}`}
                                          >
                                            <input
                                              type="checkbox"
                                              checked={selected}
                                              onChange={() => toggleMemberSelection(m.id)}
                                              disabled={atLimit}
                                              className="mt-1 h-3.5 w-3.5 shrink-0 rounded border-border accent-indigo-600"
                                            />
                                            <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white ${avatarColor(m.user.id)}`}>
                                              {initials(m.user.name)}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                              <span className="block truncate text-[13px] font-medium">{m.user.name || m.user.email}</span>
                                              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                                {m.role}
                                                {suggestion ? (
                                                  <span className="rounded bg-indigo-100 px-1 py-0 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
                                                    #{suggestion.rank} · {suggestion.score}/100
                                                  </span>
                                                ) : (
                                                  <span className="text-emerald-600 dark:text-emerald-400">✓</span>
                                                )}
                                              </span>
                                              {suggestion?.explanation && (
                                                <p className="mt-0.5 text-[10px] leading-snug text-indigo-600/70 dark:text-indigo-400/60">
                                                  {suggestion.explanation}
                                                </p>
                                              )}
                                              {leaveByMember.has(m.id) && (
                                                <PendingLeaveFlag
                                                  leave={leaveByMember.get(m.id)!}
                                                  alternatives={alternatives}
                                                  onPick={(id) => {
                                                    if (!selectedMembers.includes(id)) {
                                                      toggleMemberSelection(id);
                                                    }
                                                  }}
                                                />
                                              )}
                                              {(() => {
                                                const effect = compEffects[m.id];
                                                if (!effect) return null;
                                                return (
                                                  <span className="mt-0.5 block text-[10px] leading-snug">
                                                    {effect.breaks.map((d, i) => (
                                                      <span
                                                        key={`b${i}`}
                                                        className="block font-medium text-amber-700 dark:text-amber-400"
                                                      >
                                                        ⚠ Would break: {d}
                                                      </span>
                                                    ))}
                                                    {effect.helps.map((d, i) => (
                                                      <span
                                                        key={`h${i}`}
                                                        className="block font-medium text-emerald-700 dark:text-emerald-400"
                                                      >
                                                        ✓ Fills: {d}
                                                      </span>
                                                    ))}
                                                  </span>
                                                );
                                              })()}
                                            </div>
                                          </label>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}

                                {/* Ineligible members — separate section */}
                                {ineligibleMembers.length > 0 && (
                                  <div className="mt-3">
                                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                                      Needs Override ({ineligibleMembers.length})
                                    </p>
                                    <div className="space-y-2">
                                      {ineligibleMembers.map((m) => {
                                        const elig = eligibility[m.id];
                                        const overrideReason = overrideReasons[m.id] || "";
                                        const hasOverride = overrideReason.trim().length > 0;
                                        const selected = selectedMembers.includes(m.id);
                                        const atLimit = !selected && selectedMembers.length >= remainingSlots;
                                        const canSelect = hasOverride;
                                        const suggestion = suggestions.find((s) => s.membershipId === m.id);

                                        const warnings: string[] =
                                          (["availability", "scheduling", "workRules", "hoursLimit", "certifications"] as const)
                                            .filter((k) => elig?.checks[k] && !elig.checks[k].eligible)
                                            .map((k) => elig.checks[k].reason || k);

                                        /*
                                          Two facts a manager needs before waiving
                                          somebody's stated unavailability, shown
                                          at the moment they are about to do it.

                                          That it will be an ASK — the shift is
                                          offered, not booked, whatever the
                                          organisation's acceptance mode says —
                                          so nobody expects a confirmed body on
                                          the roster and finds a pending row.

                                          And how often this person has been asked
                                          lately. A count in the audit log is a
                                          record; a count here is a check. "You
                                          have done this to Priya four times in
                                          three months" is only useful before the
                                          fifth.
                                        */
                                        const unavailable =
                                          elig?.checks.availability &&
                                          !elig.checks.availability.eligible;
                                        const askedBefore = elig?.askedDespiteUnavailable ?? 0;

                                        return (
                                          <div
                                            key={m.id}
                                            className="rounded-lg border border-amber-200 bg-amber-50/50 p-2.5 dark:border-amber-900 dark:bg-amber-950/20"
                                          >
                                            {unavailable && (
                                              <p className="mb-2 rounded-md bg-amber-100/70 px-2 py-1.5 text-[11px] leading-relaxed text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
                                                They said they are not available.
                                                This will be offered, not booked —
                                                they choose whether to take it.
                                                {askedBefore > 0 && (
                                                  <>
                                                    {" "}
                                                    Asked despite being unavailable{" "}
                                                    <strong>
                                                      {askedBefore}{" "}
                                                      {askedBefore === 1 ? "time" : "times"}
                                                    </strong>{" "}
                                                    in the last 90 days.
                                                  </>
                                                )}
                                              </p>
                                            )}
                                            <label
                                              className={`flex cursor-pointer items-center gap-2 text-[13px] ${
                                                !canSelect || atLimit ? "opacity-50" : ""
                                              }`}
                                            >
                                              <input
                                                type="checkbox"
                                                checked={selected}
                                                onChange={() => toggleMemberSelection(m.id)}
                                                disabled={!canSelect || atLimit}
                                                className="h-3.5 w-3.5 shrink-0 rounded border-border accent-indigo-600"
                                              />
                                              <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white ${avatarColor(m.user.id)}`}>
                                                {initials(m.user.name)}
                                              </div>
                                              <span className="font-medium">{m.user.name || m.user.email}</span>
                                              <span className="text-[11px] text-muted-foreground">{m.role}</span>
                                              {suggestion && (
                                                <span className="rounded bg-indigo-100 px-1 py-0 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
                                                  #{suggestion.rank} · {suggestion.score}/100
                                                </span>
                                              )}
                                              {/*
                                                Says why the box will not tick.
                                                Typing a reason has always
                                                unlocked it, but the control and
                                                the field that unlocks it are
                                                two rows apart, so a disabled
                                                checkbox with no explanation
                                                read as "this person cannot be
                                                assigned at all".
                                              */}
                                              {!canSelect && !atLimit && (
                                                <span className="ml-auto text-[11px] font-medium text-amber-700 dark:text-amber-400">
                                                  Add a reason below to select
                                                </span>
                                              )}
                                              {atLimit && !selected && (
                                                <span className="ml-auto text-[11px] text-muted-foreground">
                                                  No seats left
                                                </span>
                                              )}
                                            </label>
                                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-8 text-[11px] text-amber-700 dark:text-amber-400">
                                              {warnings.map((w, i) => (
                                                <span key={i}>⚠ {w}</span>
                                              ))}
                                            </div>
                                            <div className="mt-1.5 pl-8">
                                              <Input
                                                value={overrideReason}
                                                onChange={(e) =>
                                                  setOverrideReasons((prev) => ({
                                                    ...prev,
                                                    [m.id]: e.target.value,
                                                  }))
                                                }
                                                placeholder="Override reason (required)"
                                                className="h-7 text-xs"
                                              />
                                              {hasOverride && (
                                                <p className="mt-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                                                  {selected
                                                    ? "✓ Override will be recorded against this assignment"
                                                    : "✓ Reason saved — you can select them now"}
                                                </p>
                                              )}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                              </>
                            )}
                          </div>

                          {/* Panel footer — outside scroll area */}
                          {assignError && <AlertBanner message={assignError} variant="error" className="mx-4 mb-3" />}

                          <div className="flex gap-2 border-t border-border/50 px-4 py-3">
                            <Button
                              size="sm"
                              onClick={() => onAssignStaff(task.id)}
                              disabled={
                                loadingEligibility ||
                                assigning ||
                                selectedMembers.length === 0
                              }
                              className={PRIMARY_BUTTON}
                            >
                              {assigning
                                ? "Assigning…"
                                : `Confirm Assignment${selectedMembers.length > 0 ? ` (${selectedMembers.length})` : ""}`}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setAssigningTaskId(null);
                                setSelectedMembers([]);
                                setOverrideReasons({});
                                setAssignError(null);
                                setShowSuggestions(false);
                                resetAssignData();
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
