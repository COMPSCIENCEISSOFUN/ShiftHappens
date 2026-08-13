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
import { DepartmentMembersDrawer } from "@/components/departments/department-members-drawer";
import { EmptyState } from "@/components/ui/empty-state";
import { Archive, CheckCheck, Loader2, Lock, RefreshCw, Search, SquarePen, Trash2, Users } from "lucide-react";
import { StatTile } from "@/components/ui/stat-tile";
import { usePermissions } from "@/components/layout/permission-provider";
import { usePlan } from "@/components/layout/plan-provider";
import { LimitNotice } from "@/components/ui/plan-gate";
import { DEPARTMENT_LIST_READERS } from "@/lib/permissions";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/api-error";

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

/**
 * The filter pills.
 *
 * Modelled on the Certifications page so the two screens behave the same way:
 * mutually exclusive pills carrying live counts, a debounced search beside
 * them, and an empty state that names what was being looked for.
 *
 * Two axes are deliberately flattened into one row of pills rather than split
 * into two controls. Staffing and workload are independent — a department can
 * have people and no work, or work and nobody to do it — but in practice you
 * arrive here asking one question at a time ("who has nobody?"), and two
 * dropdowns to express that is worse than six pills.
 *
 * `archived` is on the same row for the same reason. It used to be a
 * collapsible section at the foot of the page; a pill with a count is more
 * discoverable than a collapsed drawer, and having archived departments in
 * exactly one place is simpler than having them in two.
 */
type FilterKey = "all" | "staffed" | "empty" | "with_tasks" | "no_tasks" | "archived";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "staffed", label: "Staffed" },
  { key: "empty", label: "Empty" },
  { key: "with_tasks", label: "With tasks" },
  { key: "no_tasks", label: "No tasks" },
  { key: "archived", label: "Archived" },
];

/** Lower-case nouns for the "No ___" empty state. */
const FILTER_NOUNS: Record<FilterKey, string> = {
  all: "departments",
  staffed: "departments with members",
  empty: "departments without members",
  with_tasks: "departments with tasks",
  no_tasks: "departments without tasks",
  archived: "archived departments",
};

/**
 * Whether a department belongs under a pill.
 *
 * Every pill except `archived` describes an ACTIVE department. An archived
 * department with no members is not "Empty" — it is archived, and surfacing it
 * under a staffing filter would put a card with Restore/Delete buttons in a
 * grid of editable ones.
 */
function matchesFilter(dept: Department, key: FilterKey): boolean {
  const archived = dept.archivedAt !== null;
  if (key === "archived") return archived;
  if (archived) return false;

  switch (key) {
    case "staffed":
      return dept._count.departmentMemberships > 0;
    case "empty":
      return dept._count.departmentMemberships === 0;
    case "with_tasks":
      return dept._count.tasks > 0;
    case "no_tasks":
      return dept._count.tasks === 0;
    default:
      return true;
  }
}

