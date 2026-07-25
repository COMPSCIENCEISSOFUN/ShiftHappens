/**
 * Onboarding Page (Boundary Layer)
 *
 * Two-step onboarding flow:
 * Step 1: Choose an industry template (or generate custom with AI)
 * Step 2: Enter organization details and create
 *
 * Templates are fetched from the database via API.
 * Custom template option allows AI-generated setup from a business
 * description, or manual blank start.
 */
"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageLoading } from "@/components/ui/page-loading";
import {
  UtensilsCrossed,
  HeartPulse,
  ShoppingCart,
  HardHat,
  Server,
  Sparkles,
  ArrowLeft,
  ArrowRight,
  Check,
  ShieldCheck,
  Award,
  Building,
  CreditCard,
} from "lucide-react";
import type { CustomTemplateData } from "@/lib/industry-templates";
import { TIER_CONFIG } from "@/lib/subscription-tiers";

const CUSTOM_TEMPLATE_ID = "custom";

// ─── Icon mapping ─────────────────────────────────────────────────────────
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  UtensilsCrossed,
  HeartPulse,
  ShoppingCart,
  HardHat,
  Server,
  Building,
};

// ─── Types ────────────────────────────────────────────────────────────────
interface DatabaseTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  departments: { name: string; description: string; color: string }[];
  workRules: { name: string; type: string; hoursThreshold?: number | null; breakHours?: number | null; maxHours?: number | null; reason: string }[];
  certifications: string[];
  isActive: boolean;
}

interface TemplatePreview {
  departments: { name: string; description: string; color: string }[];
  workRules: { name: string; type: string; hoursThreshold?: number | null; breakHours?: number | null; maxHours?: number | null; reason: string }[];
  certifications: string[];
}

