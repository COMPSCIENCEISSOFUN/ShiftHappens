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
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  parseRecurrencePattern,
  describeRecurrence,
  type RecurrenceFreq,
} from "@/lib/recurrence";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { toDateTimeLocalValue } from "@/lib/timezone";
import { OperatingHoursNotice } from "@/components/tasks/operating-hours-notice";
import { reasonLabel } from "@/lib/decline-reasons";

// ============================================================
// Constants
// ============================================================

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

/** Splits a comma-separated certifications input into a clean list of names. */
function parseCertList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
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

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  requiredHeadcount: number;
  requiredCertifications: string[];
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
  const [assigningTaskId, setAssigningTaskId] = useState<string | null>(null);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  // membershipId → reason, when a manager overrides an ineligible staff member
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({});
  // Shown inside the assign panel — the page-level banner is off-screen there.
  const [assignError, setAssignError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterDept, setFilterDept] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [eligibility, setEligibility] = useState<Record<string, any>>({});
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loadingEligibility, setLoadingEligibility] = useState(false);
  const [naturalInput, setNaturalInput] = useState("");
  const [parsing, setParsing] = useState(false);
  // "manual" | "suggested" | "auto" — auto-assign is only offered in "auto" mode
  const [allocationMode, setAllocationMode] = useState<string>("manual");
  const [autoAssigningId, setAutoAssigningId] = useState<string | null>(null);

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
  const [editSchedule, setEditSchedule] = useState({ start: "", end: "" });

  // ── Data fetching ────────────────────────────────

  useEffect(() => {
    fetchTasks();
    fetchDepartments();
    fetchMembers();
    fetchSettings();
    fetchOperatingHours();
  }, [orgId]);

  async function fetchTasks() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/tasks`);
      const data = await res.json();
      setTasks(data);
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
      setAllocationMode(data.allocationMode ?? "manual");
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
      setMembers(
        data.filter(
          (m: Member) => m.status === "active" && m.role !== "company_admin"
        )
      );
    } catch {}
  }

  async function fetchEligibility(taskId: string) {
    setLoadingEligibility(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/eligibility`
      );
      const data = await res.json();
      const map: Record<string, any> = {};
      for (const item of data) {
        map[item.membershipId] = item;
      }
      setEligibility(map);
    } catch {} finally {
      setLoadingEligibility(false);
    }
  }

  async function fetchSuggestions(taskId: string, force = false) {
    // Toggle visibility if already loaded (unless force-fetching)
    if (!force && suggestions.length > 0) {
      setShowSuggestions(!showSuggestions);
      return;
    }

    setLoadingSuggestions(true);
    setShowSuggestions(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tasks/${taskId}/suggest`
      );
      const data = await res.json();
      if (res.ok) {
        setSuggestions(data);
        const topIds = data
          .slice(0, tasks.find((t) => t.id === taskId)?.requiredHeadcount || 1)
          .map((s: any) => s.membershipId);
        setSelectedMembers(topIds);
      }
    } catch {
      setError("Failed to get AI suggestions");
    } finally {
      setLoadingSuggestions(false);
    }
  }

  // ── Handlers ─────────────────────────────────────

  /** Lets the system pick and assign the best-fit staff for a task (US-65). */
  async function onAutoAssign(taskId: string) {
    setError(null);
    setSuccess(null);
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
      setSuccess(
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

  async function onCreateTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A double click used to POST twice, and for a repeating task that meant two
    // full series of generated occurrences to clean up by hand. Checked here as
    // well as on the button because the second click lands before React
    // repaints `disabled`.
    if (creating) return;

    const form = event.currentTarget;
    setError(null);
    setSuccess(null);

    const formData = new FormData(form);

    const taskData: Record<string, unknown> = {
      title: formData.get("title"),
      description: formData.get("description") || undefined,
      departmentId: formData.get("departmentId") || undefined,
      priority: formData.get("priority"),
      requiredHeadcount: Number(formData.get("requiredHeadcount")) || 1,
    };

    // Required certifications — comma-separated names, e.g. "Food Safety, RSA".
    const createCerts = parseCertList(formData.get("requiredCertifications") as string);
    if (createCerts.length > 0) taskData.requiredCertifications = createCerts;

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
      setSuccess(
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
      for (const membId of selectedMembers) {
        const elig = eligibility[membId];
        const reason = overrideReasons[membId]?.trim();
        if (elig && !elig.eligible && reason) {
          const ovRes = await fetch(
            `/api/organizations/${orgId}/tasks/${taskId}/eligibility/override`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                membershipId: membId,
                reason,
                ruleOverridden: "all",
              }),
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
      setSuccess("Staff assigned successfully");
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
      requiredCertifications: parseCertList(formData.get("editRequiredCertifications") as string),
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
      setSuccess("Task updated");
      fetchTasks();
    } catch {
      setError("Something went wrong");
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

  const displayedTasks = filterStatus
    ? deptTasks.filter((t) => t.status === filterStatus)
    : deptTasks;

  // ── Computed stats ───────────────────────────────
  // Stat tiles: global (all tasks, no filters).
  const openCount = tasks.filter((t) => t.status === "open").length;
  const inProgressCount = tasks.filter((t) => t.status === "in_progress").length;
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const needsStaffCount = tasks.filter(
    (t) => t.status === "open" && t.assignments.length < t.requiredHeadcount
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
          <h2 className="text-2xl font-bold tracking-tight">Tasks</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Manage and assign shifts across your organization
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setShowCreate(!showCreate)}
          >
            {showCreate ? (
              "Cancel"
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                Create Task
              </>
            )}
          </Button>
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="shrink-0 text-indigo-500">
          <path d="M12 2L14.4 8.4L21 10L14.4 12.4L12 19L9.6 12.4L3 10L9.6 8.4L12 2Z" fill="currentColor" opacity="0.8" />
        </svg>
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
          className="shrink-0 gap-1 bg-gradient-to-r from-indigo-600 to-violet-700 text-white hover:opacity-90"
        >
          {parsing ? "Parsing..." : "AI Create"}
        </Button>
      </div>

      {/* ──────────────────────────────────────────────── */}
      {/* Alerts                                           */}
      {/* ──────────────────────────────────────────────── */}
      {error && <AlertBanner message={error} variant="error" className="mb-4" />}
      {success && <AlertBanner message={success} variant="success" className="mb-4" />}

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

      {/* ──────────────────────────────────────────────── */}
      {/* 5. Create task form (collapsible)                */}
      {/* ──────────────────────────────────────────────── */}
      {showCreate && (
        <div className="task-create-form mb-5 rounded-xl border border-border bg-card">
          <div className="border-t-[3px] border-t-indigo-600 rounded-t-xl" />
          <form onSubmit={onCreateTask} className="p-5">
            <p className="mb-5 flex items-center gap-2 text-base font-bold">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-indigo-600 dark:text-indigo-400"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              New Task
            </p>

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
              <div className="space-y-1.5">
                <Label htmlFor="requiredCertifications" className="text-xs font-semibold text-muted-foreground">Required certifications</Label>
                <Input id="requiredCertifications" name="requiredCertifications" placeholder="e.g. Food Safety, RSA" />
                <p className="text-[11px] text-muted-foreground">Comma-separated. Leave blank for none.</p>
              </div>
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
                <Button type="submit" disabled={creating} className="bg-gradient-to-r from-indigo-600 to-violet-700 text-white hover:opacity-90">
                  {creating ? "Creating…" : "Create Task"}
                </Button>
                <Button type="button" variant="outline" disabled={creating} onClick={() => setShowCreate(false)}>
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
            const assigned = task.assignments.length;
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
                className={`group overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-sm ${
                  isCompleted ? "opacity-70" : ""
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
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 opacity-60"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
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
                    </div>

                    {/* ── Description ─────────────── */}
                    {task.description && editingTaskId !== task.id && (
                      <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{task.description}</p>
                    )}

                    {/* ── Actions ─────────────────── */}
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-3">
                      {/* Assign */}
                      {task.status === "open" && (
                        <button
                          type="button"
                          onClick={async () => {
                            const newId = assigningTaskId === task.id ? null : task.id;
                            setAssigningTaskId(newId);
                            setSelectedMembers([]);
                            setOverrideReasons({});
                            setAssignError(null);
                            setSuggestions([]);
                            setShowSuggestions(false);
                            if (newId) {
                              await fetchEligibility(newId);
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
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="22" y1="11" x2="16" y2="11" /></svg>
                          Assign
                        </button>
                      )}

                      {/* AI Suggest */}
                      {task.status === "open" && assigningTaskId === task.id && (
                        <button
                          type="button"
                          onClick={() => fetchSuggestions(task.id)}
                          disabled={loadingSuggestions || loadingEligibility}
                          className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:border-indigo-500 dark:hover:bg-indigo-950 dark:hover:text-indigo-400"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L14.4 8.4L21 10L14.4 12.4L12 19L9.6 12.4L3 10L9.6 8.4L12 2Z" /></svg>
                          AI Suggest
                        </button>
                      )}

                      {/* Auto-assign */}
                      {allocationMode === "auto" &&
                        task.status === "open" &&
                        assigned < needed && (
                          <button
                            type="button"
                            onClick={() => onAutoAssign(task.id)}
                            disabled={autoAssigningId === task.id}
                            className="flex h-8 items-center gap-1.5 rounded-lg border border-indigo-300 bg-card px-2.5 text-[12px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-600 dark:text-indigo-400 dark:hover:bg-indigo-950"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
                            {autoAssigningId === task.id ? "Assigning..." : "Auto-assign"}
                          </button>
                        )}

                      {/* Edit */}
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
                        }}
                        className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors ${
                          editingTaskId === task.id
                            ? "border-indigo-500 bg-indigo-50 text-indigo-600 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-400"
                            : "border-border bg-card text-muted-foreground hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:border-indigo-500 dark:hover:bg-indigo-950 dark:hover:text-indigo-400"
                        }`}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                        Edit
                      </button>

                      {/* Status dropdown */}
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

                      <div className="mx-0.5 h-5 w-px bg-border/60" />

                      {/* Delete */}
                      <button
                        type="button"
                        onClick={() => onDeleteTask(task.id)}
                        className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:hover:border-red-700 dark:hover:bg-red-950 dark:hover:text-red-400"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                        Delete
                      </button>
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
                              <Label className="text-xs font-semibold text-muted-foreground">Required certifications</Label>
                              <Input name="editRequiredCertifications" defaultValue={(task.requiredCertifications || []).join(", ")} placeholder="e.g. Food Safety, RSA" />
                              <p className="text-[11px] text-muted-foreground">Comma-separated. Clear the field to remove all requirements.</p>
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
                                {a.status !== "completed" && a.status !== "withdrawal_requested" && (
                                  <button
                                    type="button"
                                    className="ml-auto text-[11px] text-red-500 hover:underline"
                                    onClick={() => onCancelAssignment(a.id)}
                                  >
                                    Unassign
                                  </button>
                                )}
                              </div>

                              {/* Withdrawal request */}
                              {a.status === "withdrawal_requested" && (
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
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L14.4 8.4L21 10L14.4 12.4L12 19L9.6 12.4L3 10L9.6 8.4L12 2Z" /></svg>
                              {loadingSuggestions
                                ? "Loading..."
                                : suggestions.length > 0 && showSuggestions
                                  ? "Hide"
                                  : "AI Suggest"}
                            </Button>
                          </div>

                          {/* AI Recommendations — compact chip row */}
                          {suggestions.length > 0 && showSuggestions && (
                            <div className="border-b border-indigo-200 bg-indigo-50/60 px-4 py-2.5 dark:border-indigo-800/50 dark:bg-indigo-950/30">
                              <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L14.4 8.4L21 10L14.4 12.4L12 19L9.6 12.4L3 10L9.6 8.4L12 2Z" /></svg>
                                AI Picks — top {task.requiredHeadcount} auto-selected
                              </p>
                              <div className="space-y-2">
                                {suggestions.map((s: any) => {
                                  const member = members.find((m) => m.id === s.membershipId);
                                  const eligEntry = Object.values(eligibility).find(
                                    (e: any) => e.membershipId === s.membershipId
                                  ) as any;
                                  const name = member?.user.name || member?.user.email || eligEntry?.memberName || "Unknown";
                                  return (
                                    <div
                                      key={s.membershipId}
                                      className="rounded-lg border border-indigo-200 bg-white px-3 py-2 dark:border-indigo-700 dark:bg-indigo-950/60"
                                    >
                                      <div className="flex items-center gap-1.5">
                                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white dark:bg-indigo-500">
                                          {s.rank}
                                        </span>
                                        <span className="text-[13px] font-medium text-foreground">{name}</span>
                                        <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-800 dark:text-indigo-300">
                                          {s.score}/100
                                        </span>
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
                                        const suggestion = suggestions.find((s: any) => s.membershipId === m.id);
                                        const selected = selectedMembers.includes(m.id);
                                        const atLimit = !selected && selectedMembers.length >= task.requiredHeadcount;

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
                                        const atLimit = !selected && selectedMembers.length >= task.requiredHeadcount;
                                        const canSelect = hasOverride;
                                        const suggestion = suggestions.find((s: any) => s.membershipId === m.id);

                                        const warnings: string[] =
                                          (["availability", "scheduling", "workRules", "hoursLimit", "certifications"] as const)
                                            .filter((k) => elig?.checks[k] && !elig.checks[k].eligible)
                                            .map((k) => elig.checks[k].reason || k);

                                        return (
                                          <div
                                            key={m.id}
                                            className="rounded-lg border border-amber-200 bg-amber-50/50 p-2.5 dark:border-amber-900 dark:bg-amber-950/20"
                                          >
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
                                                  ✓ Override recorded
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
                              disabled={loadingEligibility || selectedMembers.length === 0}
                              className="bg-gradient-to-r from-indigo-600 to-violet-700 text-white hover:opacity-90"
                            >
                              Confirm Assignment{selectedMembers.length > 0 ? ` (${selectedMembers.length})` : ""}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setAssigningTaskId(null);
                                setSelectedMembers([]);
                                setOverrideReasons({});
                                setAssignError(null);
                                setSuggestions([]);
                                setShowSuggestions(false);
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
