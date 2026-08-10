/**
 * Platform Admin — Industry Templates Page (Boundary Layer)
 *
 * Templates are what a new organisation is built from at onboarding:
 * departments, work rules and certifications, pre-filled for an industry.
 * Platform admins only.
 *
 * ## On the visual language
 *
 * The most dated page in the application — bare shadcn `Card` stacks, plain
 * grey boxes where the stat tiles go, text-only buttons, no icons anywhere. It
 * now matches the org-level pages.
 *
 * ## What changed beyond the styling
 *
 * - **A failed load showed an empty list and said nothing.** `fetchTemplates`
 *   was `if (res.ok) { ... }` with no else, so a 500 rendered "no templates
 *   yet" — indistinguishable from a working platform with nothing in it. This
 *   is the same failure mode that made the deployed Tasks page hard to
 *   diagnose, and it is worse here, because the honest empty state and the
 *   broken one looked identical.
 * - **Deactivating had no confirmation**, and its failure was swallowed the
 *   same way. Deactivating a template does not delete it, but it does remove an
 *   industry from onboarding for every future customer.
 * - **The form was not a `<form>`.** Submit lived on a button's onClick, so
 *   pressing Enter in any field did nothing.
 * - **`isAiGenerated` was recomputed on save** as `aiPrompt.length > 0`. On
 *   edit the prompt box is empty, so editing an AI-built template would have
 *   flipped the flag to false. It never actually did, because the PATCH route
 *   does not read that field — but the client was sending a wrong value and
 *   relying on the server to ignore it. It is now only sent on create.
 * - **Certifications were sent as typed**, including blank rows the user added
 *   and left empty. Trimmed and dropped now, as the service expects.
 * - **The success banner never cleared**, so "Template created" stayed on
 *   screen while you edited the next one. Fixed here, once, by clearing it at
 *   the start of each handler — which left the same defect standing on seven
 *   other pages, because it was treated as a bug in this file rather than as a
 *   consequence of confirming a finished action with a persistent element.
 *   Confirmations are toasts now, everywhere; the clearing calls are gone.
 *
 * ## On the certifications shape
 *
 * They are `string[]` — plain names, not objects. That is what
 * `industry-templates.ts` seeds, what the service validates, and what
 * onboarding reads. Worth stating because the departments beside them ARE
 * objects, and the asymmetry invites a wrong assumption.
 */
"use client";

import { useEffect, useState } from "react";
import {
  Award,
  Building2,
  LayoutTemplate,
  Pencil,
  Plus,
  Power,
  Scale,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { AlertBanner } from "@/components/ui/alert-banner";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLoading } from "@/components/ui/page-loading";