function matchesSearch(dept: Department, search: string): boolean {
  if (!search) return true;
  return (
    dept.name.toLowerCase().includes(search) ||
    (dept.description ?? "").toLowerCase().includes(search)
  );
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
          <p className="mt-1 text-sm text-muted-foreground">
            Archiving hides this department from active views. All data is preserved and can be restored later.
          </p>
        </div>

        <div className="px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Checking impact...
            </div>
          ) : impact ? (
            <div className="space-y-2.5">
              <p className="text-sm font-medium text-foreground">This will affect:</p>
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
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
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
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
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
          <p className="mt-1 text-sm text-muted-foreground">
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
/*  Archived grid                                                      */
/* ------------------------------------------------------------------ */

/**
 * Archived departments, in their own card shape.
 *
 * Kept visually distinct — dashed border, muted colour bar, reduced opacity —
 * because the actions differ. An active card edits and archives; an archived
 * one restores and permanently deletes. Rendering both through one component
 * would mean a card whose buttons change meaning based on a flag, which is how
 * somebody eventually clicks "Delete Permanently" expecting "Archive".
 *
 * Extracted from a collapsible section at the foot of the page when the filter
 * pills were added, so archived departments live in exactly one place.
 */
function ArchivedGrid({
  departments,
  onUnarchive,
  onDelete,
}: {
  departments: Department[];
  onUnarchive: (id: string) => void;
  onDelete: (dept: Department) => void;
}) {
  // Read here rather than threaded from the page: the provider is a context, so
  // a component asks for what it needs instead of every parent forwarding it.
  const { can } = usePermissions();
  const canUpdate = can("departments:update");
  const canDelete = can("departments:delete");

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {departments.map((dept) => (
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
                  <h3 className="truncate text-base font-semibold text-muted-foreground">{dept.name}</h3>
                  {dept.description && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground/70">{dept.description}</p>
                  )}
                </div>
              </div>
              <span className="ml-2 flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
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

            {/* Archived actions — restore is an update, delete is a delete. */}
            {(canUpdate || canDelete) && (
            <div className="mt-3 flex gap-2 border-t border-border/30 pt-3">
              {canUpdate && (
              <button
                onClick={() => onUnarchive(dept.id)}
                className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-green-400 hover:text-green-600 dark:hover:border-green-700 dark:hover:text-green-400"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                Restore
              </button>
              )}
              {canDelete && (
              <button
                onClick={() => onDelete(dept)}
                className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-red-300 hover:text-red-600 dark:hover:border-red-800 dark:hover:text-red-400"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete Permanently
              </button>
              )}
            </div>
            )}
          </div>
        </div>
      ))}
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
  /* Which department's people are open, by id and name — the drawer needs
     both, and holding the row itself would go stale on a refetch. */
  const [peopleOf, setPeopleOf] = useState<{ id: string; name: string } | null>(
    null
  );
  const [showCreate, setShowCreate] = useState(false);
  /*
   * This page had NO role check of any kind. A manager arriving by URL was
   * offered "+ New Department", plus Edit, Archive and Delete on every row —
   * four actions that each returned 403 — and four stat tiles counting every
   * department and member in the organisation, which is outside the scope they
   * are held to everywhere else.
   */
  const { can, canAny } = usePermissions();
  const plan = usePlan();
  const canCreate = can("departments:create");
  const canUpdate = can("departments:update");
  const canDelete = can("departments:delete");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

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

  // Debounced so typing does not re-filter the grid on every keystroke —
  // matches the Certifications page, including the 250ms.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

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
        setError(apiErrorMessage(result, "Failed to create department"));
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
        setError(apiErrorMessage(result, "Failed to update department"));
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
      // An error body would render as a dialog full of "undefined" counts, and
      // the admin would be asked to confirm an archive on the strength of it.
      if (!res.ok || typeof data?.memberCount !== "number") {
        setImpactSummary({ memberCount: 0, activeTaskCount: 0, workRuleCount: 0 });
        return;
      }
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
        setError(apiErrorMessage(result, "Failed to archive department"));
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
        setError(apiErrorMessage(result, "Failed to restore department"));
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
        setError(apiErrorMessage(result, "Failed to delete department"));
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

  /**
   * Pill counts ignore the search box.
   *
   * A count that moved as you typed would be answering a different question
   * from the one the pill asks — "how many departments have nobody?" is a
   * property of the organisation, not of what you happen to have typed. It
   * also makes the pills unusable as a starting point, because they would all
   * read 0 the moment a search matched nothing.
   */
  const counts = FILTERS.reduce(
    (acc, { key }) => {
      acc[key] = departments.filter((d) => matchesFilter(d, key)).length;
      return acc;
    },
    {} as Record<FilterKey, number>
  );

  const visible = departments
    .filter((d) => matchesFilter(d, filter))
    .filter((d) => matchesSearch(d, search));

  /**
   * How many departments the search matches OUTSIDE the current pill.
   *
   * Without this, searching for something archived while looking at "All"
   * returns nothing and the feature reads as broken. Saying "3 match under
   * other filters" turns a dead end into a signpost.
   */
  const matchesElsewhere =
    search.length > 0
      ? departments.filter(
          (d) => matchesSearch(d, search) && !matchesFilter(d, filter)
        ).length
      : 0;

  const showingArchivedCards = filter === "archived";

  /*
   * Below the hooks — a guard above them makes every useState conditional.
   *
   * Same constant the GET route enforces. This page previously carried no page
   * gate at all: the actions were hidden but the list, with its org-wide member
   * and task counts, rendered in full for anyone who typed the URL.
   */
  if (!canAny(...DEPARTMENT_LIST_READERS)) {
    return (
      <EmptyState
        icon={Lock}
        title="You don't have access to Departments"
        description="Departments are managed by people who hold one of the department permissions. Ask a company admin if you need access."
      />
    );
  }

  if (loading) return <PageLoading />;

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Departments</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Organise your team into departments for scheduling and management
          </p>
        </div>
        {canCreate && (
          <div className="flex items-center gap-2.5">
            <LimitNotice resource="departments" noun="departments" />
            {/* Disabled at the cap, not refused on save. Cancel stays live. */}
            <button
              onClick={() => setShowCreate(!showCreate)}
              disabled={!showCreate && plan.atLimit("departments")}
              className={`${showCreate ? SECONDARY_BUTTON : PRIMARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {showCreate ? "Cancel" : "+ New Department"}
            </button>
          </div>
        )}
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
      {showCreate && canCreate && (
        <div className="mb-4 overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">New Department</h3>
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
                  <span className="text-xs text-muted-foreground">Used in calendar</span>
                </div>
              </div>
            </div>
            <button type="submit" disabled={creating} className={cn(PRIMARY_BUTTON, "mt-3")}>
              {creating ? "Creating…" : "Create Department"}
            </button>
          </form>
        </div>
      )}

      {/* ── Filters ── */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Six pills stack into three rows on a phone; scrolling them
            horizontally keeps the grid itself above the fold. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1">
          {FILTERS.map(({ key, label }) => {
            const active = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                aria-pressed={active}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-all ${
                  active
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-300"
                    : "border-border bg-card text-muted-foreground hover:border-indigo-300 hover:text-indigo-600 dark:hover:border-indigo-600 dark:hover:text-indigo-400"
                }`}
              >
                {label}
                <span
                  className={`inline-flex min-w-[18px] items-center justify-center rounded-full px-1 py-0 text-xs font-bold ${
                    active
                      ? "bg-indigo-600 text-white dark:bg-indigo-500"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {counts[key]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative shrink-0 sm:w-60">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search departments..."
            aria-label="Search departments by name or description"
            className="h-9 pl-9 text-sm"
          />
        </div>
      </div>

      {/* ── Department grid ── */}
      {departments.length === 0 ? (
        <EmptyState title="No departments yet" description="Create your first department to get started." />
      ) : visible.length === 0 ? (
        <EmptyState
          title={search ? `No ${FILTER_NOUNS[filter]} match "${search}"` : `No ${FILTER_NOUNS[filter]}`}
          description={
            matchesElsewhere > 0
              ? `${matchesElsewhere} department${matchesElsewhere === 1 ? "" : "s"} elsewhere match${matchesElsewhere === 1 ? "es" : ""} that search — try another filter.`
              : search
                ? "Nothing here matches that search."
                : undefined
          }
          action={
            search || filter !== "all" ? (
              <button
                onClick={() => {
                  setSearchInput("");
                  setFilter("all");
                }}
                className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground"
              >
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : showingArchivedCards ? (
        <ArchivedGrid
          departments={visible}
          onUnarchive={onUnarchive}
          onDelete={setDeleteTarget}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((dept) => (
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
                        <span className="text-xs text-muted-foreground">Calendar colour</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="submit" disabled={savingId === dept.id} className={PRIMARY_BUTTON}>
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
                        <h3 className="truncate text-base font-semibold">{dept.name}</h3>
                        {dept.description && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">{dept.description}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Counts */}
                  <div className="mt-3 flex items-center gap-2">
                    {/*
                      The count is the way in, rather than the whole card.
                      The card already carries Edit and Archive buttons, and a
                      clickable card wrapping its own buttons is both a click
                      target conflict and invalid nesting for a screen reader.
                    */}
                    <button
                      type="button"
                      onClick={() =>
                        setPeopleOf({ id: dept.id, name: dept.name })
                      }
                      aria-label={`See who is in ${dept.name}`}
                      className="flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1 transition-colors hover:bg-accent"
                    >
                      <Users className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      <span className="text-xs font-medium text-muted-foreground">
                        {dept._count.departmentMemberships} member{dept._count.departmentMemberships !== 1 ? "s" : ""}
                      </span>
                    </button>
                    <div className="flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1">
                      <CheckCheck className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      <span className="text-xs font-medium text-muted-foreground">
                        {dept._count.tasks} task{dept._count.tasks !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  {canUpdate && (
                  <div className="mt-3 flex gap-2 border-t border-border/50 pt-3">
                    <button
                      onClick={() => setEditingId(dept.id)}
                      className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400"
                    >
                      <SquarePen className="h-3 w-3" aria-hidden="true" />
                      Edit
                    </button>
                    <button
                      onClick={() => startArchive(dept)}
                      className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-amber-400 hover:text-amber-600 dark:hover:border-amber-700 dark:hover:text-amber-400"
                    >
                      <Archive className="h-3 w-3" aria-hidden="true" />
                      Archive
                    </button>
                  </div>
                  )}
                </div>
              )}
            </div>
          ))}
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

      {/* ── Who works here ── */}
      {peopleOf && (
        <DepartmentMembersDrawer
          orgId={orgId}
          departmentId={peopleOf.id}
          departmentName={peopleOf.name}
          onClose={() => setPeopleOf(null)}
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
