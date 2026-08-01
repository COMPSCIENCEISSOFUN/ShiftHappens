"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpenCheck, Pencil, Plus, Trash2, X } from "lucide-react";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface Department { id: string; name: string }
interface Definition {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  departmentRequirements: {
    departmentId: string;
    isRequired: boolean;
    department: Department;
  }[];
}
interface FormState {
  name: string;
  description: string;
  isActive: boolean;
  departments: Record<string, "required" | "optional">;
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  isActive: true,
  departments: {},
};

export function CertificationDefinitionManager({ orgId }: { orgId: string }) {
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<Definition | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [definitionResponse, departmentResponse] = await Promise.all([
        fetch(`/api/organizations/${orgId}/certification-definitions?includeInactive=true`),
        fetch(`/api/organizations/${orgId}/departments`),
      ]);
      const definitionData = await definitionResponse.json();
      const departmentData = await departmentResponse.json();
      if (!definitionResponse.ok || !Array.isArray(definitionData.definitions)) {
        throw new Error(definitionData.error || "Failed to load definitions");
      }
      setDefinitions(definitionData.definitions);
      setCanManage(Boolean(definitionData.canManage));
      setDepartments(Array.isArray(departmentData) ? departmentData : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load definitions");
    }
  }, [orgId]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
    setError(null);
  }

  function openEdit(definition: Definition) {
    setEditingId(definition.id);
    setForm({
      name: definition.name,
      description: definition.description ?? "",
      isActive: definition.isActive,
      departments: Object.fromEntries(
        definition.departmentRequirements.map((item) => [
          item.departmentId,
          item.isRequired ? "required" : "optional",
        ])
      ),
    });
    setFormOpen(true);
    setError(null);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function toggleDepartment(departmentId: string, checked: boolean) {
    setForm((current) => {
      const next = { ...current.departments };
      if (checked) next[departmentId] = "optional";
      else delete next[departmentId];
      return { ...current, departments: next };
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !form.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        editingId
          ? `/api/organizations/${orgId}/certification-definitions/${editingId}`
          : `/api/organizations/${orgId}/certification-definitions`,
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            description: form.description,
            isActive: form.isActive,
            departmentRequirements: Object.entries(form.departments).map(
              ([departmentId, status]) => ({
                departmentId,
                isRequired: status === "required",
              })
            ),
          }),
        }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not save definition");
      closeForm();
      await fetchData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save definition");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleteTarget || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/organizations/${orgId}/certification-definitions/${deleteTarget.id}`,
        { method: "DELETE" }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not delete definition");
      setDeleteTarget(null);
      await fetchData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete definition");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-5 border-y border-border py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <BookOpenCheck className="mt-0.5 size-4 shrink-0 text-indigo-600" />
          <div>
            <h3 className="text-sm font-semibold">Certification catalogue</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {canManage
                ? "Define approved qualifications and department requirements."
                : "Approved qualifications configured by the Company Admin."}
            </p>
          </div>
        </div>
        {canManage && !formOpen && (
          <Button size="sm" onClick={openCreate}><Plus /> Add definition</Button>
        )}
      </div>

      {error && (
        <AlertBanner className="mt-3" message={error} variant="error" onDismiss={() => setError(null)} />
      )}

      {formOpen && canManage && (
        <form onSubmit={save} className="mt-4 border-t border-border pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="definition-name">Name</Label>
              <Input id="definition-name" value={form.name} maxLength={200} required onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </div>
            <div className="flex items-end gap-2 pb-1">
              <Switch id="definition-active" checked={form.isActive} onCheckedChange={(isActive) => setForm({ ...form, isActive })} />
              <Label htmlFor="definition-active">Active</Label>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="definition-description">Description</Label>
              <textarea id="definition-description" value={form.description} maxLength={2000} rows={2} onChange={(event) => setForm({ ...form, description: event.target.value })} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            </div>
          </div>

          {departments.length > 0 && (
            <fieldset className="mt-3">
              <legend className="text-xs font-semibold">Departments</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {departments.map((department) => {
                  const status = form.departments[department.id];
                  return (
                    <div key={department.id} className="flex min-w-0 items-center gap-2 border-b border-border/60 py-2">
                      <input type="checkbox" checked={Boolean(status)} onChange={(event) => toggleDepartment(department.id, event.target.checked)} />
                      <span className="min-w-0 flex-1 truncate text-sm">{department.name}</span>
                      <select aria-label={`${department.name} requirement`} value={status ?? "optional"} disabled={!status} onChange={(event) => setForm({ ...form, departments: { ...form.departments, [department.id]: event.target.value as "required" | "optional" } })} className="h-7 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-40">
                        <option value="optional">Optional</option>
                        <option value="required">Required</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          )}

          <div className="mt-4 flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving..." : editingId ? "Save changes" : "Create definition"}</Button>
            <Button type="button" size="sm" variant="outline" onClick={closeForm}><X /> Cancel</Button>
          </div>
        </form>
      )}

      {!formOpen && (
        <div className="mt-3 divide-y divide-border">
          {definitions.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No certification definitions configured yet.</p>
          ) : definitions.map((definition) => (
            <div key={definition.id} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">{definition.name}</p>
                  {!definition.isActive && <span className="text-xs text-muted-foreground">Inactive</span>}
                </div>
                {definition.description && <p className="mt-0.5 text-xs text-muted-foreground">{definition.description}</p>}
                {definition.departmentRequirements.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {definition.departmentRequirements.map((item) => `${item.department.name}${item.isRequired ? " (required)" : ""}`).join(", ")}
                  </p>
                )}
              </div>
              {canManage && (
                <div className="flex shrink-0 gap-1">
                  <Button size="icon-sm" variant="ghost" title={`Edit ${definition.name}`} onClick={() => openEdit(definition)}><Pencil /></Button>
                  <Button size="icon-sm" variant="ghost" title={`Delete ${definition.name}`} onClick={() => setDeleteTarget(definition)}><Trash2 /></Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog open={Boolean(deleteTarget)} title={`Delete ${deleteTarget?.name ?? "definition"}?`} description="Historical Staff submissions remain on record, but this qualification will no longer be available for new submissions or task requirements." confirmLabel="Delete definition" variant="destructive" loading={busy} onCancel={() => setDeleteTarget(null)} onConfirm={() => void remove()} />
    </section>
  );
}
