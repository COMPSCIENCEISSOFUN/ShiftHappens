/**
 * Platform Admin — Industry Templates Page (Boundary Layer)
 *
 * Allows platform admins to manage industry templates:
 * - View all templates with usage counts
 * - Create new templates (manual or AI-generated)
 * - Edit existing templates
 * - Toggle active/inactive status
 */
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageLoading } from "@/components/ui/page-loading";

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

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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

  useEffect(() => {
    fetchTemplates();
  }, []);

  async function fetchTemplates() {
    try {
      const res = await fetch("/api/platform/templates");
      if (res.ok) {
        const data = await res.json();
        setTemplates(data);
      }
    } catch {
      setError("Failed to load templates");
    } finally {
      setLoading(false);
    }
  }

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
    setSuccess(null);
  }

  function openEdit(template: Template) {
    setFormName(template.name);
    setFormIcon(template.icon);
    setFormDescription(template.description);
    setFormDepartments([...template.departments]);
    setFormWorkRules([...template.workRules]);
    setFormCertifications([...template.certifications]);
    setEditingId(template.id);
    setViewMode("edit");
    setError(null);
    setSuccess(null);
  }

  function cancelForm() {
    resetForm();
    setViewMode("list");
    setError(null);
  }

  // ─── Department management ──────────────────────────────────

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

  // ─── Work rule management ───────────────────────────────────

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

  // ─── Certification management ───────────────────────────────

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

  // ─── AI generation ─────────────────────────────────────────

  async function handleAiGenerate() {
    if (!aiPrompt.trim() || aiPrompt.trim().length < 10) {
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

      if (!res.ok) {
        setError("AI generation failed. Try a different description.");
        return;
      }

      const data = await res.json();

      if (data.departments) setFormDepartments(data.departments);
      if (data.workRules) setFormWorkRules(data.workRules);
      if (data.certifications) setFormCertifications(data.certifications);

      if (data.name) setFormName(data.name);
      setFormDescription(aiPrompt.trim().slice(0, 200));

      setSuccess("AI generated template content. Review and edit before saving.");
    } catch {
      setError("AI generation failed. Try again.");
    } finally {
      setAiGenerating(false);
    }
  }

  // ─── Save template ──────────────────────────────────────────

  async function handleSave() {
    setError(null);

    // Validate required fields
    if (!formName.trim()) {
      setError("Template name is required");
      return;
    }
    if (!formDescription.trim()) {
      setError("Template description is required");
      return;
    }
    if (formDepartments.length === 0) {
      setError("At least one department is required");
      return;
    }
    if (formDepartments.some((d) => !d.name.trim())) {
      setError("All departments must have a name");
      return;
    }

    setFormSaving(true);

    const payload = {
      name: formName.trim(),
      icon: formIcon,
      description: formDescription.trim(),
      departments: formDepartments,
      workRules: formWorkRules,
      certifications: formCertifications.filter((c) => c.trim()),
      isAiGenerated: aiPrompt.trim().length > 0,
    };

    try {
      const url = editingId
        ? `/api/platform/templates/${editingId}`
        : "/api/platform/templates";
      const method = editingId ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "Failed to save template");
        return;
      }

      setSuccess(editingId ? "Template updated" : "Template created");
      resetForm();
      setViewMode("list");
      fetchTemplates();
    } catch {
      setError("Something went wrong");
    } finally {
      setFormSaving(false);
    }
  }

  // ─── Toggle status ──────────────────────────────────────────

  async function handleToggleStatus(templateId: string) {
    try {
      const res = await fetch(`/api/platform/templates/${templateId}`, {
        method: "DELETE",
      });

      if (res.ok) {
        fetchTemplates();
      }
    } catch {
      setError("Failed to update status");
    }
  }

  // ─── Computed ───────────────────────────────────────────────

  const activeCount = templates.filter((t) => t.isActive).length;
  const aiCount = templates.filter((t) => t.isAiGenerated).length;
  const totalUsage = templates.reduce((sum, t) => sum + t.usageCount, 0);

  if (loading) return <PageLoading label="Loading templates..." />;

  return (
    <div className="max-w-4xl">
      {error && (
        <AlertBanner message={error} variant="error" className="mb-4" />
      )}
      {success && (
        <AlertBanner message={success} variant="success" className="mb-4" />
      )}

      {/* ─── List View ───────────────────────────────────────── */}
      {viewMode === "list" && (
        <>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold">Industry templates</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Manage onboarding templates for new organizations
              </p>
            </div>
            <Button onClick={openCreate}>Add template</Button>
          </div>

          <div className="grid grid-cols-4 gap-3 mb-6">
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xl font-medium">{templates.length}</p>
              <p className="text-xs text-muted-foreground">total</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xl font-medium">{activeCount}</p>
              <p className="text-xs text-muted-foreground">active</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xl font-medium">{aiCount}</p>
              <p className="text-xs text-muted-foreground">AI-generated</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xl font-medium">{totalUsage}</p>
              <p className="text-xs text-muted-foreground">orgs using</p>
            </div>
          </div>

          <div className="space-y-3">
            {templates.map((template) => (
              <Card
                key={template.id}
                className={template.isActive ? "" : "opacity-50"}
              >
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{template.name}</p>
                        {template.isAiGenerated && (
                          <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                            AI
                          </span>
                        )}
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            template.isActive
                              ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                              : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                          }`}
                        >
                          {template.isActive ? "active" : "inactive"}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        {template.description}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => openEdit(template)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => handleToggleStatus(template.id)}
                      >
                        {template.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  </div>
                  <div className="flex gap-4 mt-3 pt-3 border-t text-xs text-muted-foreground">
                    <span>{template.departments.length} departments</span>
                    <span>{template.workRules.length} work rules</span>
                    <span>{template.certifications.length} certifications</span>
                    <span className="ml-auto text-primary">
                      {template.usageCount} org{template.usageCount !== 1 ? "s" : ""} using
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* ─── Create / Edit View ──────────────────────────────── */}
      {(viewMode === "create" || viewMode === "edit") && (
        <>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold">
              {viewMode === "create" ? "Create template" : "Edit template"}
            </h2>
            <Button variant="outline" onClick={cancelForm}>
              Cancel
            </Button>
          </div>

          {viewMode === "create" && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="text-base">Generate with AI</CardTitle>
                <CardDescription>
                  Describe an industry and AI will generate departments, work rules, and certifications
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-3">
                  <Input
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="e.g. Logistics and warehousing company with delivery drivers"
                    maxLength={500}
                    className="flex-1"
                  />
                  <Button
                    onClick={handleAiGenerate}
                    disabled={aiGenerating}
                  >
                    {aiGenerating ? "Generating..." : "Generate"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Template details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="templateName">Name</Label>
                <Input
                  id="templateName"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Logistics / Warehousing"
                  maxLength={100}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="templateDesc">Description</Label>
                <Input
                  id="templateDesc"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="e.g. Delivery companies, fulfillment centers, supply chain"
                  maxLength={200}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Departments ({formDepartments.length})
                </CardTitle>
                <Button variant="outline" size="sm" onClick={addDepartment}>
                  Add department
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {formDepartments.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No departments yet. Add at least one.
                </p>
              )}
              {formDepartments.map((dept, i) => (
                <div key={i} className="flex gap-3 items-start">
                  <input
                    type="color"
                    value={dept.color}
                    onChange={(e) => updateDepartment(i, "color", e.target.value)}
                    className="w-8 h-8 rounded border cursor-pointer mt-1"
                  />
                  <div className="flex-1 space-y-2">
                    <Input
                      value={dept.name}
                      onChange={(e) => updateDepartment(i, "name", e.target.value)}
                      placeholder="Department name"
                    />
                    <Input
                      value={dept.description}
                      onChange={(e) => updateDepartment(i, "description", e.target.value)}
                      placeholder="Brief description"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs mt-1"
                    onClick={() => removeDepartment(i)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Work rules ({formWorkRules.length})
                </CardTitle>
                <Button variant="outline" size="sm" onClick={addWorkRule}>
                  Add rule
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {formWorkRules.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No work rules. These are optional.
                </p>
              )}
              {formWorkRules.map((rule, i) => (
                <div key={i} className="border rounded-lg p-3 space-y-3">
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-2">
                      <Input
                        value={rule.name}
                        onChange={(e) => updateWorkRule(i, "name", e.target.value)}
                        placeholder="Rule name"
                      />
                    </div>
                    <select
                      className="rounded-md border px-3 py-2 text-sm bg-background w-48"
                      value={rule.type}
                      onChange={(e) => updateWorkRule(i, "type", e.target.value)}
                    >
                      {WORK_RULE_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => removeWorkRule(i)}
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {rule.type === "break_interval" && (
                      <>
                        <div className="space-y-1">
                          <Label className="text-xs">Hours before break</Label>
                          <Input
                            type="number"
                            min={1}
                            max={24}
                            value={rule.hoursThreshold || ""}
                            onChange={(e) => updateWorkRule(i, "hoursThreshold", Number(e.target.value))}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Break duration (hrs)</Label>
                          <Input
                            type="number"
                            min={0.5}
                            max={8}
                            step={0.5}
                            value={rule.breakHours || ""}
                            onChange={(e) => updateWorkRule(i, "breakHours", Number(e.target.value))}
                          />
                        </div>
                      </>
                    )}
                    {(rule.type === "max_hours_daily" || rule.type === "max_hours_weekly") && (
                      <div className="space-y-1">
                        <Label className="text-xs">Max hours</Label>
                        <Input
                          type="number"
                          min={1}
                          max={168}
                          value={rule.maxHours || ""}
                          onChange={(e) => updateWorkRule(i, "maxHours", Number(e.target.value))}
                        />
                      </div>
                    )}
                  </div>
                  <Input
                    value={rule.reason}
                    onChange={(e) => updateWorkRule(i, "reason", e.target.value)}
                    placeholder="Reason for this rule"
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Certifications ({formCertifications.length})
                </CardTitle>
                <Button variant="outline" size="sm" onClick={addCertification}>
                  Add certification
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {formCertifications.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No certifications. These are optional.
                </p>
              )}
              {formCertifications.map((cert, i) => (
                <div key={i} className="flex gap-3">
                  <Input
                    value={cert}
                    onChange={(e) => updateCertification(i, e.target.value)}
                    placeholder="e.g. Food Safety Level 2"
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => removeCertification(i)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="flex justify-end gap-3 mb-8">
            <Button variant="outline" onClick={cancelForm}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={formSaving}>
              {formSaving
                ? "Saving..."
                : viewMode === "create"
                  ? "Create template"
                  : "Save changes"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}