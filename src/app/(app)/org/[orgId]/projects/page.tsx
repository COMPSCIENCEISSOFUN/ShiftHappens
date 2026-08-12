/**
 * Projects (Boundary Layer).
 *
 * ## Why this page grew a plan gate
 *
 * Projects were the only capped resource on the only page with no plan
 * awareness. Every other create screen — members, tasks, departments, work
 * rules, roles — shows a `LimitNotice` beside its button and disables it at the
 * cap; this one posted regardless and let the server refuse, which since
 * projects became limited would have meant a raw error banner reading
 * "projects limit reached (1/1)" where an upgrade route should be.
 *
 * ## The three states, which are genuinely different
 *
 * A plan that includes NO projects is not the same as a plan that includes some
 * and has used them all, and neither is the same as having room and none made
 * yet. The first is an offer, the second is a decision, the third is an empty
 * page. Collapsing them — as a single "No projects yet" would — tells a Free
 * organisation to create something the server will refuse.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowUpRight,
  FolderKanban,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { LimitNotice } from "@/components/ui/plan-gate";
import { PRIMARY_BUTTON } from "@/components/ui/button-styles";
import { usePlan } from "@/components/layout/plan-provider";
import { TIER_CONFIG } from "@/lib/subscription-tiers";

type Department = { id: string; name: string; color: string | null };

type Assignment = { id: string; status: string };

type ProjectTask = {
  id: string;
  title: string;
  status: string;
  requiredHeadcount: number;
  assignments: Assignment[];
};

type ProjectMember = {
  id: string;
  membershipId: string;
  membership: {
    id: string;
    user: { id: string; name: string | null; email: string };
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
  department: Department | null;
  createdBy: { id: string; name: string | null; email: string };
  projectMembers: ProjectMember[];
  tasks: ProjectTask[];
};

const SLOT_STATUSES = new Set([
  "assigned",
  "accepted",
  "in_progress",
  "clocked_out",
  "completed",
  "withdrawal_requested",
]);

function formatRange(start: string | null, end: string | null) {
  if (!start || !end) return "No timeframe set";

  const options = {
    month: "short",
    day: "numeric",
    year: "numeric",
  } as const;

  return `${new Date(start).toLocaleDateString([], options)} to ${new Date(
    end
  ).toLocaleDateString([], options)}`;
}

function metrics(project: Project) {
  const complete = project.tasks.filter(
    (task) => task.status === "completed"
  ).length;
  const total = project.tasks.length;
  const progress = total === 0 ? 0 : Math.round((complete / total) * 100);

  const active = project.tasks.filter(
    (task) => !["completed", "cancelled"].includes(task.status)
  );

  const required = active.reduce(
    (sum, task) => sum + task.requiredHeadcount,
    0
  );

  const staffed = active.reduce((sum, task) => {
    const filled = task.assignments.filter((assignment) =>
      SLOT_STATUSES.has(assignment.status)
    ).length;
    return sum + Math.min(filled, task.requiredHeadcount);
  }, 0);

  return {
    complete,
    total,
    progress,
    required,
    staffed,
    gap: Math.max(0, required - staffed),
  };
}

export default function ProjectsPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const plan = usePlan();

  const [projects, setProjects] = useState<Project[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [projectResponse, departmentResponse] = await Promise.all([
        fetch(`/api/organizations/${orgId}/projects`),
        fetch(`/api/organizations/${orgId}/departments`),
      ]);

      const departmentData = departmentResponse.ok
        ? await departmentResponse.json()
        : [];
      setDepartments(Array.isArray(departmentData) ? departmentData : []);

      if (!projectResponse.ok) throw new Error("Failed to load projects");

      const projectData = await projectResponse.json();
      setProjects(Array.isArray(projectData) ? projectData : []);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load projects"
      );
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: loads projects and departments on mount
    void load();
  }, [load]);

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const values = new FormData(event.currentTarget);
    const departmentIds = Array.from(
      event.currentTarget.querySelectorAll<HTMLInputElement>(
        'input[name="departmentIds"]:checked'
      )
    ).map((input) => input.value);

    const start = String(values.get("plannedStart") || "");
    const end = String(values.get("plannedEnd") || "");

    const response = await fetch(`/api/organizations/${orgId}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: values.get("title"),
        description: values.get("description") || undefined,
        departmentIds,
        priority: values.get("priority"),
        staffingMode: values.get("staffingMode") || undefined,
        plannedStart: start ? new Date(start).toISOString() : undefined,
        plannedEnd: end ? new Date(end).toISOString() : undefined,
      }),
    });

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      setError(result?.error || "Could not create project");
      return;
    }

    setShowCreate(false);
    toast.success(
      result.staffingMode === "project_team"
        ? "Project created. Open the project to build its Project Team."
        : "Project created."
    );
    await load();
  }

  if (loading) return <PageLoading label="Loading projects" />;

  const limit = plan.limitFor("projects");
  /*
   * "Not on this plan" and "used them all" are separate questions and get
   * separate answers. `limit === 0` is a plan that never included projects;
   * `atLimit` is a plan that did and is full.
   */
  const notOnPlan = limit === 0;
  const full = plan.atLimit("projects");
  const canCreate = !notOnPlan && !full;

  const portfolio = projects.reduce(
    (totals, project) => {
      const m = metrics(project);
      return {
        tasks: totals.tasks + m.total,
        progress: totals.progress + m.progress,
        gaps: totals.gaps + m.gap,
      };
    },
    { tasks: 0, progress: 0, gaps: 0 }
  );
  const averageProgress =
    projects.length === 0 ? 0 : Math.round(portfolio.progress / projects.length);

  return (
    <div className="max-w-7xl pb-10">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-col gap-4 border-b border-border/70 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Project workspace
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Projects</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Keep a clear record of the outcome, owner, linked work, and progress
            for larger initiatives.
          </p>
        </div>

        {!notOnPlan && (
          <div className="flex shrink-0 items-center gap-2.5">
            <LimitNotice resource="projects" noun="projects" />
            {/* Disabled at the cap, not refused on save. Cancel stays live. */}
            <Button
              onClick={() => setShowCreate((current) => !current)}
              disabled={!showCreate && full}
            >
              {showCreate ? "Cancel" : "New project"}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <AlertBanner className="mb-4" variant="error" message={error} />
      )}

      {/*
        The cap, met.

        Shown instead of an error because being at the limit is not a mistake —
        it is the plan working. The route out is named and priced rather than
        described, so nobody has to go and find out what the next plan costs.
      */}
      {full && !notOnPlan && (
        <div className="mb-6 overflow-hidden rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-violet-50 dark:border-indigo-900 dark:from-indigo-950/50 dark:to-violet-950/30">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600/10 dark:bg-indigo-400/10">
                <Sparkles
                  className="size-5 text-indigo-600 dark:text-indigo-400"
                  aria-hidden="true"
                />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  You have used all {limit} project{limit === 1 ? "" : "s"} on{" "}
                  {plan.tierName}
                </p>
                <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
                  Enterprise runs unlimited projects for $
                  {TIER_CONFIG.enterprise.monthlyPrice} a month, with unlimited
                  members and tasks alongside them. Delete a project to free the
                  slot, or move up.
                </p>
              </div>
            </div>
            <Link
              href={`/org/${orgId}/billing`}
              className={`${PRIMARY_BUTTON} shrink-0`}
            >
              Compare plans
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      )}

      {/* ── Portfolio summary ──────────────────────────────────────────── */}
      {projects.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <StatTile
            label="Projects"
            value={projects.length}
            detail={limit === null ? "unlimited on your plan" : `of ${limit} available`}
            accentColour={STAT_ACCENT.indigo}
          />
          <StatTile
            label="Avg progress"
            value={`${averageProgress}%`}
            detail="across all projects"
            accentColour={STAT_ACCENT.green}
            valueColour="text-green-600 dark:text-green-400"
          />
          <StatTile
            label="Work items"
            value={portfolio.tasks}
            detail="linked to projects"
            accentColour={STAT_ACCENT.blue}
          />
          <StatTile
            label="Staffing gaps"
            value={portfolio.gaps}
            detail={portfolio.gaps > 0 ? "positions need staff" : "everything covered"}
            accentColour={portfolio.gaps > 0 ? STAT_ACCENT.amber : STAT_ACCENT.slate}
            valueColour={
              portfolio.gaps > 0 ? "text-amber-600 dark:text-amber-400" : ""
            }
          />
        </div>
      )}

      {showCreate && canCreate && (
        <form
          onSubmit={createProject}
          className="mb-8 grid gap-5 rounded-2xl border border-border bg-card p-6 shadow-sm sm:grid-cols-2"
        >
          <div className="sm:col-span-2">
            <Label>Project name</Label>
            <Input
              name="title"
              required
              className="mt-1"
              placeholder="e.g. Atlas API Release"
            />
          </div>

          <div className="sm:col-span-2">
            <Label>Outcome and context</Label>
            <textarea
              name="description"
              className="mt-1 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="What does successful completion look like?"
            />
          </div>

          <div className="sm:col-span-2">
            <Label>Departments</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose every department involved. Cross-department projects are
              available to company admins.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {departments.map((department) => (
                <label
                  key={department.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border p-3 text-sm transition-colors hover:bg-muted/40"
                >
                  <input
                    name="departmentIds"
                    value={department.id}
                    type="checkbox"
                    onChange={() => setError(null)}
                  />
                  {department.name}
                </label>
              ))}
            </div>
            {departments.length === 0 && (
              <p className="mt-2 text-sm text-destructive">
                No departments are available for this account.
              </p>
            )}
          </div>

          <div>
            <Label>Priority</Label>
            <select
              name="priority"
              defaultValue="medium"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          <div>
            <Label>Target start</Label>
            <Input name="plannedStart" type="datetime-local" className="mt-1" />
          </div>

          <div>
            <Label>Target completion</Label>
            <Input name="plannedEnd" type="datetime-local" className="mt-1" />
          </div>

          <details className="rounded-xl border border-border px-4 py-3 sm:col-span-2">
            <summary className="cursor-pointer text-sm font-medium">
              Private project access
              <span className="ml-2 font-normal text-muted-foreground">
                Limit this project to selected participants
              </span>
            </summary>

            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 transition-colors hover:bg-muted/40">
              <input
                type="checkbox"
                name="staffingMode"
                value="project_team"
                className="mt-1"
              />
              <div>
                <p className="text-sm font-semibold">
                  Choose the people who can participate
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Only company admins, you, and the participants you add after
                  creation can view this project or receive its work items. Leave
                  unchecked to let all eligible staff participate.
                </p>
              </div>
            </label>
          </details>

          <div className="sm:col-span-2">
            <Button type="submit">Create project log</Button>
          </div>
        </form>
      )}

      {/* ── The list, or why there is not one ──────────────────────────── */}
      {notOnPlan ? (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="border-b border-border bg-gradient-to-br from-indigo-50 to-violet-50 px-6 py-8 text-center dark:from-indigo-950/50 dark:to-violet-950/30">
            <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-indigo-600/10 dark:bg-indigo-400/10">
              <FolderKanban
                className="size-6 text-indigo-600 dark:text-indigo-400"
                aria-hidden="true"
              />
            </div>
            <h2 className="mt-4 text-lg font-semibold">
              Projects are part of {TIER_CONFIG.pro.displayName}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground">
              Group related work under one outcome, track progress across every
              linked task, and see staffing gaps before they become a problem.
              Your organisation is on {plan.tierName}.
            </p>
            <Link
              href={`/org/${orgId}/billing`}
              className={`${PRIMARY_BUTTON} mt-5`}
            >
              See {TIER_CONFIG.pro.displayName} — $
              {TIER_CONFIG.pro.monthlyPrice}/mo
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>

          <div className="grid gap-4 p-6 sm:grid-cols-3">
            {[
              {
                icon: FolderKanban,
                title: "One outcome, many tasks",
                body: "Link work items to a shared goal instead of tracking them apart.",
              },
              {
                icon: TrendingUp,
                title: "Progress at a glance",
                body: "Completion is derived from the linked work, not typed in by hand.",
              },
              {
                icon: Users,
                title: "Staffing gaps surfaced",
                body: "See unfilled positions across the project before the start date.",
              },
            ].map((point) => (
              <div key={point.title} className="flex flex-col gap-2">
                <point.icon
                  className="size-4 text-indigo-600 dark:text-indigo-400"
                  aria-hidden="true"
                />
                <p className="text-[13px] font-medium">{point.title}</p>
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  {point.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create a project when several work items contribute to one shared outcome."
          action={
            canCreate ? (
              <Button onClick={() => setShowCreate(true)}>
                Create your first project
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {projects.map((project) => {
            const m = metrics(project);

            return (
              <article
                key={project.id}
                className="group relative overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg"
              >
                <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary via-indigo-400 to-violet-400 opacity-80" />

                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/org/${orgId}/projects/${project.id}`}
                      className="text-xl font-semibold tracking-tight transition group-hover:text-primary"
                    >
                      {project.title}
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {project.department?.name || "Organisation-wide"} ·{" "}
                      {formatRange(project.plannedStart, project.plannedEnd)}
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Owner: {project.createdBy.name || project.createdBy.email}
                    </p>
                  </div>

                  <StatusBadge value={project.status} palette="taskStatus" />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <StatusBadge value={project.priority} palette="priority" />

                  <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-300">
                    {project.staffingMode === "project_team"
                      ? "Private project"
                      : "Open participation"}
                  </span>

                  {project.staffingMode === "project_team" && (
                    <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium">
                      {project.projectMembers.length} participant(s)
                    </span>
                  )}
                </div>

                {project.description && (
                  <p className="mt-5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                    {project.description}
                  </p>
                )}

                <div className="mt-6 grid grid-cols-2 gap-3 border-t border-border/70 pt-5">
                  <div className="rounded-xl bg-primary/5 p-4">
                    <p className="text-xs font-semibold">Progress</p>
                    <p className="mt-1 text-2xl font-semibold">{m.progress}%</p>
                    <p className="text-xs text-muted-foreground">
                      {m.complete}/{m.total} work items
                    </p>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-primary/15">
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-500"
                        style={{ width: `${m.progress}%` }}
                      />
                    </div>
                  </div>

                  <div className="rounded-xl bg-muted/50 p-4">
                    <p className="text-xs font-semibold">Staffing</p>
                    <p className="mt-1 text-2xl font-semibold">
                      {m.staffed}/{m.required}
                    </p>
                    <p
                      className={
                        m.gap > 0
                          ? "text-xs font-medium text-amber-600 dark:text-amber-400"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {m.gap > 0
                        ? `${m.gap} position(s) need staff`
                        : "Current work covered"}
                    </p>
                  </div>
                </div>

                <div className="mt-6 flex items-center justify-between border-t border-border/70 pt-5">
                  <p className="text-xs text-muted-foreground">
                    {project.tasks.length} work item(s)
                  </p>

                  <Button
                    size="sm"
                    nativeButton={false}
                    render={
                      <Link href={`/org/${orgId}/projects/${project.id}`} />
                    }
                  >
                    Open workspace
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
