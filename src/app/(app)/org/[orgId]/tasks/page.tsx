/**
 * Tasks Management Page (Boundary Layer)
 * 
 * Admin/Manager can view all tasks, create new tasks,
 * assign staff, and manage task lifecycle.
 * Supports filtering by status, department, and priority.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  parseRecurrencePattern,
  describeRecurrence,
  type RecurrenceFreq,
} from "@/lib/recurrence";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

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
  department: { id: string; name: string } | null;
  createdBy: { id: string; name: string | null };
  assignments: {
    id: string;
    status: string;
    clockInTime: string | null;
    clockOutTime: string | null;
    withdrawalReason: string | null;
    membership: { user: { id: string; name: string | null } };
  }[];
}

interface Department {
  id: string;
  name: string;
}

interface Member {
  id: string;
  role: string;
  status: string;
  user: { id: string; name: string | null; email: string };
}

export default function TasksPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [showCreate, setShowCreate] = useState(false);
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

  useEffect(() => {
    fetchTasks();
    fetchDepartments();
    fetchMembers();
    fetchSettings();
  }, [orgId]);

  useEffect(() => {
    fetchTasks();
  }, [filterStatus, filterDept]);

  async function fetchTasks() {
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set("status", filterStatus);
      if (filterDept) params.set("departmentId", filterDept);

      const res = await fetch(`/api/organizations/${orgId}/tasks?${params}`);
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
      setDepartments(data);
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

  async function fetchSuggestions(taskId: string) {
    // Toggle visibility if already loaded
    if (suggestions.length > 0) {
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
        if (startInput && parsed.scheduledStart) {
          startInput.value = parsed.scheduledStart.slice(0, 16);
        }
        if (endInput && parsed.scheduledEnd) {
          endInput.value = parsed.scheduledEnd.slice(0, 16);
        }
      }, 100);
    } catch {
      setError("Something went wrong");
    } finally {
      setParsing(false);
    }
  }

  async function onCreateTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const formData = new FormData(event.currentTarget);

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

    try {
      const res = await fetch(`/api/organizations/${orgId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskData),
      });

      const result = await res.json();

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
      (event.target as HTMLFormElement).reset();
      setRepeatFreq("");
      setRepeatInterval(1);
      setRepeatDays([]);
      setRepeatUntil("");
      fetchTasks();
    } catch {
      setError("Something went wrong");
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

  if (loading) return <PageLoading />;

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold">Tasks</h2>
        <Button onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? "Cancel" : "Create Task"}
        </Button>
      </div>

      {/* Natural language task creation */}
      <div className="mb-4 flex gap-2">
        <Input
          placeholder='Try: "I need 2 kitchen staff tomorrow morning for prep"'
          value={naturalInput}
          onChange={(e) => setNaturalInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onParseNaturalLanguage();
          }}
          className="flex-1"
        />
        <Button
          variant="outline"
          onClick={onParseNaturalLanguage}
          disabled={parsing || !naturalInput.trim()}
        >
          {parsing ? "Parsing..." : "✨ AI Create"}
        </Button>
      </div>

      {error && <AlertBanner message={error} variant="error" />}
      {success && <AlertBanner message={success} variant="success" />}

      {/* Filters */}
      <div className="mb-4 flex gap-4">
        <select
          className="rounded-md border px-3 py-2 text-sm"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select
          className="rounded-md border px-3 py-2 text-sm"
          value={filterDept}
          onChange={(e) => setFilterDept(e.target.value)}
        >
          <option value="">All departments</option>
          {departments.map((dept) => (
            <option key={dept.id} value={dept.id}>{dept.name}</option>
          ))}
        </select>
      </div>

      {/* Create task form */}
      {showCreate && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>New Task</CardTitle>
          </CardHeader>
          <form onSubmit={onCreateTask}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input id="title" name="title" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <textarea
                  id="description"
                  name="description"
                  className="w-full rounded-md border px-3 py-2 text-sm min-h-[80px]"
                  placeholder="Task details..."
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="departmentId">Department</Label>
                  <select
                    id="departmentId"
                    name="departmentId"
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  >
                    <option value="">No department</option>
                    {departments.map((dept) => (
                      <option key={dept.id} value={dept.id}>{dept.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="priority">Priority</Label>
                  <select
                    id="priority"
                    name="priority"
                    className="w-full rounded-md border px-3 py-2 text-sm"
                    defaultValue="medium"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="requiredHeadcount">Required headcount</Label>
                <Input
                  id="requiredHeadcount"
                  name="requiredHeadcount"
                  type="number"
                  min={1}
                  max={50}
                  defaultValue={1}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="requiredCertifications">Required certifications</Label>
                <Input
                  id="requiredCertifications"
                  name="requiredCertifications"
                  placeholder="e.g. Food Safety, RSA Certification"
                />
                <p className="text-xs text-muted-foreground">
                  Comma-separated. Staff must hold each as a verified, non-expired
                  certification to be eligible. Leave blank for none.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="scheduledStart">Start time</Label>
                  <Input
                    id="scheduledStart"
                    name="scheduledStart"
                    type="datetime-local"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="scheduledEnd">End time</Label>
                  <Input
                    id="scheduledEnd"
                    name="scheduledEnd"
                    type="datetime-local"
                  />
                </div>
              </div>

              {/* ─── Recurrence ─────────────────────────────────── */}
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-2">
                  <Label htmlFor="repeatFreq">Repeats</Label>
                  <select
                    id="repeatFreq"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={repeatFreq}
                    onChange={(e) =>
                      setRepeatFreq(e.target.value as "" | RecurrenceFreq)
                    }
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
                        onChange={(e) =>
                          setRepeatInterval(Number(e.target.value) || 1)
                        }
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
                        <Label className="text-xs text-muted-foreground">
                          On these days (defaults to the start day)
                        </Label>
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
                                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                                  on
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "hover:bg-muted"
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
                      <p className="text-xs text-muted-foreground">
                        Repeats on the same day of the month as the start date.
                        Months without that day are skipped.
                      </p>
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor="repeatUntil" className="text-xs text-muted-foreground">
                        Until (optional)
                      </Label>
                      <Input
                        id="repeatUntil"
                        type="date"
                        value={repeatUntil}
                        onChange={(e) => setRepeatUntil(e.target.value)}
                        className="h-8"
                      />
                    </div>

                    <p className="text-xs text-muted-foreground">
                      Occurrences are created about 2 weeks ahead and topped up
                      over time, so a long series won&apos;t flood your task list.
                    </p>
                  </>
                )}
              </div>

              <Button type="submit">Create Task</Button>
            </CardContent>
          </form>
        </Card>
      )}

      {/* Task list */}
      {tasks.length === 0 ? (
        <EmptyState title="No tasks found" />
      ) : (
        <div className="space-y-4">
          {tasks.map((task) => (
            <Card key={task.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {task.title}
                      <StatusBadge value={task.status} palette="taskStatus" />
                      <StatusBadge value={task.priority} palette="priority" />
                      {task.isRecurring && (
                        <span
                          className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                          title={
                            describeRecurrenceOf(task.recurringPattern) ?? undefined
                          }
                        >
                          ↻ {describeRecurrenceOf(task.recurringPattern) ?? "repeats"}
                        </span>
                      )}
                      {task.parentTaskId && (
                        <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs text-violet-600 dark:bg-violet-950/50 dark:text-violet-400">
                          ↻ from series
                        </span>
                      )}
                    </CardTitle>
                    <CardDescription>
                      {task.department?.name || "No department"}
                      {" · "}
                      {task.assignments.length}/{task.requiredHeadcount} assigned
                      {task.scheduledStart && (
                        <>
                          {" · "}
                          {new Date(task.scheduledStart).toLocaleString()}
                          {task.scheduledEnd && ` — ${new Date(task.scheduledEnd).toLocaleString()}`}
                        </>
                      )}
                      {task.requiredCertifications?.length > 0 && (
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="text-xs text-muted-foreground">Requires:</span>
                          {task.requiredCertifications.map((cert) => (
                            <span
                              key={cert}
                              className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700 dark:bg-purple-950 dark:text-purple-300"
                            >
                              {cert}
                            </span>
                          ))}
                        </span>
                      )}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingTaskId(editingTaskId === task.id ? null : task.id)}
                    >
                      {editingTaskId === task.id ? "Cancel" : "Edit"}
                    </Button>
                    {task.status === "open" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const newId = assigningTaskId === task.id ? null : task.id;
                          setAssigningTaskId(newId);
                          setSelectedMembers([]);
                          setOverrideReasons({});
                          setAssignError(null);
                          setSuggestions([]);
                          setShowSuggestions(false);
                          if (newId) fetchEligibility(newId);
                        }}
                      >
                        Assign
                      </Button>
                    )}

                    {/* Auto-assign — only offered when the org runs in "auto"
                        allocation mode and the task still needs staff (US-65). */}
                    {allocationMode === "auto" &&
                      task.status === "open" &&
                      task.assignments.length < task.requiredHeadcount && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onAutoAssign(task.id)}
                          disabled={autoAssigningId === task.id}
                        >
                          {autoAssigningId === task.id
                            ? "Assigning..."
                            : "⚡ Auto-assign"}
                        </Button>
                      )}

                    <select
                      className="rounded-md border px-2 py-1 text-sm"
                      value={task.status}
                      onChange={(e) => onUpdateStatus(task.id, e.target.value)}
                    >
                      <option value="open">Open</option>
                      <option value="in_progress">In progress</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onDeleteTask(task.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </CardHeader>

              {/* Edit task form */}
              {editingTaskId === task.id && (
                <CardContent>
                  <form onSubmit={(e) => onUpdateTask(e, task.id)} className="space-y-3">
                    <div className="space-y-2">
                      <Label>Title</Label>
                      <Input name="editTitle" defaultValue={task.title} required />
                    </div>
                    <div className="space-y-2">
                      <Label>Description</Label>
                      <textarea
                        name="editDescription"
                        defaultValue={task.description || ""}
                        className="w-full rounded-md border px-3 py-2 text-sm min-h-[80px]"
                        placeholder="Task details..."
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Department</Label>
                        <select
                          name="editDepartment"
                          className="w-full rounded-md border px-3 py-2 text-sm"
                          defaultValue={task.department?.id || ""}
                        >
                          <option value="">No department</option>
                          {departments.map((dept) => (
                            <option key={dept.id} value={dept.id}>{dept.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label>Priority</Label>
                        <select
                          name="editPriority"
                          className="w-full rounded-md border px-3 py-2 text-sm"
                          defaultValue={task.priority}
                        >
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="urgent">Urgent</option>
                        </select>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Required headcount</Label>
                      <Input
                        name="editHeadcount"
                        type="number"
                        min={1}
                        max={50}
                        defaultValue={task.requiredHeadcount}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Required certifications</Label>
                      <Input
                        name="editRequiredCertifications"
                        defaultValue={(task.requiredCertifications || []).join(", ")}
                        placeholder="e.g. Food Safety, RSA Certification"
                      />
                      <p className="text-xs text-muted-foreground">
                        Comma-separated. Clear the field to remove all requirements.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Start time</Label>
                        <Input
                          name="editStart"
                          type="datetime-local"
                          defaultValue={task.scheduledStart ? new Date(task.scheduledStart).toISOString().slice(0, 16) : ""}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>End time</Label>
                        <Input
                          name="editEnd"
                          type="datetime-local"
                          defaultValue={task.scheduledEnd ? new Date(task.scheduledEnd).toISOString().slice(0, 16) : ""}
                        />
                      </div>
                    </div>
                    <Button type="submit" size="sm">Save Changes</Button>
                  </form>
                </CardContent>
              )}

              {task.description && editingTaskId !== task.id && (
                <CardContent>
                  <p className="text-sm text-muted-foreground">{task.description}</p>
                </CardContent>
              )}

              {/* Assignments */}
              {task.assignments.length > 0 && (
                <CardContent>
                  <p className="mb-2 text-sm font-medium">Assigned staff</p>
                  <div className="space-y-2">
                    {task.assignments.map((a) => (
                      <div key={a.id} className="text-sm">
                        <div className="flex items-center gap-2">
                          <span>{a.membership.user.name || "Unnamed"}</span>
                          <StatusBadge value={a.status} palette="assignmentStatus" />
                          {a.clockInTime && (
                            <span className="text-xs text-muted-foreground">
                              In: {new Date(a.clockInTime).toLocaleTimeString()}
                            </span>
                          )}
                          {a.clockOutTime && (
                            <span className="text-xs text-muted-foreground">
                              Out: {new Date(a.clockOutTime).toLocaleTimeString()}
                            </span>
                          )}
                          {a.status !== "completed" && a.status !== "withdrawal_requested" && (
                            <button
                              className="text-xs text-red-500 hover:underline"
                              onClick={() => onCancelAssignment(a.id)}
                            >
                              Unassign
                            </button>
                          )}
                        </div>

                        {/* Pending withdrawal request — manager approves or denies */}
                        {a.status === "withdrawal_requested" && (
                          <div className="mt-1 rounded-md border border-orange-200 bg-orange-50 p-2 dark:border-orange-900 dark:bg-orange-950/40">
                            <p className="text-xs text-orange-800 dark:text-orange-300">
                              Requested to withdraw
                              {a.withdrawalReason ? `: "${a.withdrawalReason}"` : ""}
                            </p>
                            <div className="mt-1.5 flex gap-2">
                              <button
                                className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                                onClick={() => onResolveWithdrawal(a.id, "approve")}
                              >
                                Approve &amp; unassign
                              </button>
                              <button
                                className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
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
                </CardContent>
              )}

              {/* Assign staff panel */}
              {assigningTaskId === task.id && (
                <CardContent>
                  <div className="mb-3 flex items-center gap-3">
                    <p className="text-sm font-medium">Select staff to assign</p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => fetchSuggestions(task.id)}
                      disabled={loadingSuggestions || loadingEligibility}
                    >
                      {loadingSuggestions
                        ? "Getting suggestions..."
                        : suggestions.length > 0 && showSuggestions
                        ? "Hide Suggestions"
                        : "✨ AI Suggest"}
                    </Button>
                  </div>

                  {/* AI Suggestions */}
                  {suggestions.length > 0 && showSuggestions && (
                    <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3">
                      <p className="mb-2 text-sm font-medium text-blue-800">
                        AI Recommendations (top {task.requiredHeadcount} auto-selected)
                      </p>
                      <div className="space-y-2">
                        {suggestions.map((s) => {
                          const member = members.find(
                            (m) => m.id === s.membershipId
                          );
                          const eligEntry = Object.values(eligibility).find(
                            (e: any) => e.membershipId === s.membershipId
                          ) as any;
                          const name = member?.user.name || member?.user.email || eligEntry?.memberName || "Unknown";
                          return (
                            <div key={s.membershipId} className="text-sm">
                              <span className="font-medium text-blue-700">
                                #{s.rank} {name}
                              </span>
                              {" · "}
                              <span>Score: {s.score}/100</span>
                              {" · "}
                              <span className="text-blue-600">{s.explanation}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {loadingEligibility ? (
                    <p className="text-sm text-muted-foreground">Checking staff eligibility...</p>
                  ) : (
                    <div className="mb-3 space-y-2">
                      {members.map((m) => {
                        const elig = eligibility[m.id];
                        const isEligible = elig ? elig.eligible : true;
                        const suggestion = suggestions.find(
                          (s) => s.membershipId === m.id
                        );
                        const selected = selectedMembers.includes(m.id);
                        const atLimit =
                          !selected &&
                          selectedMembers.length >= task.requiredHeadcount;
                        const overrideReason = overrideReasons[m.id] || "";
                        const hasOverride = overrideReason.trim().length > 0;
                        const canSelect = isEligible || hasOverride;

                        // All failing dimensions, not just the first.
                        const warnings: string[] =
                          elig && !elig.eligible
                            ? (["availability", "scheduling", "workRules", "hoursLimit", "certifications"] as const)
                                .filter((k) => elig.checks[k] && !elig.checks[k].eligible)
                                .map((k) => elig.checks[k].reason || k)
                            : [];

                        return (
                          <div
                            key={m.id}
                            className={`rounded-md p-2 ${
                              !isEligible
                                ? "border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
                                : ""
                            }`}
                          >
                            <label
                              className={`flex items-center gap-2 text-sm ${
                                !canSelect || atLimit ? "opacity-60" : ""
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => toggleMemberSelection(m.id)}
                                disabled={!canSelect || atLimit}
                              />
                              <span>{m.user.name || m.user.email}</span>
                              <span className="text-xs text-muted-foreground">({m.role})</span>
                              {suggestion && (
                                <span className="text-xs text-blue-600">
                                  #{suggestion.rank} · {suggestion.score}/100
                                </span>
                              )}
                              {isEligible && !suggestion && (
                                <span className="text-xs text-green-600">✓ eligible</span>
                              )}
                              {!isEligible && (
                                <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                                  ⚠ {warnings.length} warning{warnings.length !== 1 ? "s" : ""}
                                </span>
                              )}
                            </label>

                            {/* Warnings + override-with-reason */}
                            {!isEligible && (
                              <div className="mt-1 space-y-1.5 pl-6">
                                <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-700 dark:text-amber-400">
                                  {warnings.map((w, i) => (
                                    <li key={i}>{w}</li>
                                  ))}
                                </ul>
                                <Input
                                  value={overrideReason}
                                  onChange={(e) =>
                                    setOverrideReasons((prev) => ({
                                      ...prev,
                                      [m.id]: e.target.value,
                                    }))
                                  }
                                  placeholder="Reason to assign anyway (required to override)"
                                  className="h-8 text-xs"
                                />
                                {hasOverride && (
                                  <p className="text-xs text-green-600">
                                    ✓ Override recorded on assignment — you can select this member
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {assignError && <AlertBanner message={assignError} variant="error" />}
                  <Button
                    size="sm"
                    onClick={() => onAssignStaff(task.id)}
                    disabled={loadingEligibility}
                  >
                    Confirm Assignment
                  </Button>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}