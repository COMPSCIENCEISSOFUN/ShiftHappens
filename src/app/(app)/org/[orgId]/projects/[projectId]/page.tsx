"use client";

/**
 * Project detail page.
 *
 * Shows one Project: its overview, progress, staffing summary, the
 * persistent Project Team (Project Team staffing only), and its work
 * items. Work items are ordinary Tasks linked by projectId — this page
 * shows their useful detail inline and links out to full Task
 * management rather than duplicating it.
 */

import { useCallback, useEffect, useState } from "react";

import Link from "next/link";
import { useParams } from "next/navigation";

import { ChevronLeft, ClipboardList, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { StatusBadge } from "@/components/ui/status-badge";

type Department = { id: string; name: string; color: string | null };

type Assignment = {
  id: string;
  membershipId: string;
  status: string;
  membership: {
    id: string;
    user: { id: string; name: string | null; email: string };
  };
};

type ProjectTask = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  instructions: string | null;
  status: string;
  priority: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  requiredHeadcount: number;
  requiredCertifications: string[];
  assignments: Assignment[];
};

type ProjectMember = {
  id: string;
  membershipId: string;
  membership: {
    id: string;
    role: string;
    status: string;
    employmentType: string | null;
    user: { id: string; name: string | null; email: string; image: string | null };
    departmentMemberships: { department: { id: string; name: string } }[];
  };
};

type Project = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  staffingMode: "task_based" | "project_team";
  plannedStart: string | null;
  plannedEnd: string | null;
  departmentId: string | null;
  department: Department | null;
  projectMembers: ProjectMember[];
  tasks: ProjectTask[];
};

type OrgMember = {
  id: string;
  role: string;
  status: string;
  user: { id: string; name: string | null; email: string };
  departmentMemberships: { department: { id: string; name: string } }[];
};

/** Assignment states that actually occupy one of a task's required slots. */
const SLOT_STATUSES = new Set([
  "assigned",
  "in_progress",
  "clocked_out",
  "completed",
  "withdrawal_requested",
]);

const CLOSED_PROJECT_STATUSES = new Set(["completed", "cancelled"]);

function formatDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRange(start: string | null, end: string | null) {
  if (!start || !end) return "No timeframe set";
  return `${formatDate(start)} to ${formatDate(end)}`;
}

/** Converts an ISO string into the value a datetime-local input expects. */
function toLocalInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function metricsFor(project: Project) {
  const total = project.tasks.length;
  const complete = project.tasks.filter((task) => task.status === "completed").length;
  const progress = total === 0 ? 0 : Math.round((complete / total) * 100);

  const active = project.tasks.filter(
    (task) => !["completed", "cancelled"].includes(task.status)
  );
  const required = active.reduce((sum, task) => sum + task.requiredHeadcount, 0);
  const staffed = active.reduce((sum, task) => {
    const filled = task.assignments.filter((assignment) =>
      SLOT_STATUSES.has(assignment.status)
    ).length;
    return sum + Math.min(filled, task.requiredHeadcount);
  }, 0);

  return { total, complete, progress, required, staffed, gap: Math.max(0, required - staffed) };
}

