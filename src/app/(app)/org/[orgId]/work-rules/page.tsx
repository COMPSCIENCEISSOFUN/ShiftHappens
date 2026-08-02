/**
 * Work Rules Page (Boundary Layer)
 *
 * Company admins configure break intervals and hour limits. A rule can target
 * everyone, a department, a custom role, or a department AND a role.
 *
 * ## On the visual language
 *
 * Predates the Phase 12 overhaul: shadcn `Card` primitives, a bare `h2`, no
 * stat tiles, no icons. It now matches Departments, Members and Calendar.
 *
 * ## What changed beyond the styling
 *
 * - `fetchRules` did `if (!res.ok) throw new Error()`, discarding the server's
 *   message so the page always said "Failed to load work rules" whatever had
 *   actually gone wrong. That is precisely what made a missing database column
 *   on the deployed site hard to diagnose. The server's own message is shown.
 * - The form was a `<div>` with the submit handler on a button, so pressing
 *   Enter in a text field did nothing. It is a real `<form>`.
 * - `params` was a promise resolved into state; every other page uses
 *   `useParams()`. Now it does too, which also removes the render pass where
 *   `orgId` was the empty string.
 * - Deleting used `window.confirm()`. Now the app's own `ConfirmDialog`.
 *
 * ## A note on the role dropdown
 *
 * `members/page.tsx` filters system roles out of its role picker; this page
 * deliberately does the same now. A rule scoped to a system role could never
 * match anybody — `assignCustomRole` refuses to assign one — so the rule would
 * silently apply to nobody. Nothing currently creates a system role, so this is
 * a guard against a future footgun rather than a live fix.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  Clock,
  Pause,
  Pencil,
  Play,
  Plus,
  Scale,
  Trash2,
  X,
} from "lucide-react";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/* ------------------------------------------------------------------ */
/*  Types and constants                                                */
/* ------------------------------------------------------------------ */

interface WorkRule {
  id: string;
  name: string;
  type: string;
  roleId: string | null;
  departmentId: string | null;
  hoursThreshold: number | null;
  breakHours: number | null;
  maxHours: number | null;
  isActive: boolean;
  role: { id: string; name: string; displayLabel: string } | null;
  department: { id: string; name: string } | null;
}

interface OrgRole {
  id: string;
  name: string;
  displayLabel: string;
  isSystemRole?: boolean;
}
interface Department {
  id: string;
  name: string;
}

const RULE_TYPES = [
  {
    value: "break_interval",
    label: "Break interval",
    description: "Require a break after X hours worked",
  },
  {
    value: "max_hours_daily",
    label: "Max hours (daily)",
    description: "Cap hours in a single day",
  },
  {
    value: "max_hours_weekly",
    label: "Max hours (weekly)",
    description: "Cap hours across a week",
  },
];

const TYPE_LABELS: Record<string, string> = {
  break_interval: "Break interval",
  max_hours_daily: "Daily limit",
  max_hours_weekly: "Weekly limit",
};

const TYPE_COLORS: Record<string, string> = {
  break_interval: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  max_hours_daily: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  max_hours_weekly: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
};

const PRIMARY_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-indigo-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:from-indigo-700 hover:to-indigo-600 disabled:cursor-not-allowed disabled:opacity-60";

const SECONDARY_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-indigo-400 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60";

const DANGER_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-red-400 hover:text-red-600 dark:hover:text-red-400";

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground";

