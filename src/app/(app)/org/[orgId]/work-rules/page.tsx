/**
 * Work Rules Page (Boundary Layer)
 *
 * Company Admin page for managing custom work rules.
 * Rules can target: all staff, a specific department,
 * a specific custom role, or both.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/page-loading";
import { AlertBanner } from "@/components/ui/alert-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

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

interface OrgRole { id: string; name: string; displayLabel: string; }
interface Department { id: string; name: string; }

const RULE_TYPES = [
  { value: "break_interval", label: "Break interval", description: "Require break after X hours worked" },
  { value: "max_hours_daily", label: "Max hours (daily)", description: "Cap daily working hours" },
  { value: "max_hours_weekly", label: "Max hours (weekly)", description: "Cap weekly working hours" },
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

export default function WorkRulesPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const [orgId, setOrgId] = useState("");
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

  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState("break_interval");
  const [formRoleId, setFormRoleId] = useState("");
  const [formDeptId, setFormDeptId] = useState("");
  const [formHoursThreshold, setFormHoursThreshold] = useState("");
  const [formBreakHours, setFormBreakHours] = useState("");
  const [formMaxHours, setFormMaxHours] = useState("");

  useEffect(() => { params.then(({ orgId: id }) => setOrgId(id)); }, [params]);

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/organizations/${orgId}/work-rules`);
      if (!res.ok) throw new Error();
      setRules(await res.json());
      setError(null);
    } catch { setError("Failed to load work rules"); }
    finally { setLoading(false); }
  }, [orgId]);

  const fetchRoles = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/roles`);
      if (res.ok) setRoles(await res.json());
    } catch { /* optional */ }
  }, [orgId]);

  const fetchDepartments = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/departments`);
      if (res.ok) { const d = await res.json(); setDepartments(Array.isArray(d) ? d : []); }
    } catch { /* optional */ }
  }, [orgId]);

  useEffect(() => {
    if (orgId) {
      void fetchRules();
      void fetchRoles();
      void fetchDepartments();
    }
  }, [fetchDepartments, fetchRoles, fetchRules, orgId]);

  function resetForm() {
    setFormName(""); setFormType("break_interval"); setFormRoleId("");
    setFormDeptId(""); setFormHoursThreshold(""); setFormBreakHours("");
    setFormMaxHours(""); setFormError(null); setEditingRule(null);
  }

  function openCreateForm() { resetForm(); setShowForm(true); }

  function openEditForm(rule: WorkRule) {
    setFormName(rule.name); setFormType(rule.type);
    setFormRoleId(rule.roleId || ""); setFormDeptId(rule.departmentId || "");
    setFormHoursThreshold(rule.hoursThreshold?.toString() || "");
    setFormBreakHours(rule.breakHours?.toString() || "");
    setFormMaxHours(rule.maxHours?.toString() || "");
    setFormError(null); setEditingRule(rule); setShowForm(true);
  }

  function closeForm() { setShowForm(false); resetForm(); }

  async function handleSubmit() {
    setFormError(null);
    if (!formName.trim()) { setFormError("Name is required"); return; }

    const body: Record<string, unknown> = {
      name: formName.trim(),
      type: formType,
      roleId: formRoleId || null,
      departmentId: formDeptId || null,
    };

    if (formType === "break_interval") {
      if (!formHoursThreshold || !formBreakHours) {
        setFormError("Hours threshold and break hours are required"); return;
      }
      body.hoursThreshold = parseFloat(formHoursThreshold);
      body.breakHours = parseFloat(formBreakHours);
    } else {
      if (!formMaxHours) { setFormError("Max hours is required"); return; }
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
      if (!res.ok) { const d = await res.json(); setFormError(d.error || "Failed to save"); return; }
      closeForm(); fetchRules();
    } catch { setFormError("Failed to save rule"); }
    finally { setSaving(false); }
  }

  async function handleToggle(rule: WorkRule) {
    try {
      await fetch(`/api/organizations/${orgId}/work-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      fetchRules();
    } catch { /* retry */ }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await fetch(`/api/organizations/${orgId}/work-rules/${deleteTarget.id}`, { method: "DELETE" });
      fetchRules();
      setDeleteTarget(null);
    } catch { /* retry */ }
  }

  function getTargetLabel(rule: WorkRule): string {
    const parts: string[] = [];
    if (rule.department) parts.push(rule.department.name);
    if (rule.role) parts.push(rule.role.displayLabel);
    return parts.length > 0 ? parts.join(" · ") : "All staff";
  }

  if (loading) return <PageLoading />;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Work Rules</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure break intervals and hour limits for your team
          </p>
        </div>
        {!showForm && <Button onClick={openCreateForm}>Add rule</Button>}
      </div>

      {error && <AlertBanner message={error} variant="error" />}

      {showForm && (
        <Card className="mb-6">
          <CardHeader><CardTitle className="text-base">{editingRule ? "Edit rule" : "New work rule"}</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Rule name</label>
                <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Kitchen daily limit, Standard break"
                  className="w-full rounded-md border px-3 py-2 text-sm bg-background" />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Rule type</label>
                <select value={formType} onChange={(e) => setFormType(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 text-sm bg-background">
                  {RULE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label} — {t.description}</option>
                  ))}
                </select>
              </div>

              {formType === "break_interval" ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium mb-1">After every (hours)</label>
                    <input type="number" value={formHoursThreshold} onChange={(e) => setFormHoursThreshold(e.target.value)}
                      placeholder="e.g. 6" min="1" step="0.5" className="w-full rounded-md border px-3 py-2 text-sm bg-background" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Require break (hours)</label>
                    <input type="number" value={formBreakHours} onChange={(e) => setFormBreakHours(e.target.value)}
                      placeholder="e.g. 1" min="0.5" step="0.5" className="w-full rounded-md border px-3 py-2 text-sm bg-background" />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium mb-1">Maximum hours</label>
                  <input type="number" value={formMaxHours} onChange={(e) => setFormMaxHours(e.target.value)}
                    placeholder={formType === "max_hours_daily" ? "e.g. 10" : "e.g. 48"}
                    min="1" step="0.5" className="w-full rounded-md border px-3 py-2 text-sm bg-background" />
                </div>
              )}

              {/* Targeting — Department and/or Role */}
              <div>
                <label className="block text-sm font-medium mb-1">Applies to</label>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Department</label>
                    <select value={formDeptId} onChange={(e) => setFormDeptId(e.target.value)}
                      className="w-full rounded-md border px-3 py-2 text-sm bg-background">
                      <option value="">All departments</option>
                      {departments.map((d) => (<option key={d.id} value={d.id}>{d.name}</option>))}
                    </select>
                  </div>
                  {roles.length > 0 && (
                    <div>
                      <label className="block text-xs text-muted-foreground mb-1">Custom role</label>
                      <select value={formRoleId} onChange={(e) => setFormRoleId(e.target.value)}
                        className="w-full rounded-md border px-3 py-2 text-sm bg-background">
                        <option value="">All roles</option>
                        {roles.map((r) => (<option key={r.id} value={r.id}>{r.displayLabel}</option>))}
                      </select>
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {!formDeptId && !formRoleId ? "This rule applies to all staff" :
                   formDeptId && formRoleId ? "Applies to staff in the selected department with the selected role" :
                   formDeptId ? "Applies to staff in the selected department" :
                   "Applies to staff with the selected role"}
                </p>
              </div>

              {formError && <AlertBanner message={formError} variant="error" />}

              <div className="flex gap-2">
                <Button onClick={handleSubmit} disabled={saving}>
                  {saving ? "Saving..." : editingRule ? "Update rule" : "Create rule"}
                </Button>
                <Button variant="outline" onClick={closeForm}>Cancel</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {rules.length === 0 && !showForm ? (
        <EmptyState
          title="No work rules configured yet"
          description="Work rules enforce break intervals and hour limits during task assignment. Staff who would violate a rule are automatically marked as ineligible."
          action={<Button onClick={openCreateForm}>Create your first rule</Button>}
        />
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <div key={rule.id} className={`flex items-center justify-between rounded-lg border px-4 py-3 ${rule.isActive ? "" : "opacity-50"}`}>
              <div className="flex items-center gap-3 min-w-0">
                <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${TYPE_COLORS[rule.type] || "bg-gray-100 text-gray-700"}`}>
                  {TYPE_LABELS[rule.type] || rule.type}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{rule.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {rule.type === "break_interval"
                      ? `Every ${rule.hoursThreshold}h → ${rule.breakHours}h break`
                      : `Max ${rule.maxHours}h per ${rule.type === "max_hours_daily" ? "day" : "week"}`}
                    {" · "}{getTargetLabel(rule)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-2">
                <Button variant="outline" size="sm" onClick={() => handleToggle(rule)}>
                  {rule.isActive ? "Disable" : "Enable"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => openEditForm(rule)}>Edit</Button>
                <Button variant="outline" size="sm" onClick={() => setDeleteTarget(rule)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950">Delete</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete ${deleteTarget?.name ?? "work rule"}?`}
        description="This rule will stop protecting future assignments. This cannot be undone."
        confirmLabel="Delete rule"
        variant="destructive"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
