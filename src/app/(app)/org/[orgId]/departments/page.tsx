/**
 * Departments List Page (Boundary Layer)
 *
 * Displays all departments in the organization with member counts.
 * Company Admin can create, edit, archive/unarchive, and permanently delete.
 * Managers can only view their assigned departments.
 *
 * Supports soft-delete (archive) lifecycle:
 *  - Active departments can be archived (with impact summary confirmation)
 *  - Archived departments appear in a collapsible section at the bottom
 *  - Archived departments can be restored (unarchived) or permanently deleted
 *  - Permanent delete is only available on archived departments
 *
 * Phase 12 visual overhaul — stat tiles, colour-coded cards,
 * responsive grid layout, full-width.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Department {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  archivedAt: string | null;
  _count: { departmentMemberships: number; tasks: number };
}

interface ImpactSummary {
  memberCount: number;
  activeTaskCount: number;
  workRuleCount: number;
}

/* ------------------------------------------------------------------ */
/*  Stat Tile                                                          */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/*  Impact Summary Dialog                                              */
/* ------------------------------------------------------------------ */

function ImpactDialog({
  department,
  impact,
  loading,
  submitting,
  onConfirm,
  onCancel,
}: {
  department: Department;
  impact: ImpactSummary | null;
  /** The impact fetch, not the archive request — see `submitting`. */
  loading: boolean;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl">
        <div className="border-b border-border px-5 py-4">
          <h3 className="text-base font-semibold">Archive &ldquo;{department.name}&rdquo;?</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Archiving hides this department from active views. All data is preserved and can be restored later.
          </p>
        </div>

        <div className="px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" /><path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" /></svg>
              Checking impact...
            </div>
          ) : impact ? (
            <div className="space-y-2.5">
              <p className="text-[13px] font-medium text-foreground">This will affect:</p>
              <div className="space-y-1.5">
                <ImpactRow
                  label="Members assigned"
                  count={impact.memberCount}
                  note="will remain assigned but department hidden from views"
                  warn={impact.memberCount > 0}
                />
                <ImpactRow
                  label="Active tasks"
                  count={impact.activeTaskCount}
                  note="open or in-progress tasks linked to this department"
                  warn={impact.activeTaskCount > 0}
                />
                <ImpactRow
                  label="Work rules"
                  count={impact.workRuleCount}
                  note="scoped to this department"
                  warn={impact.workRuleCount > 0}
                />
              </div>
              {(impact.memberCount > 0 || impact.activeTaskCount > 0) && (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                  Consider reassigning members and tasks before archiving to avoid disruption.
                </p>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          {/* `loading` only covers the impact fetch — without `submitting` the
              button stayed live during the archive PATCH and a second click
              fired a duplicate request. */}
          <button
            onClick={onConfirm}
            disabled={loading || submitting}
            className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-amber-700 disabled:opacity-50"
          >
            {submitting ? "Archiving…" : "Archive Department"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImpactRow({ label, count, note, warn }: { label: string; count: number; note: string; warn: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2">
      <span className={`mt-0.5 text-sm font-bold ${warn ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
        {count}
      </span>
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground">{note}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Permanent Delete Confirmation Dialog                               */
/* ------------------------------------------------------------------ */

function DeleteDialog({
  department,
  submitting,
  onConfirm,
  onCancel,
}: {
  department: Department;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl">
        <div className="border-b border-border px-5 py-4">
          <h3 className="text-base font-semibold text-red-600 dark:text-red-400">Permanently Delete &ldquo;{department.name}&rdquo;?</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">
            This action cannot be undone. The department and all associated memberships will be permanently removed.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          {/* The second of a double click hits an already-deleted row and comes
              back 404, so the admin sees an error for a delete that worked. */}
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? "Deleting…" : "Delete Permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function DepartmentsPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const [departments, setDepartments] = useState<Department[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);

  // In-flight guards. Every one of these actions is checked in its handler as
  // well as on its button, because a fast double click lands before React
  // repaints `disabled`.
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Archive flow state
  const [archiveTarget, setArchiveTarget] = useState<Department | null>(null);
  const [impactSummary, setImpactSummary] = useState<ImpactSummary | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);

  // Permanent delete flow state
  const [deleteTarget, setDeleteTarget] = useState<Department | null>(null);

  useEffect(() => {
    fetchDepartments();
  }, [orgId]);

  async function fetchDepartments() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments?includeArchived=true`);
      const data = await res.json();
      setDepartments(Array.isArray(data) ? data : []);
    } catch {
      setError("Failed to load departments");
    } finally {
      setLoading(false);
    }
  }

  async function onCreateDepartment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;

    const form = event.currentTarget;
    setCreating(true);
    setError(null);

    const formData = new FormData(form);

    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          description: formData.get("description") || undefined,
          color: formData.get("color") || undefined,
        }),
      });

      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(result.error || "Failed to create department");
        return;
      }

      setShowCreate(false);
      form.reset();
      fetchDepartments();
    } catch {
      setError("Something went wrong");
    } finally {
      setCreating(false);
    }
  }

  async function onUpdateDepartment(
    event: React.FormEvent<HTMLFormElement>,
    deptId: string
  ) {
    event.preventDefault();
    if (savingId) return;

    setSavingId(deptId);
    setError(null);

    const formData = new FormData(event.currentTarget);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/departments/${deptId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formData.get("name"),
            description: formData.get("description") || undefined,
            color: formData.get("color") || undefined,
          }),
        }
      );

      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(result.error || "Failed to update department");
        return;
      }

      setEditingId(null);
      fetchDepartments();
    } catch {
      setError("Something went wrong");
    } finally {
      setSavingId(null);
    }
  }

  /* ── Archive flow ── */

  async function startArchive(dept: Department) {
    setArchiveTarget(dept);
    setImpactSummary(null);
    setImpactLoading(true);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/departments/${dept.id}?impact=true`
      );
      const data = await res.json();
      setImpactSummary(data);
    } catch {
      setImpactSummary({ memberCount: 0, activeTaskCount: 0, workRuleCount: 0 });
    } finally {
      setImpactLoading(false);
    }
  }

  async function confirmArchive() {
    if (!archiveTarget || archiving) return;

    setArchiving(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/departments/${archiveTarget.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "archive" }),
        }
      );

      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(result.error || "Failed to archive department");
        return;
      }

      setArchiveTarget(null);
      setImpactSummary(null);
      fetchDepartments();
    } catch {
      setError("Something went wrong");
    } finally {
      setArchiving(false);
    }
  }

  /* ── Unarchive ── */

  async function onUnarchive(deptId: string) {
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/departments/${deptId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "unarchive" }),
        }
      );

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to restore department");
        return;
      }

      fetchDepartments();
    } catch {
      setError("Something went wrong");
    }
  }

  /* ── Permanent delete (archived only) ── */

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;

    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/departments/${deleteTarget.id}`,
        { method: "DELETE" }
      );

      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(result.error || "Failed to delete department");
        return;
      }

      setDeleteTarget(null);
      fetchDepartments();
    } catch {
      setError("Something went wrong");
    } finally {
      setDeleting(false);
    }
  }

  /* ── Derived state ── */

  const activeDepts = departments.filter((d) => !d.archivedAt);
  const archivedDepts = departments.filter((d) => d.archivedAt);
  const totalMembers = activeDepts.reduce((sum, d) => sum + d._count.departmentMemberships, 0);
  const emptyDepts = activeDepts.filter((d) => d._count.departmentMemberships === 0).length;

  if (loading) return <PageLoading />;

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Departments</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Organise your team into departments for scheduling and management
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors ${showCreate ? "border border-border bg-card text-muted-foreground hover:text-foreground" : "bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-sm hover:from-indigo-700 hover:to-indigo-600"}`}
        >
          {showCreate ? "Cancel" : "+ New Department"}
        </button>
      </div>

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile label="Active" value={activeDepts.length} detail="departments" accentColour="rgba(99,102,241,.08)" />
        <StatTile label="Members" value={totalMembers} detail="across active departments" accentColour="rgba(34,197,94,.08)" valueColour="text-green-600 dark:text-green-400" />
        <StatTile label="Empty" value={emptyDepts} detail="no members assigned" accentColour="rgba(245,158,11,.08)" valueColour={emptyDepts > 0 ? "text-amber-600 dark:text-amber-400" : ""} />
        <StatTile label="Archived" value={archivedDepts.length} detail="hidden from views" accentColour="rgba(148,163,184,.08)" valueColour="text-muted-foreground" />
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {/* ── Create form ── */}
      {showCreate && (
        <div className="mb-4 overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-[13px] font-semibold">New Department</h3>
          </div>
          <form onSubmit={onCreateDepartment} className="p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="create-name" className="text-xs">Name</Label>
                <Input id="create-name" name="name" required className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="create-desc" className="text-xs">Description</Label>
                <Input id="create-desc" name="description" placeholder="Optional" className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="create-color" className="text-xs">Colour</Label>
                <div className="flex items-center gap-2">
                  <Input id="create-color" name="color" type="color" defaultValue="#3B82F6" className="h-9 w-12 cursor-pointer rounded-lg border border-border p-0.5" />
                  <span className="text-[11px] text-muted-foreground">Used in calendar</span>
                </div>
              </div>
            </div>
            <button type="submit" disabled={creating} className="mt-3 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600 disabled:cursor-not-allowed disabled:opacity-60">
              {creating ? "Creating…" : "Create Department"}
            </button>
          </form>
        </div>
      )}

      {/* ── Active department grid ── */}
      {activeDepts.length === 0 ? (
        <EmptyState title="No departments yet" description="Create your first department to get started." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {activeDepts.map((dept) => (
            <div key={dept.id} className="group relative overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-md">
              {/* Colour bar at top */}
              <div className="h-1.5" style={{ backgroundColor: dept.color || "#94A3B8" }} />

              {editingId === dept.id ? (
                /* ── Edit mode ── */
                <form onSubmit={(e) => onUpdateDepartment(e, dept.id)} className="p-4">
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Name</Label>
                      <Input name="name" defaultValue={dept.name} required className="h-9 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Description</Label>
                      <Input name="description" defaultValue={dept.description || ""} className="h-9 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Colour</Label>
                      <div className="flex items-center gap-2">
                        <Input name="color" type="color" defaultValue={dept.color || "#3B82F6"} className="h-9 w-12 cursor-pointer rounded-lg border border-border p-0.5" />
                        <span className="text-[11px] text-muted-foreground">Calendar colour</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="submit" disabled={savingId === dept.id} className="rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600 disabled:cursor-not-allowed disabled:opacity-60">
                        {savingId === dept.id ? "Saving…" : "Save"}
                      </button>
                      <button type="button" disabled={savingId === dept.id} onClick={() => setEditingId(null)} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60">
                        Cancel
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                /* ── Display mode ── */
                <div className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${dept.color || "#94A3B8"}15` }}>
                        <div className="h-4 w-4 rounded-full" style={{ backgroundColor: dept.color || "#94A3B8" }} />
                      </div>
                      <div className="min-w-0">
                        <h3 className="truncate text-[15px] font-semibold">{dept.name}</h3>
                        {dept.description && (
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{dept.description}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Counts */}
                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                      <span className="text-xs font-medium text-muted-foreground">
                        {dept._count.departmentMemberships} member{dept._count.departmentMemberships !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                      </svg>
                      <span className="text-xs font-medium text-muted-foreground">
                        {dept._count.tasks} task{dept._count.tasks !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="mt-3 flex gap-2 border-t border-border/50 pt-3">
                    <button
                      onClick={() => setEditingId(dept.id)}
                      className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                      Edit
                    </button>
                    <button
                      onClick={() => startArchive(dept)}
                      className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-amber-400 hover:text-amber-600 dark:hover:border-amber-700 dark:hover:text-amber-400"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></svg>
                      Archive
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Archived departments section ── */}
      {archivedDepts.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="flex w-full items-center gap-2 rounded-xl border border-border bg-card/50 px-4 py-3 text-left transition-colors hover:bg-card"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`text-muted-foreground transition-transform ${showArchived ? "rotate-90" : ""}`}
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
              <path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" />
            </svg>
            <span className="text-sm font-medium text-muted-foreground">
              Archived Departments ({archivedDepts.length})
            </span>
          </button>

          {showArchived && (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {archivedDepts.map((dept) => (
                <div key={dept.id} className="relative overflow-hidden rounded-xl border border-dashed border-border bg-card/60 opacity-80 transition-opacity hover:opacity-100">
                  {/* Muted colour bar */}
                  <div className="h-1.5 opacity-40" style={{ backgroundColor: dept.color || "#94A3B8" }} />

                  <div className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-muted/40">
                          <div className="h-4 w-4 rounded-full opacity-50" style={{ backgroundColor: dept.color || "#94A3B8" }} />
                        </div>
                        <div className="min-w-0">
                          <h3 className="truncate text-[15px] font-semibold text-muted-foreground">{dept.name}</h3>
                          {dept.description && (
                            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{dept.description}</p>
                          )}
                        </div>
                      </div>
                      <span className="ml-2 flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        Archived
                      </span>
                    </div>

                    {/* Counts */}
                    <div className="mt-3 flex items-center gap-2">
                      <div className="flex items-center gap-1.5 rounded-lg bg-muted/40 px-2.5 py-1">
                        <span className="text-xs font-medium text-muted-foreground/70">
                          {dept._count.departmentMemberships} member{dept._count.departmentMemberships !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 rounded-lg bg-muted/40 px-2.5 py-1">
                        <span className="text-xs font-medium text-muted-foreground/70">
                          {dept._count.tasks} task{dept._count.tasks !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>

                    {/* Archived actions */}
                    <div className="mt-3 flex gap-2 border-t border-border/30 pt-3">
                      <button
                        onClick={() => onUnarchive(dept.id)}
                        className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-green-400 hover:text-green-600 dark:hover:border-green-700 dark:hover:text-green-400"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
                        Restore
                      </button>
                      <button
                        onClick={() => setDeleteTarget(dept)}
                        className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-red-300 hover:text-red-600 dark:hover:border-red-800 dark:hover:text-red-400"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                        Delete Permanently
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Archive confirmation dialog ── */}
      {archiveTarget && (
        <ImpactDialog
          department={archiveTarget}
          impact={impactSummary}
          loading={impactLoading}
          submitting={archiving}
          onConfirm={confirmArchive}
          onCancel={() => { setArchiveTarget(null); setImpactSummary(null); }}
        />
      )}

      {/* ── Permanent delete confirmation dialog ── */}
      {deleteTarget && (
        <DeleteDialog
          department={deleteTarget}
          submitting={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