/** The house panel — a card with a headed section. */
function Panel({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Clock;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-[13px] font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function WorkRulesPage() {
  const params = useParams();
  const orgId = params.orgId as string;

  const [rules, setRules] = useState<WorkRule[]>([]);
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<WorkRule | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState("break_interval");
  const [formRoleId, setFormRoleId] = useState("");
  const [formDeptId, setFormDeptId] = useState("");
  const [formHoursThreshold, setFormHoursThreshold] = useState("");
  const [formBreakHours, setFormBreakHours] = useState("");
  const [formMaxHours, setFormMaxHours] = useState("");

  async function fetchRules() {
    try {
      setLoading(true);
      const res = await fetch(`/api/organizations/${orgId}/work-rules`);
      const data = await res.json();

      // The server's own message, not a generic one. `throw new Error()`
      // discarded it, so every failure read the same and told you nothing.
      if (!res.ok || !Array.isArray(data)) {
        setError(
          typeof data?.error === "string"
            ? data.error
            : "Failed to load work rules"
        );
        setRules([]);
        return;
      }

      setRules(data);
      setError(null);
    } catch {
      setError("Failed to load work rules");
    } finally {
      setLoading(false);
    }
  }

  async function fetchRoles() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/roles`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setRoles(data);
    } catch {
      /* optional */
    }
  }

  async function fetchDepartments() {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setDepartments(data);
    } catch {
      /* optional */
    }
  }

  useEffect(() => {
    if (!orgId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads the rules, roles and departments from the server on mount
    fetchRules();
    fetchRoles();
    fetchDepartments();
  }, [orgId]);

  function resetForm() {
    setFormName("");
    setFormType("break_interval");
    setFormRoleId("");
    setFormDeptId("");
    setFormHoursThreshold("");
    setFormBreakHours("");
    setFormMaxHours("");
    setFormError(null);
    setEditingRule(null);
  }

  function openCreateForm() {
    resetForm();
    setShowForm(true);
  }

  function openEditForm(rule: WorkRule) {
    setFormName(rule.name);
    setFormType(rule.type);
    setFormRoleId(rule.roleId || "");
    setFormDeptId(rule.departmentId || "");
    setFormHoursThreshold(rule.hoursThreshold?.toString() || "");
    setFormBreakHours(rule.breakHours?.toString() || "");
    setFormMaxHours(rule.maxHours?.toString() || "");
    setFormError(null);
    setEditingRule(rule);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    resetForm();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!formName.trim()) {
      setFormError("Name is required");
      return;
    }

    const body: Record<string, unknown> = {
      name: formName.trim(),
      type: formType,
      roleId: formRoleId || null,
      departmentId: formDeptId || null,
    };

    if (formType === "break_interval") {
      if (!formHoursThreshold || !formBreakHours) {
        setFormError("Hours threshold and break hours are required");
        return;
      }
      body.hoursThreshold = parseFloat(formHoursThreshold);
      body.breakHours = parseFloat(formBreakHours);
    } else {
      if (!formMaxHours) {
        setFormError("Max hours is required");
        return;
      }
      body.maxHours = parseFloat(formMaxHours);
    }

    try {
      setSaving(true);
      const url = editingRule
        ? `/api/organizations/${orgId}/work-rules/${editingRule.id}`
        : `/api/organizations/${orgId}/work-rules`;
      const res = await fetch(url, {
        method: editingRule ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setFormError(d.error || "Failed to save");
        return;
      }
      closeForm();
      fetchRules();
    } catch {
      setFormError("Failed to save rule");
    } finally {
      setSaving(false);
    }
  }

  // Both of these used to ignore the response, so a 403 or 404 left the toggle
  // flipping back on the refetch with nothing on screen to say why.
  async function handleToggle(rule: WorkRule) {
    setError(null);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/work-rules/${rule.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: !rule.isActive }),
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(
          d.error ||
            `Failed to ${rule.isActive ? "pause" : "activate"} "${rule.name}"`
        );
        return;
      }
      fetchRules();
    } catch {
      setError("Something went wrong");
    }
  }

  async function onConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/work-rules/${deleteTarget.id}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || `Failed to delete "${deleteTarget.name}"`);
        return;
      }
      setDeleteTarget(null);
      fetchRules();
    } catch {
      setError("Something went wrong");
    } finally {
      setDeleting(false);
    }
  }

  function getTargetLabel(rule: WorkRule): string {
    const parts: string[] = [];
    if (rule.department) parts.push(rule.department.name);
    if (rule.role) parts.push(rule.role.displayLabel);
    return parts.length > 0 ? parts.join(" · ") : "All staff";
  }

  if (loading) return <PageLoading />;

  /**
   * System roles are excluded at the point of USE, not when fetching.
   *
   * A filter applied in `fetchRoles` only protects the one path that happens to
   * go through it; anything that populates `roles` another way — a future
   * prefetch, a test, a refactor — would quietly reintroduce them. Filtering
   * where the list is rendered means the dropdown cannot show one however the
   * data arrived. See the note in the file header for why it matters.
   */
  const assignableRoles = roles.filter((r) => !r.isSystemRole);

  const activeRules = rules.filter((r) => r.isActive);
  const breakRules = rules.filter((r) => r.type === "break_interval");
  const limitRules = rules.filter((r) => r.type !== "break_interval");

  return (
    <div className="w-full">
      {/* ── Header ── */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
            Work Rules
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Break intervals and hour limits. Staff who would breach a rule are
            marked ineligible when you assign work
          </p>
        </div>
        <button
          onClick={() => (showForm ? closeForm() : openCreateForm())}
          className={showForm ? SECONDARY_BUTTON : PRIMARY_BUTTON}
        >
          {showForm ? (
            <>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Cancel
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              New Rule
            </>
          )}
        </button>
      </div>

      {/* ── Stat tiles ── */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Active"
          value={activeRules.length}
          detail="rules enforced"
          accentColour={STAT_ACCENT.green}
          valueColour={
            activeRules.length > 0 ? "text-green-600 dark:text-green-400" : ""
          }
        />
        <StatTile
          label="Paused"
          value={rules.length - activeRules.length}
          detail="not enforced"
          accentColour={STAT_ACCENT.slate}
          valueColour="text-muted-foreground"
        />
        <StatTile
          label="Breaks"
          value={breakRules.length}
          detail="break interval rules"
          accentColour={STAT_ACCENT.blue}
        />
        <StatTile
          label="Limits"
          value={limitRules.length}
          detail="daily and weekly caps"
          accentColour={STAT_ACCENT.amber}
        />
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      <div className="space-y-4">
        {/* ── Create / edit form ── */}
        {showForm && (
          <Panel
            title={editingRule ? `Editing ${editingRule.name}` : "New work rule"}
            icon={editingRule ? Pencil : Plus}
          >
            <form onSubmit={handleSubmit} className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="rule-name" className="text-xs">
                    Rule name
                  </Label>
                  <Input
                    id="rule-name"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="e.g. Kitchen daily limit"
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-type" className="text-xs">
                    Rule type
                  </Label>
                  <select
                    id="rule-type"
                    value={formType}
                    onChange={(e) => setFormType(e.target.value)}
                    className={SELECT_CLASS}
                  >
                    {RULE_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label} — {t.description}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {formType === "break_interval" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="rule-threshold" className="text-xs">
                      After every (hours)
                    </Label>
                    <Input
                      id="rule-threshold"
                      type="number"
                      value={formHoursThreshold}
                      onChange={(e) => setFormHoursThreshold(e.target.value)}
                      placeholder="e.g. 6"
                      min="1"
                      step="0.5"
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="rule-break" className="text-xs">
                      Require break (hours)
                    </Label>
                    <Input
                      id="rule-break"
                      type="number"
                      value={formBreakHours}
                      onChange={(e) => setFormBreakHours(e.target.value)}
                      placeholder="e.g. 1"
                      min="0.5"
                      step="0.5"
                      className="h-9 text-sm"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5 sm:max-w-xs">
                  <Label htmlFor="rule-max" className="text-xs">
                    Maximum hours
                  </Label>
                  <Input
                    id="rule-max"
                    type="number"
                    value={formMaxHours}
                    onChange={(e) => setFormMaxHours(e.target.value)}
                    placeholder={
                      formType === "max_hours_daily" ? "e.g. 10" : "e.g. 48"
                    }
                    min="1"
                    step="0.5"
                    className="h-9 text-sm"
                  />
                </div>
              )}

              {/* Targeting */}
              <div className="space-y-2">
                <Label className="text-xs">Applies to</Label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <span className="text-[11px] text-muted-foreground">
                      Department
                    </span>
                    <select
                      aria-label="Department"
                      value={formDeptId}
                      onChange={(e) => setFormDeptId(e.target.value)}
                      className={SELECT_CLASS}
                    >
                      <option value="">All departments</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {assignableRoles.length > 0 && (
                    <div className="space-y-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        Custom role
                      </span>
                      <select
                        aria-label="Custom role"
                        value={formRoleId}
                        onChange={(e) => setFormRoleId(e.target.value)}
                        className={SELECT_CLASS}
                      >
                        <option value="">All roles</option>
                        {assignableRoles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.displayLabel}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {!formDeptId && !formRoleId
                    ? "This rule applies to all staff"
                    : formDeptId && formRoleId
                      ? "Applies to staff in the selected department who also hold the selected role"
                      : formDeptId
                        ? "Applies to staff in the selected department"
                        : "Applies to staff with the selected role"}
                </p>
              </div>

              {formError && <AlertBanner message={formError} variant="error" />}

              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={saving} className={PRIMARY_BUTTON}>
                  {saving
                    ? "Saving…"
                    : editingRule
                      ? "Update rule"
                      : "Create rule"}
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className={SECONDARY_BUTTON}
                >
                  Cancel
                </button>
              </div>
            </form>
          </Panel>
        )}

        {/* ── Rules list ── */}
        {rules.length === 0 && !showForm ? (
          error ? null : (
            <EmptyState
              title="No work rules yet"
              description="Work rules enforce break intervals and hour limits when work is assigned. Staff who would breach one are automatically marked ineligible."
              icon={Scale}
              action={
                <button onClick={openCreateForm} className={PRIMARY_BUTTON}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Create your first rule
                </button>
              }
            />
          )
        ) : (
          rules.length > 0 && (
            <Panel title="Rules" icon={Scale}>
              <ul className="divide-y divide-border">
                {rules.map((rule) => (
                  <li
                    key={rule.id}
                    className={`flex flex-wrap items-start justify-between gap-3 p-4 ${
                      rule.isActive ? "" : "opacity-60"
                    }`}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span
                        className={`mt-0.5 shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${
                          TYPE_COLORS[rule.type] ||
                          "bg-muted text-muted-foreground"
                        }`}
                      >
                        {TYPE_LABELS[rule.type] || rule.type}
                      </span>
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                          {rule.name}
                          {!rule.isActive && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                              Paused
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[12px] text-muted-foreground">
                          {rule.type === "break_interval"
                            ? `Every ${rule.hoursThreshold}h → ${rule.breakHours}h break`
                            : `Max ${rule.maxHours}h per ${
                                rule.type === "max_hours_daily" ? "day" : "week"
                              }`}
                          {" · "}
                          {getTargetLabel(rule)}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <button
                        onClick={() => handleToggle(rule)}
                        className={SECONDARY_BUTTON}
                      >
                        {rule.isActive ? (
                          <>
                            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                            Pause
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5" aria-hidden="true" />
                            Activate
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => openEditForm(rule)}
                        className={SECONDARY_BUTTON}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        Edit
                      </button>
                      <button
                        onClick={() => setDeleteTarget(rule)}
                        className={DANGER_BUTTON}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          )
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete "${deleteTarget?.name}"?`}
        description="This rule stops being enforced immediately. Staff previously blocked by it become eligible again. This cannot be undone."
        confirmLabel="Delete rule"
        variant="destructive"
        loading={deleting}
        onConfirm={onConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