// ─── Template Preview Panel ───────────────────────────────────────────────
function PreviewPanel({ template, title }: { template: TemplatePreview; title: string }) {
  function formatRule(rule: TemplatePreview["workRules"][0]): string {
    if (rule.type === "break_interval") {
      return `Break every ${rule.hoursThreshold}h — ${rule.breakHours}h minimum`;
    }
    if (rule.type === "max_hours_daily") {
      return `Max ${rule.maxHours}h per day`;
    }
    if (rule.type === "max_hours_weekly") {
      return `Max ${rule.maxHours}h per week`;
    }
    return rule.name;
  }
  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
      <p className="text-sm font-medium">{title} — template preview</p>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
          Departments
        </p>
        <div className="flex flex-wrap gap-2">
          {template.departments.map((d) => (
            <span
              key={d.name}
              className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: d.color }}
              />
              {d.name}
            </span>
          ))}
        </div>
        <div className="mt-2 space-y-1">
          {template.departments.map((d) => (
            <p key={d.name} className="text-xs text-muted-foreground">
              {d.description}
            </p>
          ))}
        </div>
      </div>
      {template.workRules.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Work rules
          </p>
          <div className="space-y-2">
            {template.workRules.map((r) => (
              <div key={r.name} className="flex items-start gap-2 text-xs">
                <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">{formatRule(r)}</p>
                  <p className="text-muted-foreground">{r.reason}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {template.certifications.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Suggested certifications
          </p>
          <div className="flex flex-wrap gap-2">
            {template.certifications.map((c) => (
              <span
                key={c}
                className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs"
              >
                <Award className="h-3 w-3 text-muted-foreground" />
                {c}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────
export default function OnboardingPage() {
  const router = useRouter();

  // Templates from database
  const [templates, setTemplates] = useState<DatabaseTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);

  // Step management
  const [step, setStep] = useState<"template" | "details">("template");

  // Template selection
  const [selectedId, setSelectedId] = useState<string>("");
  const [customTemplate, setCustomTemplate] = useState<CustomTemplateData | null>(null);
  const [skipTemplate, setSkipTemplate] = useState(false);

  // AI generation
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Org creation
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Plan selection (paid plans go through Stripe checkout after org creation)
  const [plan, setPlan] = useState<"free" | "pro">("free");
  const [interval, setInterval] = useState<"month" | "year">("month");

  // Fetch templates on mount
  useEffect(() => {
    async function fetchTemplates() {
      try {
        const res = await fetch("/api/platform/templates");
        if (res.ok) {
          const data = await res.json();
          setTemplates(data);
          // Auto-select first template
          if (data.length > 0) {
            setSelectedId(data[0].id);
          }
        }
      } catch {
        // Non-critical — user can still use custom or blank
      } finally {
        setTemplatesLoading(false);
      }
    }
    fetchTemplates();
  }, []);

  // Local template lookup
  function findTemplate(id: string): DatabaseTemplate | undefined {
    return templates.find((t) => t.id === id);
  }

  // Get current preview data
  function getPreview(): TemplatePreview | null {
    if (selectedId === CUSTOM_TEMPLATE_ID) {
      return customTemplate;
    }
    return findTemplate(selectedId) || null;
  }

  // Get template name for preview title
  function getPreviewTitle(): string {
    if (selectedId === CUSTOM_TEMPLATE_ID) return "Custom";
    return findTemplate(selectedId)?.name || "Template";
  }

  // AI template generation
  async function generateTemplate() {
    if (aiInput.length < 20) {
      setAiError("Please describe your business in at least 20 characters");
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      const response = await fetch("/api/organizations/generate-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: aiInput }),
      });
      const result = await response.json();
      if (!response.ok) {
        setAiError(result.error || "Failed to generate template");
        return;
      }
      setCustomTemplate(result as CustomTemplateData);
      setSkipTemplate(false);
    } catch {
      setAiError("Something went wrong. Try again or use a preset template.");
    } finally {
      setAiLoading(false);
    }
  }

  // Organization creation
  async function createOrganization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setCreating(true);
    const formData = new FormData(event.currentTarget);
    const name = formData.get("name") as string;
    const industry = formData.get("industry") as string;
    const description = formData.get("description") as string;
    try {
      const body: Record<string, unknown> = { name, industry, description };
      if (!skipTemplate) {
        if (selectedId === CUSTOM_TEMPLATE_ID && customTemplate) {
          body.customTemplate = customTemplate;
        } else if (selectedId !== CUSTOM_TEMPLATE_ID) {
          body.templateId = selectedId;
        }
      }
      const response = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || "Failed to create organization");
        return;
      }

      // Paid plan: hand off to Stripe Checkout. The org is created on the free
      // tier and only upgraded once Stripe confirms payment (via webhook).
      if (plan === "pro") {
        const checkoutRes = await fetch(
          `/api/organizations/${result.id}/checkout`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ interval, source: "onboarding" }),
          }
        );
        const checkout = await checkoutRes.json();

        if (checkoutRes.ok && checkout.url) {
          window.location.href = checkout.url;
          return;
        }

        // Checkout couldn't start — the org still exists on Free, so continue
        // into the app rather than blocking the user.
        setError(
          (checkout.error || "Couldn't start checkout") +
            " — your workspace was created on the Free plan. You can upgrade later in Settings."
        );
        setCreating(false);
        setTimeout(() => {
          router.push("/dashboard");
          router.refresh();
        }, 2500);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setCreating(false);
    }
  }

  // Get industry from selected template for pre-fill
  function getIndustryFromTemplate(): string {
    if (selectedId === CUSTOM_TEMPLATE_ID) return "";
    return findTemplate(selectedId)?.name || "";
  }

  // Get selected template data for step 2 summary
  function getSelectedTemplateData(): TemplatePreview | null {
    if (selectedId === CUSTOM_TEMPLATE_ID) return customTemplate;
    return findTemplate(selectedId) || null;
  }

  const preview = getPreview();

  return (
    <div className="flex min-h-[80vh] items-center justify-center py-8">
      <div className="w-full max-w-2xl px-4">
        {/* ─── Step 1: Template Selection ─────────────────────────── */}
        {step === "template" && (
          <Card>
            <CardHeader>
              <p className="text-xs text-muted-foreground mb-1">Step 1 of 2</p>
              <CardTitle>Choose your industry</CardTitle>
              <CardDescription>
                We&apos;ll set up departments and work rules to match. You can
                customize everything later.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {templatesLoading ? (
                <PageLoading label="Loading templates..." />
              ) : (
                <>
                  {/* Template grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {templates.map((template) => {
                      const IconComponent = ICON_MAP[template.icon] || Building;
                      const isSelected = selectedId === template.id;
                      return (
                        <button
                          key={template.id}
                          type="button"
                          onClick={() => {
                            setSelectedId(template.id);
                            setCustomTemplate(null);
                            setSkipTemplate(false);
                            setAiError(null);
                          }}
                          className={`rounded-lg border p-4 text-left transition-all ${
                            isSelected
                              ? "border-primary bg-primary/5 ring-1 ring-primary"
                              : "border-border hover:border-primary/50"
                          }`}
                        >
                          <IconComponent
                            className={`h-5 w-5 mb-2 ${
                              isSelected
                                ? "text-primary"
                                : "text-muted-foreground"
                            }`}
                          />
                          <p className="text-sm font-medium">{template.name}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {template.description}
                          </p>
                        </button>
                      );
                    })}
                    {/* Custom template card */}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(CUSTOM_TEMPLATE_ID);
                        setSkipTemplate(false);
                      }}
                      className={`rounded-lg border p-4 text-left transition-all ${
                        selectedId === CUSTOM_TEMPLATE_ID
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <Sparkles
                        className={`h-5 w-5 mb-2 ${
                          selectedId === CUSTOM_TEMPLATE_ID
                            ? "text-primary"
                            : "text-muted-foreground"
                        }`}
                      />
                      <p className="text-sm font-medium">Custom</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        AI-generated or blank start
                      </p>
                    </button>
                  </div>

                  {/* Custom template: AI input */}
                  {selectedId === CUSTOM_TEMPLATE_ID && !skipTemplate && (
                    <div className="space-y-3 rounded-lg border p-4">
                      <div>
                        <Label htmlFor="ai-description" className="text-sm">
                          Describe your business and let AI set things up
                        </Label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Include your industry, team size, and any specific
                          scheduling needs.
                        </p>
                      </div>
                      <textarea
                        id="ai-description"
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                        placeholder='e.g. "We run a boutique hotel with a restaurant, spa, and concierge service. 20 casual staff, open 7 days, busiest on weekends."'
                        value={aiInput}
                        onChange={(e) => setAiInput(e.target.value)}
                        maxLength={500}
                      />
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                          {aiInput.length}/500 characters
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          onClick={generateTemplate}
                          disabled={aiLoading || aiInput.length < 20}
                        >
                          {aiLoading ? (
                            "Generating..."
                          ) : (
                            <>
                              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                              Generate setup
                            </>
                          )}
                        </Button>
                      </div>
                      {aiError && (
                        <p className="text-xs text-red-600 dark:text-red-400">
                          {aiError}
                        </p>
                      )}
                      <div className="flex items-center gap-3">
                        <Separator className="flex-1" />
                        <span className="text-xs text-muted-foreground">or</span>
                        <Separator className="flex-1" />
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSkipTemplate(true);
                          setCustomTemplate(null);
                        }}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Skip to manual setup →
                      </button>
                    </div>
                  )}

                  {/* Blank start confirmation */}
                  {selectedId === CUSTOM_TEMPLATE_ID && skipTemplate && (
                    <div className="rounded-lg border border-dashed p-4 text-center">
                      <p className="text-sm text-muted-foreground">
                        No pre-configured setup. You&apos;ll create departments and
                        work rules after your organization is created.
                      </p>
                      <button
                        type="button"
                        onClick={() => setSkipTemplate(false)}
                        className="mt-2 text-xs text-primary hover:underline"
                      >
                        Back to AI generation
                      </button>
                    </div>
                  )}

                  {/* Template preview */}
                  {preview && selectedId !== CUSTOM_TEMPLATE_ID && (
                    <PreviewPanel template={preview} title={getPreviewTitle()} />
                  )}

                  {/* AI-generated custom preview */}
                  {selectedId === CUSTOM_TEMPLATE_ID && customTemplate && (
                    <PreviewPanel template={customTemplate} title="AI-generated" />
                  )}
                </>
              )}
            </CardContent>
            <CardFooter className="flex justify-end">
              <Button
                type="button"
                onClick={() => setStep("details")}
                disabled={templatesLoading}
              >
                Next
                <ArrowRight className="h-4 w-4 ml-1.5" />
              </Button>
            </CardFooter>
          </Card>
        )}

        {/* ─── Step 2: Organization Details ───────────────────────── */}
        {step === "details" && (
          <Card>
            <CardHeader>
              <p className="text-xs text-muted-foreground mb-1">Step 2 of 2</p>
              <CardTitle>Name your organization</CardTitle>
              <CardDescription>
                {selectedId !== CUSTOM_TEMPLATE_ID && !skipTemplate
                  ? `Using ${getPreviewTitle()} template — departments and rules will be created automatically.`
                  : customTemplate
                    ? "Using AI-generated template — departments and rules will be created automatically."
                    : "You'll configure departments and rules after creation."}
              </CardDescription>
            </CardHeader>
            <form onSubmit={createOrganization}>
              <CardContent className="space-y-4">
                {error && (
                  <AlertBanner message={error} variant="error" />
                )}
                <div className="space-y-2">
                  <Label htmlFor="name">Organization name</Label>
                  <Input
                    id="name"
                    name="name"
                    required
                    placeholder="e.g. Ocean Grill"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="industry">Industry</Label>
                  <Input
                    id="industry"
                    name="industry"
                    defaultValue={getIndustryFromTemplate()}
                    placeholder="e.g. Hospitality, Retail, Healthcare"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Input
                    id="description"
                    name="description"
                    placeholder="Brief description of your organization"
                  />
                </div>
                {/* Selected template summary */}
                {!skipTemplate && (selectedId !== CUSTOM_TEMPLATE_ID || customTemplate) && (
                  <div className="rounded-lg bg-muted/50 p-3">
                    <div className="flex items-center gap-2 text-sm">
                      <Check className="h-4 w-4 text-green-600" />
                      <span>
                        Template will create{" "}
                        <span className="font-medium">
                          {getSelectedTemplateData()?.departments.length || 0} departments
                        </span>
                        {" "}and{" "}
                        <span className="font-medium">
                          {getSelectedTemplateData()?.workRules.length || 0} work rules
                        </span>
                      </span>
                    </div>
                  </div>
                )}

                <Separator />

                {/* ─── Plan selection ─────────────────────────────── */}
                <div className="space-y-3">
                  <div>
                    <p className="text-base font-medium">Choose a plan</p>
                    <p className="text-sm text-muted-foreground">
                      Start free, or unlock more with Pro. You can change this
                      anytime in Settings.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {/* Free */}
                    <button
                      type="button"
                      onClick={() => setPlan("free")}
                      className={`rounded-lg border p-4 text-left transition-all ${
                        plan === "free"
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <p className="text-sm font-medium">
                        {TIER_CONFIG.free.displayName}
                      </p>
                      <p className="text-lg font-bold">$0</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {TIER_CONFIG.free.tagline}
                      </p>
                    </button>

                    {/* Pro */}
                    <button
                      type="button"
                      onClick={() => setPlan("pro")}
                      className={`rounded-lg border p-4 text-left transition-all ${
                        plan === "pro"
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <p className="text-sm font-medium">
                        {TIER_CONFIG.pro.displayName}
                      </p>
                      <p className="text-lg font-bold">
                        $
                        {interval === "year"
                          ? TIER_CONFIG.pro.yearlyPrice
                          : TIER_CONFIG.pro.monthlyPrice}
                        <span className="text-xs font-normal text-muted-foreground">
                          /{interval === "year" ? "yr" : "mo"}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {TIER_CONFIG.pro.tagline}
                      </p>
                    </button>
                  </div>

                  {/* Billing interval toggle (Pro only) */}
                  {plan === "pro" && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Billing:</span>
                      <div className="inline-flex rounded-md border p-0.5">
                        <button
                          type="button"
                          onClick={() => setInterval("month")}
                          className={`rounded px-3 py-1 text-xs transition-colors ${
                            interval === "month"
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          Monthly
                        </button>
                        <button
                          type="button"
                          onClick={() => setInterval("year")}
                          className={`rounded px-3 py-1 text-xs transition-colors ${
                            interval === "year"
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          Annual
                          <span className="ml-1 text-[10px] opacity-80">
                            (2 months free)
                          </span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
              <CardFooter className="flex justify-between">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep("template")}
                >
                  <ArrowLeft className="h-4 w-4 mr-1.5" />
                  Back
                </Button>
                <Button type="submit" disabled={creating}>
                  {creating ? (
                    "Creating..."
                  ) : plan === "pro" ? (
                    <>
                      <CreditCard className="h-4 w-4 mr-1.5" />
                      Continue to payment
                    </>
                  ) : (
                    "Create organization"
                  )}
                </Button>
              </CardFooter>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}