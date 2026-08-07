"use client";

import {
  useCallback,
  useEffect,
  useState,
} from "react";

import Link from "next/link";
import { useParams } from "next/navigation";

import {
  Button,
} from "@/components/ui/button";

import {
  Input,
} from "@/components/ui/input";

import {
  Label,
} from "@/components/ui/label";

import {
  AlertBanner,
} from "@/components/ui/alert-banner";

import {
  EmptyState,
} from "@/components/ui/empty-state";

import {
  PageLoading,
} from "@/components/ui/page-loading";

import {
  StatusBadge,
} from "@/components/ui/status-badge";

type Department = {
  id: string;
  name: string;
  color: string | null;
};

type Assignment = {
  id: string;
  status: string;
};

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

    user: {
      id: string;
      name: string | null;
      email: string;
    };
  };
};

type Project = {
  id: string;
  title: string;
  description: string | null;

  status: string;
  priority: string;

  staffingMode:
    | "task_based"
    | "project_team";

  plannedStart: string | null;
  plannedEnd: string | null;

  department:
    | Department
    | null;

  projectMembers:
    ProjectMember[];

  tasks: ProjectTask[];
};

const SLOT_STATUSES =
  new Set([
    "assigned",
    "in_progress",
    "clocked_out",
    "completed",
    "withdrawal_requested",
  ]);

function formatRange(
  start: string | null,
  end: string | null
) {
  if (!start || !end) {
    return "No timeframe set";
  }

  const startDate =
    new Date(start);

  const endDate =
    new Date(end);

  return `${startDate.toLocaleDateString(
    [],
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    }
  )} to ${endDate.toLocaleDateString(
    [],
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    }
  )}`;
}

function metrics(
  project: Project
) {
  const complete =
    project.tasks.filter(
      (task) =>
        task.status ===
        "completed"
    ).length;

  const total =
    project.tasks.length;

  const progress =
    total === 0
      ? 0
      : Math.round(
          (complete / total) *
            100
        );

  const active =
    project.tasks.filter(
      (task) =>
        ![
          "completed",
          "cancelled",
        ].includes(
          task.status
        )
    );

  const required =
    active.reduce(
      (sum, task) =>
        sum +
        task.requiredHeadcount,
      0
    );

  const staffed =
    active.reduce(
      (sum, task) => {
        const filled =
          task.assignments.filter(
            (assignment) =>
              SLOT_STATUSES.has(
                assignment.status
              )
          ).length;

        return (
          sum +
          Math.min(
            filled,
            task.requiredHeadcount
          )
        );
      },
      0
    );

  return {
    complete,
    total,
    progress,
    required,
    staffed,
    gap: Math.max(
      0,
      required - staffed
    ),
  };
}

