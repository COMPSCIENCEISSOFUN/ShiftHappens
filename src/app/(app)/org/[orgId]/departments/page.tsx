/**
 * Departments List Page (Boundary Layer)
 *
 * Displays all departments in the organization with member counts.
 * Company Admin can create, edit, and delete departments.
 * Managers can only view their assigned departments.
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

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Department {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  _count: { departmentMemberships: number };
}

/* ------------------------------------------------------------------ */
/*  Stat Tile                                                          */
/* ------------------------------------------------------------------ */

function StatTile({
  label, value, detail, accentColour, valueColour,
}: {
  label: string; value: string | number; detail: string;
  accentColour: string; valueColour?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-3.5 sm:p-4">
      <div className="absolute right-0 top-0 h-10 w-10 rounded-bl-[40px]" style={{ background: accentColour }} />
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold tracking-tight sm:text-2xl ${valueColour ?? ""}`}>{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
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

  useEffect(() => {
    fetchDepartments();
  }, [orgId]);

  async function fetchDepartments() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`);
      const data = await res.json();
      setDepartments(data);
    } catch {
      setError("Failed to load departments");
    } finally {
      setLoading(false);
    }
  }

  async function onCreateDepartment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);

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

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to create department");
        return;
      }

      setShowCreate(false);
      (event.target as HTMLFormElement).reset();
      fetchDepartments();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onUpdateDepartment(
    event: React.FormEvent<HTMLFormElement>,
    deptId: string
  ) {
    event.preventDefault();
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

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to update department");
        return;
      }

      setEditingId(null);
      fetchDepartments();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onDeleteDepartment(deptId: string) {
    if (!confirm("Are you sure you want to delete this department?")) return;
    setError(null);

    try {
      const res = await fetch(
        `/api/organizations/${orgId}/departments/${deptId}`,
        { method: "DELETE" }
      );

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to delete department");
        return;
      }

      fetchDepartments();
    } catch {
      setError("Something went wrong");
    }
  }

  const totalMembers = departments.reduce((sum, d) => sum + d._count.departmentMemberships, 0);
  const emptyDepts = departments.filter((d) => d._count.departmentMemberships === 0).length;

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
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3">
        <StatTile label="Departments" value={departments.length} detail="total" accentColour="rgba(99,102,241,.08)" />
        <StatTile label="Members" value={totalMembers} detail="across all departments" accentColour="rgba(34,197,94,.08)" valueColour="text-green-600 dark:text-green-400" />
        <StatTile label="Empty" value={emptyDepts} detail="departments with no members" accentColour="rgba(245,158,11,.08)" valueColour={emptyDepts > 0 ? "text-amber-600 dark:text-amber-400" : ""} />
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
            <button type="submit" className="mt-3 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600">
              Create Department
            </button>
          </form>
        </div>
      )}

      {/* ── Department grid ── */}
      {departments.length === 0 ? (
        <EmptyState title="No departments yet" description="Create your first department to get started." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {departments.map((dept) => (
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
                      <button type="submit" className="rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600">
                        Save
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
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

                  {/* Member count */}
                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                      <span className="text-xs font-medium text-muted-foreground">
                        {dept._count.departmentMemberships} member{dept._count.departmentMemberships !== 1 ? "s" : ""}
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
                      onClick={() => onDeleteDepartment(dept.id)}
                      className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-red-300 hover:text-red-600 dark:hover:border-red-800 dark:hover:text-red-400"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
