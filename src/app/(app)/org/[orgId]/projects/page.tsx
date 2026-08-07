"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { PageLoading } from "@/components/ui/page-loading";
import { StatusBadge } from "@/components/ui/status-badge";

type Department = { id: string; name: string; color: string | null };
type ProjectTask = { id: string; title: string; status: string; priority: string; scheduledStart: string | null; scheduledEnd: string | null; requiredHeadcount: number; assignments: { id: string; status: string }[] };
type Project = { id: string; title: string; description: string | null; status: string; priority: string; plannedStart: string | null; plannedEnd: string | null; department: Department | null; tasks: ProjectTask[] };

const statusLabel: Record<string, string> = { planning: "Planning", active: "Active", on_hold: "On hold", completed: "Completed", cancelled: "Cancelled" };

function formatRange(start: string | null, end: string | null) {
  if (!start || !end) return "No timeframe set";
  const startLabel = new Date(start).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const endLabel = new Date(end).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  return `${startLabel} to ${endLabel}`;
}

export default function ProjectsPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [projects, setProjects] = useState<Project[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [creatingWorkItem, setCreatingWorkItem] = useState(false);

  const load = useCallback(async () => {
    try {
      const [projectResponse, departmentResponse] = await Promise.all([
        fetch(`/api/organizations/${orgId}/projects`),
        fetch(`/api/organizations/${orgId}/departments?scope=mine`),
      ]);
      if (!projectResponse.ok) throw new Error("Failed to load projects");
      const projectData: unknown = await projectResponse.json();
      setProjects(Array.isArray(projectData) ? projectData : []);
      const departmentData: unknown = departmentResponse.ok ? await departmentResponse.json() : [];
      setDepartments(Array.isArray(departmentData) ? departmentData : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const values = new FormData(event.currentTarget);
    const start = values.get("plannedStart") as string;
    const end = values.get("plannedEnd") as string;
    const response = await fetch(`/api/organizations/${orgId}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: values.get("title"), description: values.get("description") || undefined,
        departmentId: values.get("departmentId") || undefined, priority: values.get("priority"),
        plannedStart: start ? new Date(start).toISOString() : undefined,
        plannedEnd: end ? new Date(end).toISOString() : undefined,
      }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) { setError(result?.error || "Could not create project"); return; }
    setShowCreate(false);
    setSuccess("Project created. Add work items when the delivery breakdown is ready.");
    await load();
  }

  async function updateStatus(project: Project, status: string) {
    setError(null);
    const response = await fetch(`/api/organizations/${orgId}/projects/${project.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    const result = await response.json().catch(() => null);
    if (!response.ok) { setError(result?.error || "Could not update project"); return; }
    setSuccess("Project status updated.");
    await load();
  }

  async function addWorkItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProject || creatingWorkItem) return;
    setError(null);
    setCreatingWorkItem(true);
    const values = new FormData(event.currentTarget);
    const start = values.get("scheduledStart") as string;
    const end = values.get("scheduledEnd") as string;
    try {
      const response = await fetch(`/api/organizations/${orgId}/tasks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: values.get("title"), description: values.get("description") || undefined,
          projectId: selectedProject.id, departmentId: selectedProject.department?.id,
          priority: values.get("priority"), requiredHeadcount: Number(values.get("requiredHeadcount")) || 1,
          scheduledStart: start ? new Date(start).toISOString() : undefined,
          scheduledEnd: end ? new Date(end).toISOString() : undefined,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) { setError(result?.error || "Could not add work item"); return; }
      setSuccess("Work item created and automatic allocation has started.");
      setSelectedProject(null);
      await load();
    } catch {
      setError("Could not add work item. Please try again.");
    } finally {
      setCreatingWorkItem(false);
    }
  }

  if (loading) return <PageLoading label="Loading projects" />;

  return <div className="max-w-6xl">
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><h1 className="text-2xl font-bold tracking-tight">Projects</h1><p className="mt-1 text-sm text-muted-foreground">Track multi-day outcomes and the automatically allocated work that moves them forward.</p></div>
      <Button onClick={() => setShowCreate((current) => !current)}>{showCreate ? "Cancel" : "New project"}</Button>
    </div>
    {error && <AlertBanner className="mb-4" variant="error" message={error} />}
    {success && <AlertBanner className="mb-4" variant="success" message={success} />}
    {showCreate && <form onSubmit={createProject} className="mb-5 grid gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-2">
      <div className="sm:col-span-2"><Label htmlFor="project-title">Project name</Label><Input id="project-title" name="title" required placeholder="e.g. Atlas API release" className="mt-1" /></div>
      <div className="sm:col-span-2"><Label htmlFor="project-description">Outcome and context</Label><textarea id="project-description" name="description" className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="What does success look like?" /></div>
      <div><Label htmlFor="project-department">Department</Label><select id="project-department" name="departmentId" className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" required><option value="">Choose department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div>
      <div><Label htmlFor="project-priority">Priority</Label><select id="project-priority" name="priority" defaultValue="medium" className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
      <div><Label htmlFor="project-start">Planned start</Label><Input id="project-start" name="plannedStart" type="datetime-local" className="mt-1" /></div>
      <div><Label htmlFor="project-end">Planned end</Label><Input id="project-end" name="plannedEnd" type="datetime-local" className="mt-1" /></div>
      <div className="sm:col-span-2"><Button type="submit">Create project</Button></div>
    </form>}
    {projects.length === 0 ? <EmptyState title="No projects yet" description="Create a project for work that needs a shared outcome, timeframe, and multiple work items." /> : <div className="grid gap-4 lg:grid-cols-2">
      {projects.map((project) => {
        const tasks = Array.isArray(project.tasks) ? project.tasks : [];
        const complete = tasks.filter((task) => task.status === "completed").length;
        const total = tasks.length;
        const progress = total === 0 ? 0 : Math.round((complete / total) * 100);
        return <article key={project.id} className="rounded-lg border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3"><div><p className="text-base font-semibold">{project.title}</p><p className="mt-1 text-xs text-muted-foreground">{project.department?.name || "No department"} · {formatRange(project.plannedStart, project.plannedEnd)}</p></div><select value={project.status} onChange={(event) => void updateStatus(project, event.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-xs">{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          {project.description && <p className="mt-3 text-sm text-muted-foreground">{project.description}</p>}
          <div className="mt-4 border-t border-border pt-3"><div className="mb-2 flex items-center justify-between gap-3 text-xs"><span className="font-medium text-foreground">{complete}/{total} work items complete</span><span className="text-muted-foreground">{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div><div className="mt-3 flex justify-end"><Button size="sm" variant="outline" onClick={() => setSelectedProject(project)}>Add work item</Button></div></div>
          {tasks.length > 0 && <ul className="mt-3 space-y-2">{tasks.slice(0, 4).map((task) => <li key={task.id} className="flex items-center justify-between gap-2 text-xs"><Link href={`/org/${orgId}/tasks`} className="truncate font-medium hover:underline">{task.title}</Link><StatusBadge value={task.status} palette="taskStatus" /></li>)}</ul>}
        </article>;
      })}
    </div>}
    {selectedProject && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Add project work item"><form onSubmit={addWorkItem} className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl"><div className="mb-4 flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Add work item</h2><p className="text-sm text-muted-foreground">{selectedProject.title}</p></div><Button type="button" variant="outline" size="sm" disabled={creatingWorkItem} onClick={() => setSelectedProject(null)}>Close</Button></div><div className="space-y-3"><div><Label htmlFor="work-title">Work item</Label><Input id="work-title" name="title" required className="mt-1" placeholder="e.g. Complete API integration tests" /></div><div><Label htmlFor="work-description">Details</Label><textarea id="work-description" name="description" className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></div><div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="work-start">Start</Label><Input id="work-start" name="scheduledStart" type="datetime-local" className="mt-1" /></div><div><Label htmlFor="work-end">End</Label><Input id="work-end" name="scheduledEnd" type="datetime-local" className="mt-1" /></div></div><div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="work-priority">Priority</Label><select id="work-priority" name="priority" defaultValue="medium" className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></div><div><Label htmlFor="work-headcount">Headcount</Label><Input id="work-headcount" name="requiredHeadcount" type="number" min={1} max={50} defaultValue={1} className="mt-1" /></div></div><Button type="submit" disabled={creatingWorkItem}>{creatingWorkItem ? "Creating work item..." : "Create and allocate work item"}</Button></div></form></div>}
  </div>;
}