export default function ProjectDetailPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const projectId = params.projectId as string;

  const [project, setProject] = useState<Project | null>(null);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [showEdit, setShowEdit] = useState(false);
  const [showTeam, setShowTeam] = useState(false);
  const [showAddWork, setShowAddWork] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<Set<string>>(new Set());
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [projectResponse, memberResponse] = await Promise.all([
        fetch(`/api/organizations/${orgId}/projects/${projectId}`),
        fetch(`/api/organizations/${orgId}/members?limit=100`),
      ]);

      if (!projectResponse.ok) {
        throw new Error(
          projectResponse.status === 404
            ? "Project not found, or it is outside your department scope."
            : "Failed to load project"
        );
      }

      const projectData: Project = await projectResponse.json();
      setProject(projectData);
      setSelectedTeam(
        new Set(projectData.projectMembers.map((member) => member.membershipId))
      );
      setOrgMembers(memberResponse.ok ? await memberResponse.json() : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load project");
    } finally {
      setLoading(false);
    }
  }, [orgId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Staff the manager may add to the Project Team. The server re-checks
   * this in ProjectService.setTeam — this only keeps the picker honest.
   */
  const projectDepartmentId = project?.departmentId ?? null;
  const teamCandidates = orgMembers.filter((member) => {
    if (member.role !== "staff" || member.status !== "active") return false;
    if (!projectDepartmentId) return true;
    return member.departmentMemberships.some(
      (link) => link.department.id === projectDepartmentId
    );
  });

  async function send(url: string, method: string, body: unknown, okMessage: string) {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        setError(result?.error || "Request failed");
        return false;
      }
      setSuccess(okMessage);
      await load();
      return true;
    } catch {
      setError("Request failed");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const start = String(values.get("plannedStart") || "");
    const end = String(values.get("plannedEnd") || "");

    const ok = await send(
      `/api/organizations/${orgId}/projects/${projectId}`,
      "PATCH",
      {
        title: values.get("title"),
        description: String(values.get("description") || ""),
        priority: values.get("priority"),
        status: values.get("status"),
        staffingMode: values.get("staffingMode"),
        plannedStart: start ? new Date(start).toISOString() : "",
        plannedEnd: end ? new Date(end).toISOString() : "",
      },
      "Project updated."
    );
    if (ok) setShowEdit(false);
  }

  async function saveTeam() {
    const ok = await send(
      `/api/organizations/${orgId}/projects/${projectId}/team`,
      "PUT",
      { membershipIds: [...selectedTeam] },
      "Project Team updated."
    );
    if (ok) setShowTeam(false);
  }

  async function addWorkItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const start = String(values.get("scheduledStart") || "");
    const end = String(values.get("scheduledEnd") || "");

    const ok = await send(
      `/api/organizations/${orgId}/tasks`,
      "POST",
      {
        title: values.get("title"),
        description: String(values.get("description") || "") || undefined,
        projectId,
        departmentId: project?.departmentId || undefined,
        priority: values.get("priority"),
        requiredHeadcount: Number(values.get("requiredHeadcount")) || 1,
        scheduledStart: start ? new Date(start).toISOString() : undefined,
        scheduledEnd: end ? new Date(end).toISOString() : undefined,
      },
      "Work item added."
    );
    if (ok) setShowAddWork(false);
  }

  if (loading) return <PageLoading label="Loading project" />;

  if (!project) {
    return (
      <div className="max-w-3xl">
        <Link
          href={`/org/${orgId}/projects`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" /> Projects
        </Link>
        <div className="mt-4">
          <AlertBanner variant="error" message={error || "Project not found"} />
        </div>
      </div>
    );
  }

  const metrics = metricsFor(project);
  const isProjectTeam = project.staffingMode === "project_team";
  const isClosed = CLOSED_PROJECT_STATUSES.has(project.status);

  return (
    <div className="max-w-5xl">
      {/* ── Breadcrumb ─────────────────────────────── */}
      <Link
        href={`/org/${orgId}/projects`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Projects
      </Link>

      {error && (
        <div className="mt-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}
      {success && (
        <div className="mt-4">
          <AlertBanner
            variant="success"
            message={success}
            onDismiss={() => setSuccess(null)}
          />
        </div>
      )}

      {/* ── Overview ───────────────────────────────── */}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{project.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {project.department?.name || "No department"} ·{" "}
            {formatRange(project.plannedStart, project.plannedEnd)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusBadge value={project.status} palette="taskStatus" />
            <StatusBadge value={project.priority} palette="priority" />
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300">
              {isProjectTeam ? "Project Team" : "Task-based"}
            </span>
          </div>
        </div>

        <Button variant="outline" size="sm" onClick={() => setShowEdit((open) => !open)}>
          {showEdit ? "Cancel" : "Edit project"}
        </Button>
      </div>

      {project.description && !showEdit && (
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          {project.description}
        </p>
      )}

      {/* ── Edit project ───────────────────────────── */}
      {showEdit && (
        <form
          onSubmit={saveProject}
          className="mt-5 grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2"
        >
          <div className="sm:col-span-2">
            <Label htmlFor="title">Title</Label>
            <Input id="title" name="title" defaultValue={project.title} className="mt-1" required />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="description">Outcome / description</Label>
            <textarea
              id="description"
              name="description"
              rows={3}
              defaultValue={project.description || ""}
              className="mt-1 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>

          <div>
            <Label htmlFor="priority">Priority</Label>
            <select
              id="priority"
              name="priority"
              defaultValue={project.priority}
              className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          <div>
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              name="status"
              defaultValue={project.status}
              className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="planning">Planning</option>
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="staffingMode">Staffing approach</Label>
            <select
              id="staffingMode"
              name="staffingMode"
              defaultValue={project.staffingMode}
              className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="task_based">Task-based allocation</option>
              <option value="project_team">Project Team</option>
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Switching to task-based clears the persistent Project Team. Existing work
              item assignments are kept.
            </p>
          </div>

          <div>
            <Label htmlFor="plannedStart">Planned start</Label>
            <Input
              id="plannedStart"
              name="plannedStart"
              type="datetime-local"
              defaultValue={toLocalInput(project.plannedStart)}
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="plannedEnd">Planned end</Label>
            <Input
              id="plannedEnd"
              name="plannedEnd"
              type="datetime-local"
              defaultValue={toLocalInput(project.plannedEnd)}
              className="mt-1"
            />
          </div>

          <div className="sm:col-span-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      )}

      {/* ── Progress & staffing summary ────────────── */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-semibold text-muted-foreground">Progress</p>
          <p className="mt-1 text-2xl font-semibold">{metrics.progress}%</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${metrics.progress}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {metrics.complete}/{metrics.total} work items complete
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-semibold text-muted-foreground">Active staffing</p>
          <p className="mt-1 text-2xl font-semibold">
            {metrics.staffed}/{metrics.required}
          </p>
          <p
            className={
              metrics.gap > 0
                ? "mt-2 text-xs font-medium text-amber-600 dark:text-amber-400"
                : "mt-2 text-xs text-muted-foreground"
            }
          >
            {metrics.gap > 0
              ? `${metrics.gap} position(s) need staff`
              : "Current work covered"}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-semibold text-muted-foreground">
            {isProjectTeam ? "Project Team" : "Staffing approach"}
          </p>
          <p className="mt-1 text-2xl font-semibold">
            {isProjectTeam ? project.projectMembers.length : "—"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {isProjectTeam
              ? "persistent member(s)"
              : "Every work item draws on all eligible staff"}
          </p>
        </div>
      </div>

      {/* ── Project Team (project_team only) ───────── */}
      {isProjectTeam && (
        <section className="mt-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Users className="h-4 w-4" /> Project Team
            </h2>
            {!isClosed && (
              <Button variant="outline" size="sm" onClick={() => setShowTeam((open) => !open)}>
                {showTeam ? "Cancel" : "Manage team"}
              </Button>
            )}
          </div>

          <p className="mt-1 text-sm text-muted-foreground">
            Members stay on the team for the whole project. This does not reserve their
            schedule — availability, conflicts, hours and certifications are still checked
            when each work item is assigned.
          </p>

          {showTeam ? (
            <div className="mt-4 rounded-xl border border-border bg-card p-5">
              {teamCandidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No active staff available in{" "}
                  {project.department?.name || "this organization"}.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {teamCandidates.map((candidate) => {
                    const checked = selectedTeam.has(candidate.id);
                    return (
                      <label
                        key={candidate.id}
                        className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 text-sm hover:bg-muted/40"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setSelectedTeam((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(candidate.id);
                              else next.delete(candidate.id);
                              return next;
                            });
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {candidate.user.name || candidate.user.email}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {candidate.user.email}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}

              <div className="mt-4 flex items-center gap-2">
                <Button onClick={saveTeam} disabled={saving}>
                  {saving ? "Saving…" : "Save team"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {selectedTeam.size} selected
                </p>
              </div>
            </div>
          ) : project.projectMembers.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                icon={Users}
                title="No team members yet"
                description="Automatic allocation for this project's work items will return no candidates until the Project Team has members."
              />
            </div>
          ) : (
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {project.projectMembers.map((member) => (
                <li
                  key={member.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {member.membership.user.name || member.membership.user.email}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {member.membership.departmentMemberships
                        .map((link) => link.department.name)
                        .join(", ") || "No department"}
                    </p>
                  </div>
                  <StatusBadge value={member.membership.status} palette="taskStatus" />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── Work items ─────────────────────────────── */}
      <section className="mt-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <ClipboardList className="h-4 w-4" /> Work items
          </h2>
          <div className="flex items-center gap-2">
            <Link
              href={`/org/${orgId}/tasks?projectId=${project.id}`}
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Open in task management
            </Link>
            {!isClosed && (
              <Button size="sm" onClick={() => setShowAddWork((open) => !open)}>
                {showAddWork ? "Cancel" : "Add work item"}
              </Button>
            )}
          </div>
        </div>

        {showAddWork && (
          <form
            onSubmit={addWorkItem}
            className="mt-4 grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2"
          >
            <div className="sm:col-span-2">
              <Label htmlFor="workTitle">Title</Label>
              <Input id="workTitle" name="title" className="mt-1" required />
            </div>

            <div className="sm:col-span-2">
              <Label htmlFor="workDescription">Description</Label>
              <textarea
                id="workDescription"
                name="description"
                rows={2}
                className="mt-1 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>

            <div>
              <Label htmlFor="workPriority">Priority</Label>
              <select
                id="workPriority"
                name="priority"
                defaultValue={project.priority}
                className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Defaults to the project priority.
              </p>
            </div>

            <div>
              <Label htmlFor="workHeadcount">Required headcount</Label>
              <Input
                id="workHeadcount"
                name="requiredHeadcount"
                type="number"
                min={1}
                max={50}
                defaultValue={1}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="workStart">Scheduled start</Label>
              <Input
                id="workStart"
                name="scheduledStart"
                type="datetime-local"
                min={toLocalInput(project.plannedStart) || undefined}
                max={toLocalInput(project.plannedEnd) || undefined}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="workEnd">Scheduled end</Label>
              <Input
                id="workEnd"
                name="scheduledEnd"
                type="datetime-local"
                min={toLocalInput(project.plannedStart) || undefined}
                max={toLocalInput(project.plannedEnd) || undefined}
                className="mt-1"
              />
            </div>

            <div className="sm:col-span-2">
              <Button type="submit" disabled={saving}>
                {saving ? "Adding…" : "Add work item"}
              </Button>
              {(project.plannedStart || project.plannedEnd) && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Work item schedules must stay within{" "}
                  {formatRange(project.plannedStart, project.plannedEnd)}.
                </p>
              )}
            </div>
          </form>
        )}

        {project.tasks.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={ClipboardList}
              title="No work items yet"
              description="Add the deliverables that make up this project. They behave like normal tasks."
            />
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {project.tasks.map((task) => {
              const filled = task.assignments.filter((assignment) =>
                SLOT_STATUSES.has(assignment.status)
              );
              const isOpen = openTaskId === task.id;

              return (
                <li key={task.id} className="rounded-xl border border-border bg-card">
                  <button
                    type="button"
                    onClick={() => setOpenTaskId(isOpen ? null : task.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start justify-between gap-3 p-4 text-left"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{task.title}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <StatusBadge value={task.status} palette="taskStatus" />
                        <StatusBadge value={task.priority} palette="priority" />
                        <span className="text-xs text-muted-foreground">
                          {filled.length}/{task.requiredHeadcount} staffed
                        </span>
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDateTime(task.scheduledStart) || "Unscheduled"}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-border px-4 py-4 text-sm">
                      {task.description && (
                        <p className="text-muted-foreground">{task.description}</p>
                      )}

                      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                        <div>
                          <dt className="text-xs font-semibold text-muted-foreground">
                            Scheduled
                          </dt>
                          <dd>
                            {task.scheduledStart && task.scheduledEnd
                              ? `${formatDateTime(task.scheduledStart)} — ${formatDateTime(task.scheduledEnd)}`
                              : "Not scheduled"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs font-semibold text-muted-foreground">
                            Location
                          </dt>
                          <dd>{task.location || "—"}</dd>
                        </div>
                        {task.requiredCertifications.length > 0 && (
                          <div className="sm:col-span-2">
                            <dt className="text-xs font-semibold text-muted-foreground">
                              Required certifications
                            </dt>
                            <dd>{task.requiredCertifications.join(", ")}</dd>
                          </div>
                        )}
                        {task.instructions && (
                          <div className="sm:col-span-2">
                            <dt className="text-xs font-semibold text-muted-foreground">
                              Instructions
                            </dt>
                            <dd className="whitespace-pre-line">{task.instructions}</dd>
                          </div>
                        )}
                      </dl>

                      <div className="mt-4">
                        <p className="text-xs font-semibold text-muted-foreground">
                          Assigned staff
                        </p>
                        {task.assignments.length === 0 ? (
                          <p className="mt-1 text-muted-foreground">
                            Nobody assigned yet.
                            {isProjectTeam && project.projectMembers.length === 0
                              ? " Add Project Team members before allocating."
                              : ""}
                          </p>
                        ) : (
                          <ul className="mt-2 space-y-1.5">
                            {task.assignments.map((assignment) => (
                              <li
                                key={assignment.id}
                                className="flex items-center justify-between gap-3"
                              >
                                <span className="truncate">
                                  {assignment.membership.user.name ||
                                    assignment.membership.user.email}
                                </span>
                                <StatusBadge
                                  value={assignment.status}
                                  palette="assignmentStatus"
                                />
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <Link
                        href={`/org/${orgId}/tasks?projectId=${project.id}`}
                        className="mt-4 inline-block text-sm text-primary underline-offset-4 hover:underline"
                      >
                        Manage this work item in Tasks
                      </Link>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