import { Panel } from "@/components/ui/panel";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import {
  DANGER_GHOST_BUTTON,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "@/components/ui/button-styles";

/* ------------------------------------------------------------------ */
/*  Types and constants                                                */
/* ------------------------------------------------------------------ */

interface TemplateDepartment {
  name: string;
  description: string;
  color: string;
}

interface TemplateWorkRule {
  name: string;
  type: string;
  hoursThreshold?: number;
  breakHours?: number;
  maxHours?: number;
  reason: string;
}

interface Template {
  id: string;
  name: string;
  icon: string;
  description: string;
  departments: TemplateDepartment[];
  workRules: TemplateWorkRule[];
  /** Plain names, not objects — see the note in the file header. */
  certifications: string[];
  isActive: boolean;
  isAiGenerated: boolean;
  usageCount: number;
  createdAt: string;
}

type ViewMode = "list" | "create" | "edit";

const WORK_RULE_TYPES = [
  { value: "break_interval", label: "Break interval" },
  { value: "max_hours_daily", label: "Max hours (daily)" },
  { value: "max_hours_weekly", label: "Max hours (weekly)" },
];

const DEFAULT_COLORS = [
  "#EF4444", "#3B82F6", "#10B981", "#8B5CF6",
  "#F59E0B", "#6B7280", "#EC4899", "#14B8A6",
];

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground";

const ROW_BUTTON =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:border-red-400 hover:text-red-600 dark:hover:text-red-400";

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggleTarget, setToggleTarget] = useState<Template | null>(null);
  const [toggling, setToggling] = useState(false);

  // ─── Form state ─────────────────────────────────────────────
  const [formName, setFormName] = useState("");
  const [formIcon, setFormIcon] = useState("Building");
  const [formDescription, setFormDescription] = useState("");
  const [formDepartments, setFormDepartments] = useState<TemplateDepartment[]>([]);
  const [formWorkRules, setFormWorkRules] = useState<TemplateWorkRule[]>([]);
  const [formCertifications, setFormCertifications] = useState<string[]>([]);
  const [formSaving, setFormSaving] = useState(false);

  // ─── AI generation state ────────────────────────────────────
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);

  async function fetchTemplates() {
    try {
      const res = await fetch("/api/platform/templates");
      const data = await res.json().catch(() => null);

      if (!res.ok || !Array.isArray(data)) {
        setError(
          typeof data?.error === "string" ? data.error : "Failed to load templates"
        );
        return;
      }

      setTemplates(data);
      setError(null);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system, which is what effects are for: loads the template list from the server on mount
    fetchTemplates();
  }, []);

  // ─── Form helpers ───────────────────────────────────────────

  function resetForm() {
    setFormName("");
    setFormIcon("Building");
    setFormDescription("");
    setFormDepartments([]);
    setFormWorkRules([]);
    setFormCertifications([]);
    setEditingId(null);
    setAiPrompt("");
  }

  function openCreate() {
    resetForm();
    setViewMode("create");
    setError(null);
  }

  function openEdit(template: Template) {
    setFormName(template.name);
    setFormIcon(template.icon);
    setFormDescription(template.description);
    setFormDepartments(template.departments.map((d) => ({ ...d })));
    setFormWorkRules(template.workRules.map((r) => ({ ...r })));
    setFormCertifications([...template.certifications]);
    setEditingId(template.id);
    setViewMode("edit");
    setError(null);
  }

  function cancelForm() {
    resetForm();
    setViewMode("list");
    setError(null);
  }

  // ─── Row editors ────────────────────────────────────────────

  function addDepartment() {
    const colorIndex = formDepartments.length % DEFAULT_COLORS.length;
    setFormDepartments([
      ...formDepartments,
      { name: "", description: "", color: DEFAULT_COLORS[colorIndex] },
    ]);
  }

  function updateDepartment(index: number, field: string, value: string) {
    const updated = [...formDepartments];
    updated[index] = { ...updated[index], [field]: value };
    setFormDepartments(updated);
  }

  function removeDepartment(index: number) {
    setFormDepartments(formDepartments.filter((_, i) => i !== index));
  }

  function addWorkRule() {
    setFormWorkRules([
      ...formWorkRules,
      { name: "", type: "break_interval", reason: "" },
    ]);
  }

  function updateWorkRule(index: number, field: string, value: string | number) {
    const updated = [...formWorkRules];
    updated[index] = { ...updated[index], [field]: value };
    setFormWorkRules(updated);
  }

  function removeWorkRule(index: number) {
    setFormWorkRules(formWorkRules.filter((_, i) => i !== index));
  }

  function addCertification() {
    setFormCertifications([...formCertifications, ""]);
  }

  function updateCertification(index: number, value: string) {
    const updated = [...formCertifications];
    updated[index] = value;
    setFormCertifications(updated);
  }

  function removeCertification(index: number) {
    setFormCertifications(formCertifications.filter((_, i) => i !== index));
  }

  // ─── AI generation ──────────────────────────────────────────

  async function handleAiGenerate() {
    if (aiPrompt.trim().length < 10) {
      setError("Describe the industry in at least 10 characters");
      return;
    }

    setAiGenerating(true);
    setError(null);

    try {
      const res = await fetch("/api/organizations/generate-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: aiPrompt.trim() }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data) {
        setError(
          typeof data?.error === "string"
            ? data.error
            : "AI generation failed. Try a different description."
        );
        return;
      }

      if (Array.isArray(data.departments)) setFormDepartments(data.departments);
      if (Array.isArray(data.workRules)) setFormWorkRules(data.workRules);
      if (Array.isArray(data.certifications)) setFormCertifications(data.certifications);
      if (typeof data.name === "string") setFormName(data.name);
      setFormDescription(aiPrompt.trim().slice(0, 200));

      toast.success("AI generated template content. Review and edit before saving.");
    } catch {
      setError("AI generation failed. Try again.");
    } finally {
      setAiGenerating(false);
    }
  }

  // ─── Save ───────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!formName.trim()) return setError("Template name is required");
    if (!formDescription.trim()) return setError("Template description is required");
    if (formDepartments.length === 0)
      return setError("At least one department is required");
    if (formDepartments.some((d) => !d.name.trim()))
      return setError("All departments must have a name");
    if (formWorkRules.some((r) => !r.name.trim()))
      return setError("All work rules must have a name");

    setFormSaving(true);

    const payload = {
      name: formName.trim(),
      icon: formIcon,
      description: formDescription.trim(),
      departments: formDepartments,
      workRules: formWorkRules,
      // Blank rows are an artefact of the "Add certification" button, not input.
      certifications: formCertifications.map((c) => c.trim()).filter(Boolean),
      // Only meaningful on create. On edit the prompt box is always empty, so
      // sending it would claim a hand-written template where an AI one exists.
      ...(editingId ? {} : { isAiGenerated: aiPrompt.trim().length > 0 }),
    };

    try {
      const res = await fetch(
        editingId
          ? `/api/platform/templates/${editingId}`
          : "/api/platform/templates",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      const result = await res.json().catch(() => null);

      if (!res.ok) {
        setError(
          typeof result?.error === "string" ? result.error : "Failed to save template"
        );
        return;
      }

      toast.success(editingId ? "Template updated" : "Template created");
      resetForm();
      setViewMode("list");
      await fetchTemplates();
    } catch {
      setError("Could not reach the server. The template was not saved.");
    } finally {
      setFormSaving(false);
    }
  }

  // ─── Activate / deactivate ──────────────────────────────────

  async function applyToggle(template: Template) {
    setToggling(true);
    try {
      const res = await fetch(`/api/platform/templates/${template.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(
          typeof data?.error === "string" ? data.error : "Failed to update status"
        );
        return;
      }

      setToggleTarget(null);
      await fetchTemplates();
    } catch {
      setError("Could not reach the server. The status was not changed.");
    } finally {
      setToggling(false);
    }
  }

  function requestToggle(template: Template) {
    // Reactivating adds an option back to onboarding — harmless, no prompt.
    if (!template.isActive) {
      void applyToggle(template);
      return;
    }
    setToggleTarget(template);
  }

  // ─── Derived ────────────────────────────────────────────────

  const activeCount = templates.filter((t) => t.isActive).length;
  const aiCount = templates.filter((t) => t.isAiGenerated).length;
  const totalUsage = templates.reduce((sum, t) => sum + t.usageCount, 0);

  if (loading) return <PageLoading label="Loading templates..." />;

  const banners = (
    <>
      {error && <AlertBanner message={error} variant="error" className="mb-4" />}
    </>
  );

  /* ---------------------------------------------------------------- */
  /*  Create / edit                                                    */
  /* ---------------------------------------------------------------- */

  if (viewMode === "create" || viewMode === "edit") {
    return (
      <div className="w-full">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
              {viewMode === "create" ? "New template" : "Edit template"}
            </h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Departments, work rules and certifications a new organisation
              starts with
            </p>
          </div>
          <button onClick={cancelForm} className={SECONDARY_BUTTON}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Cancel
          </button>
        </div>

        {banners}

        <form onSubmit={handleSubmit} className="space-y-4">
          {viewMode === "create" && (
            <Panel title="Generate with AI" icon={Sparkles}>
              <div className="space-y-2 p-4">
                <p className="text-[12px] text-muted-foreground">
                  Describe an industry and the model fills in departments, work
                  rules and certifications. Everything stays editable.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="e.g. Logistics and warehousing with delivery drivers"
                    maxLength={500}
                    aria-label="Industry description for AI generation"
                    className="flex-1"
                  />
                  <button
                    type="button"
                    onClick={handleAiGenerate}
                    disabled={aiGenerating}
                    className={PRIMARY_BUTTON}
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    {aiGenerating ? "Generating…" : "Generate"}
                  </button>
                </div>
              </div>
            </Panel>
          )}

          <Panel title="Template details" icon={LayoutTemplate}>
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="templateName" className="text-xs">
                  Name
                </Label>
                <Input
                  id="templateName"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Logistics / Warehousing"
                  maxLength={100}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="templateDesc" className="text-xs">
                  Description
                </Label>
                <Input
                  id="templateDesc"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="e.g. Delivery companies, fulfilment centres"
                  maxLength={200}
                />
              </div>
            </div>
          </Panel>

          {/* ── Departments ── */}
          <Panel
            title="Departments"
            icon={Building2}
            count={formDepartments.length}
            action={
              <button type="button" onClick={addDepartment} className={SECONDARY_BUTTON}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add
              </button>
            }
          >
            <div className="space-y-3 p-4">
              {formDepartments.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  At least one is required — this is what the new organisation
                  is structured around.
                </p>
              ) : (
                formDepartments.map((dept, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <input
                      type="color"
                      value={dept.color}
                      onChange={(e) => updateDepartment(i, "color", e.target.value)}
                      aria-label={`Colour for department ${i + 1}`}
                      className="mt-0.5 h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-input bg-background"
                    />
                    <div className="flex-1 space-y-2">
                      <Input
                        value={dept.name}
                        onChange={(e) => updateDepartment(i, "name", e.target.value)}
                        placeholder="Department name"
                        aria-label={`Name for department ${i + 1}`}
                      />
                      <Input
                        value={dept.description}
                        onChange={(e) =>
                          updateDepartment(i, "description", e.target.value)
                        }
                        placeholder="Brief description"
                        aria-label={`Description for department ${i + 1}`}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeDepartment(i)}
                      aria-label={`Remove department ${i + 1}`}
                      className={`mt-0.5 ${ROW_BUTTON}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </Panel>

          {/* ── Work rules ── */}
          <Panel
            title="Work rules"
            icon={Scale}
            count={formWorkRules.length}
            action={
              <button type="button" onClick={addWorkRule} className={SECONDARY_BUTTON}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add
              </button>
            }
          >
            <div className="space-y-3 p-4">
              {formWorkRules.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  Optional. Break intervals and hour caps the new organisation
                  starts with.
                </p>
              ) : (
                formWorkRules.map((rule, i) => (
                  <div
                    key={i}
                    className="space-y-3 rounded-lg border border-border p-3"
                  >
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        value={rule.name}
                        onChange={(e) => updateWorkRule(i, "name", e.target.value)}
                        placeholder="Rule name"
                        aria-label={`Name for work rule ${i + 1}`}
                        className="flex-1"
                      />
                      <div className="flex gap-2">
                        <select
                          className={`${SELECT_CLASS} sm:w-48`}
                          value={rule.type}
                          onChange={(e) => updateWorkRule(i, "type", e.target.value)}
                          aria-label={`Type for work rule ${i + 1}`}
                        >
                          {WORK_RULE_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => removeWorkRule(i)}
                          aria-label={`Remove work rule ${i + 1}`}
                          className={ROW_BUTTON}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-3">
                      {rule.type === "break_interval" ? (
                        <>
                          <div className="space-y-1">
                            <Label className="text-xs">Hours before break</Label>
                            <Input
                              type="number"
                              min={1}
                              max={24}
                              value={rule.hoursThreshold ?? ""}
                              onChange={(e) =>
                                updateWorkRule(i, "hoursThreshold", Number(e.target.value))
                              }
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Break duration (hrs)</Label>
                            <Input
                              type="number"
                              min={0.5}
                              max={8}
                              step={0.5}
                              value={rule.breakHours ?? ""}
                              onChange={(e) =>
                                updateWorkRule(i, "breakHours", Number(e.target.value))
                              }
                            />
                          </div>
                        </>
                      ) : (
                        <div className="space-y-1">
                          <Label className="text-xs">Max hours</Label>
                          <Input
                            type="number"
                            min={1}
                            max={168}
                            value={rule.maxHours ?? ""}
                            onChange={(e) =>
                              updateWorkRule(i, "maxHours", Number(e.target.value))
                            }
                          />
                        </div>
                      )}
                    </div>

                    <Input
                      value={rule.reason}
                      onChange={(e) => updateWorkRule(i, "reason", e.target.value)}
                      placeholder="Why this rule exists — shown to admins"
                      aria-label={`Reason for work rule ${i + 1}`}
                    />
                  </div>
                ))
              )}
            </div>
          </Panel>

          {/* ── Certifications ── */}
          <Panel
            title="Certifications"
            icon={Award}
            count={formCertifications.length}
            action={
              <button
                type="button"
                onClick={addCertification}
                className={SECONDARY_BUTTON}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add
              </button>
            }
          >
            <div className="space-y-2 p-4">
              {formCertifications.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  Optional. Qualifications staff may need for certain shifts.
                </p>
              ) : (
                formCertifications.map((cert, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      value={cert}
                      onChange={(e) => updateCertification(i, e.target.value)}
                      placeholder="e.g. Food Safety Level 2"
                      aria-label={`Certification ${i + 1}`}
                      className="flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => removeCertification(i)}
                      aria-label={`Remove certification ${i + 1}`}
                      className={ROW_BUTTON}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </Panel>

          <div className="flex justify-end gap-2 pb-8">
            <button type="button" onClick={cancelForm} className={SECONDARY_BUTTON}>
              Cancel
            </button>
            <button type="submit" disabled={formSaving} className={PRIMARY_BUTTON}>
              {formSaving
                ? "Saving…"
                : viewMode === "create"
                  ? "Create template"
                  : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  List                                                             */
  /* ---------------------------------------------------------------- */

  return (
    <div className="w-full">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
            Industry templates
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            What a new organisation is built from at onboarding. Deactivating one
            hides it from new sign-ups without affecting anyone already using it
          </p>
        </div>
        <button onClick={openCreate} className={PRIMARY_BUTTON}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New Template
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Total"
          value={templates.length}
          detail="templates defined"
          accentColour={STAT_ACCENT.indigo}
        />
        <StatTile
          label="Active"
          value={activeCount}
          detail="offered at onboarding"
          accentColour={STAT_ACCENT.green}
          valueColour={activeCount > 0 ? "text-green-600 dark:text-green-400" : ""}
        />
        <StatTile
          label="AI-generated"
          value={aiCount}
          detail="built from a description"
          accentColour={STAT_ACCENT.blue}
        />
        <StatTile
          label="In use"
          value={totalUsage}
          detail="organisations built from one"
          accentColour={STAT_ACCENT.amber}
        />
      </div>

      {banners}

      {/*
        `&& !error` matters. Without it a failed load shows the error banner AND
        "No templates yet" underneath it, which is a worse lie than either alone
        — the reader is told the platform is empty and that something broke, and
        has to guess which. An empty list is only news when we know it is true.
      */}
      {templates.length === 0 && !error ? (
        <EmptyState
          icon={LayoutTemplate}
          title="No templates yet"
          description="New organisations will onboard with an empty structure until you add one."
          action={
            <button onClick={openCreate} className={PRIMARY_BUTTON}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              New Template
            </button>
          }
        />
      ) : (
        <div className="space-y-2.5">
          {templates.map((template) => (
            <div
              key={template.id}
              className={`rounded-xl border bg-card p-3.5 sm:p-4 ${
                template.isActive ? "border-border" : "border-border opacity-60"
              }`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[14px] font-semibold">{template.name}</h3>
                    {template.isAiGenerated && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                        <Sparkles className="h-3 w-3" aria-hidden="true" />
                        AI
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        template.isActive
                          ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {template.isActive ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {template.description}
                  </p>
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => openEdit(template)}
                    className={SECONDARY_BUTTON}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                  </button>
                  <button
                    onClick={() => requestToggle(template)}
                    className={
                      template.isActive ? DANGER_GHOST_BUTTON : SECONDARY_BUTTON
                    }
                  >
                    <Power className="h-3.5 w-3.5" aria-hidden="true" />
                    {template.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Building2 className="h-3 w-3" aria-hidden="true" />
                  {template.departments.length} departments
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Scale className="h-3 w-3" aria-hidden="true" />
                  {template.workRules.length} work rules
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Award className="h-3 w-3" aria-hidden="true" />
                  {template.certifications.length} certifications
                </span>
                <span
                  className={`sm:ml-auto ${
                    template.usageCount > 0 ? "font-medium text-foreground" : ""
                  }`}
                >
                  {template.usageCount} org
                  {template.usageCount === 1 ? "" : "s"} using
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={toggleTarget !== null}
        title={`Deactivate ${toggleTarget?.name ?? ""}?`}
        description={
          toggleTarget
            ? `New organisations will no longer be offered this template. The ${
                toggleTarget.usageCount
              } ${
                toggleTarget.usageCount === 1 ? "organisation" : "organisations"
              } already built from it keep everything — nothing is deleted, and you can reactivate it at any time.`
            : ""
        }
        confirmLabel="Deactivate"
        variant="destructive"
        loading={toggling}
        onConfirm={() => toggleTarget && applyToggle(toggleTarget)}
        onCancel={() => setToggleTarget(null)}
      />
    </div>
  );
}