export default function ProjectsPage() {
  const params = useParams();

  const orgId =
    params.orgId as string;

  const [
    projects,
    setProjects,
  ] = useState<Project[]>([]);

  const [
    departments,
    setDepartments,
  ] = useState<Department[]>([]);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    showCreate,
    setShowCreate,
  ] = useState(false);

  const [
    error,
    setError,
  ] =
    useState<string | null>(
      null
    );

  const [
    success,
    setSuccess,
  ] =
    useState<string | null>(
      null
    );

  const load =
    useCallback(async () => {
      try {
        const [
          projectResponse,
          departmentResponse,
        ] =
          await Promise.all([
            fetch(
              `/api/organizations/${orgId}/projects`
            ),

            fetch(
              `/api/organizations/${orgId}/departments?scope=mine`
            ),
          ]);

        if (
          !projectResponse.ok
        ) {
          throw new Error(
            "Failed to load projects"
          );
        }

        const projectData =
          await projectResponse.json();

        const departmentData =
          departmentResponse.ok
            ? await departmentResponse.json()
            : [];

        setProjects(
          Array.isArray(
            projectData
          )
            ? projectData
            : []
        );

        setDepartments(
          Array.isArray(
            departmentData
          )
            ? departmentData
            : []
        );
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load projects"
        );
      } finally {
        setLoading(false);
      }
    }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createProject(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setError(null);
    setSuccess(null);

    const values =
      new FormData(
        event.currentTarget
      );

    const start =
      String(
        values.get(
          "plannedStart"
        ) || ""
      );

    const end =
      String(
        values.get(
          "plannedEnd"
        ) || ""
      );

    const response =
      await fetch(
        `/api/organizations/${orgId}/projects`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            title:
              values.get(
                "title"
              ),

            description:
              values.get(
                "description"
              ) ||
              undefined,

            departmentId:
              values.get(
                "departmentId"
              ) ||
              undefined,

            priority:
              values.get(
                "priority"
              ),

            staffingMode:
              values.get(
                "staffingMode"
              ),

            plannedStart:
              start
                ? new Date(
                    start
                  ).toISOString()
                : undefined,

            plannedEnd:
              end
                ? new Date(
                    end
                  ).toISOString()
                : undefined,
          }),
        }
      );

    const result =
      await response
        .json()
        .catch(() => null);

    if (!response.ok) {
      setError(
        result?.error ||
          "Could not create project"
      );

      return;
    }

    setShowCreate(false);

    setSuccess(
      result.staffingMode ===
        "project_team"
        ? "Project created. Open the project to build its Project Team."
        : "Project created."
    );

    await load();
  }

  if (loading) {
    return (
      <PageLoading label="Loading projects" />
    );
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Projects
          </h1>

          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Group related work
            under a shared
            outcome and manage
            either task-based
            allocation or a
            persistent Project
            Team.
          </p>
        </div>

        <Button
          onClick={() =>
            setShowCreate(
              (current) =>
                !current
            )
          }
        >
          {showCreate
            ? "Cancel"
            : "New project"}
        </Button>
      </div>

      {error && (
        <AlertBanner
          className="mb-4"
          variant="error"
          message={error}
        />
      )}

      {success && (
        <AlertBanner
          className="mb-4"
          variant="success"
          message={success}
        />
      )}

      {showCreate && (
        <form
          onSubmit={
            createProject
          }
          className="mb-6 grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2"
        >
          <div className="sm:col-span-2">
            <Label>
              Project name
            </Label>

            <Input
              name="title"
              required
              className="mt-1"
              placeholder="e.g. Atlas API Release"
            />
          </div>

          <div className="sm:col-span-2">
            <Label>
              Outcome and context
            </Label>

            <textarea
              name="description"
              className="mt-1 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="What does successful completion look like?"
            />
          </div>

          <div>
            <Label>
              Department
            </Label>

            <select
              name="departmentId"
              required
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">
                Choose department
              </option>

              {departments.map(
                (department) => (
                  <option
                    key={
                      department.id
                    }
                    value={
                      department.id
                    }
                  >
                    {
                      department.name
                    }
                  </option>
                )
              )}
            </select>
          </div>

          <div>
            <Label>
              Priority
            </Label>

            <select
              name="priority"
              defaultValue="medium"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="low">
                Low
              </option>

              <option value="medium">
                Medium
              </option>

              <option value="high">
                High
              </option>

              <option value="urgent">
                Urgent
              </option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <Label>
              Staffing approach
            </Label>

            <div className="mt-2 grid gap-3 md:grid-cols-2">
              <label className="cursor-pointer rounded-xl border border-border p-4 hover:bg-muted/40">
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="staffingMode"
                    value="task_based"
                    defaultChecked
                    className="mt-1"
                  />

                  <div>
                    <p className="text-sm font-semibold">
                      Task-based
                      allocation
                    </p>

                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Each work item
                      independently
                      finds suitable
                      staff from the
                      organization.
                    </p>
                  </div>
                </div>
              </label>

              <label className="cursor-pointer rounded-xl border border-border p-4 hover:bg-muted/40">
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="staffingMode"
                    value="project_team"
                    className="mt-1"
                  />

                  <div>
                    <p className="text-sm font-semibold">
                      Project Team
                    </p>

                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Maintain a
                      long-running
                      team. Smart
                      allocation for
                      Project work
                      uses eligible
                      members of that
                      team.
                    </p>
                  </div>
                </div>
              </label>
            </div>
          </div>

          <div>
            <Label>
              Planned start
            </Label>

            <Input
              name="plannedStart"
              type="datetime-local"
              className="mt-1"
            />
          </div>

          <div>
            <Label>
              Planned end
            </Label>

            <Input
              name="plannedEnd"
              type="datetime-local"
              className="mt-1"
            />
          </div>

          <div className="sm:col-span-2">
            <Button type="submit">
              Create project
            </Button>
          </div>
        </form>
      )}

      {projects.length ===
      0 ? (
        <EmptyState
          title="No projects yet"
          description="Create a project when several work items contribute to one shared outcome."
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {projects.map(
            (project) => {
              const m =
                metrics(
                  project
                );

              return (
                <article
                  key={
                    project.id
                  }
                  className="rounded-xl border border-border bg-card p-5 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/org/${orgId}/projects/${project.id}`}
                        className="text-lg font-semibold hover:text-primary hover:underline"
                      >
                        {
                          project.title
                        }
                      </Link>

                      <p className="mt-1 text-xs text-muted-foreground">
                        {project
                          .department
                          ?.name ||
                          "No department"}{" "}
                        ·{" "}
                        {formatRange(
                          project.plannedStart,
                          project.plannedEnd
                        )}
                      </p>
                    </div>

                    <StatusBadge
                      value={
                        project.status
                      }
                      palette="taskStatus"
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <StatusBadge
                      value={
                        project.priority
                      }
                      palette="priority"
                    />

                    <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                      {project.staffingMode ===
                      "project_team"
                        ? "Project Team"
                        : "Task-based"}
                    </span>

                    {project.staffingMode ===
                      "project_team" && (
                      <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium">
                        {
                          project
                            .projectMembers
                            .length
                        }{" "}
                        team member(s)
                      </span>
                    )}
                  </div>

                  {project.description && (
                    <p className="mt-4 line-clamp-2 text-sm text-muted-foreground">
                      {
                        project.description
                      }
                    </p>
                  )}

                  <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4">
                    <div className="rounded-lg bg-muted/40 p-3">
                      <p className="text-xs font-semibold">
                        Progress
                      </p>

                      <p className="mt-1 text-xl font-semibold">
                        {
                          m.progress
                        }
                        %
                      </p>

                      <p className="text-xs text-muted-foreground">
                        {
                          m.complete
                        }
                        /
                        {m.total} work
                        items
                      </p>
                    </div>

                    <div className="rounded-lg bg-muted/40 p-3">
                      <p className="text-xs font-semibold">
                        Staffing
                      </p>

                      <p className="mt-1 text-xl font-semibold">
                        {
                          m.staffed
                        }
                        /
                        {m.required}
                      </p>

                      <p
                        className={
                          m.gap > 0
                            ? "text-xs font-medium text-amber-600"
                            : "text-xs text-muted-foreground"
                        }
                      >
                        {m.gap > 0
                          ? `${m.gap} position(s) need staff`
                          : "Current work covered"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
                    <p className="text-xs text-muted-foreground">
                      {
                        project
                          .tasks
                          .length
                      }{" "}
                      work item(s)
                    </p>

                    <Button
                      asChild
                      size="sm"
                    >
                      <Link
                        href={`/org/${orgId}/projects/${project.id}`}
                      >
                        View project
                      </Link>
                    </Button>
                  </div>
                </article>
              );
            }
          )}
        </div>
      )}
    </div>
  );
}