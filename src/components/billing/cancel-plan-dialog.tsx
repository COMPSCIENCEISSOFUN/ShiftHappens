/**
 * The moment somebody decides to leave.
 *
 * ## Why this is not `ConfirmDialog`
 *
 * That component asks one question and offers two answers. This screen has a
 * third, and the third is the whole point: an organisation on Enterprise that
 * finds it more than they need should be offered the smaller plan before the
 * exit, not after. "Are you sure?" with a yes and a no turns every "this is too
 * expensive" into a cancellation, when a good share of them are a downgrade.
 *
 * ## Why it lists what is lost, by name
 *
 * A cancellation confirmation that says "this cannot be undone" tells the
 * reader nothing they did not already know. Naming the audit log, the custom
 * roles and the member cap they are about to drop to is the only version of
 * this dialog that lets somebody discover they were about to cancel the thing
 * they actually use — and it is read by people who did not set the plan up.
 *
 * ## Why "Keep my plan" is the primary button
 *
 * The destructive action is deliberately the quietest control here. Cancelling
 * is one click away in Stripe's own portal if that is genuinely what they want;
 * this dialog exists to make sure it is.
 */
"use client";

import { useEffect, useRef } from "react";
import { ArrowDownRight, Check, TriangleAlert, X } from "lucide-react";
import {
  TIER_CONFIG,
  formatLimit,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";
import {
  DANGER_GHOST_BUTTON,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "@/components/ui/button-styles";

/** Human labels for the resources whose caps change on the way down. */
const RESOURCE_LABEL: Record<string, string> = {
  members: "Team members",
  active_tasks: "Active tasks",
  departments: "Departments",
  work_rules: "Work rules",
  custom_roles: "Custom roles",
  projects: "Projects",
};

const FEATURE_LABEL: Record<string, string> = {
  custom_roles: "Custom roles (RBAC)",
  pdf_export: "PDF report export",
  mass_import: "Mass import (Excel)",
  audit_log: "Audit log",
  priority_support: "Priority support",
  assistant: "AI assistant",
  calendar_sync: "Calendar sync",
};

export function CancelPlanDialog({
  open,
  tier,
  accessUntil,
  busy,
  onKeep,
  onDowngrade,
  onCancelPlan,
}: {
  open: boolean;
  /** The plan being left. */
  tier: SubscriptionTier;
  /** Formatted date access runs to, or null if not known yet. */
  accessUntil: string | null;
  busy: boolean;
  onKeep: () => void;
  /** Absent when there is no cheaper paid plan to step down to. */
  onDowngrade?: () => void;
  onCancelPlan: () => void;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) keepRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onKeep();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onKeep]);

  if (!open) return null;

  const current = TIER_CONFIG[tier];
  const free = TIER_CONFIG.free;

  // Only what actually changes. A row saying "Departments: 2 → 2" is noise
  // that makes the rows which DID change harder to find.
  const losingLimits = (
    Object.keys(current.limits) as (keyof typeof current.limits)[]
  ).filter((resource) => current.limits[resource] !== free.limits[resource]);

  const losingFeatures = current.gatedFeatures;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={busy ? undefined : onKeep}
        aria-hidden
      />

      <div
        role="alertdialog"
        aria-labelledby="cancel-plan-title"
        aria-describedby="cancel-plan-desc"
        className="relative z-10 my-8 w-full max-w-lg rounded-2xl bg-card text-card-foreground shadow-2xl ring-1 ring-foreground/10"
      >
        <div className="flex items-start gap-3 border-b border-border p-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950">
            <TriangleAlert className="size-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="cancel-plan-title" className="text-base font-semibold">
              Cancel your {current.displayName} plan?
            </h2>
            <p
              id="cancel-plan-desc"
              className="mt-1 text-[13px] leading-relaxed text-muted-foreground"
            >
              {accessUntil
                ? `You keep ${current.displayName} until ${accessUntil} — you have already paid for that time. After it, this organisation moves to Free.`
                : `Your plan runs to the end of the period you have paid for. After it, this organisation moves to Free.`}
            </p>
          </div>
        </div>

        <div className="max-h-[45vh] overflow-y-auto p-5">
          <p className="text-[13px] font-medium">What Free does not include</p>

          <div className="mt-3 space-y-1.5">
            {losingFeatures.map((feature) => (
              <div key={feature} className="flex items-center gap-2 text-[13px]">
                <X className="size-3.5 shrink-0 text-red-500" aria-hidden="true" />
                <span className="text-muted-foreground">
                  {FEATURE_LABEL[feature] ?? feature.replace(/_/g, " ")}
                </span>
              </div>
            ))}
          </div>

          {losingLimits.length > 0 && (
            <>
              <p className="mt-4 text-[13px] font-medium">
                Limits that come down
              </p>
              <div className="mt-3 space-y-1.5">
                {losingLimits.map((resource) => (
                  <div
                    key={resource}
                    className="flex items-center justify-between gap-3 text-[13px]"
                  >
                    <span className="text-muted-foreground">
                      {RESOURCE_LABEL[resource] ?? resource.replace(/_/g, " ")}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      <span className="text-muted-foreground line-through">
                        {formatLimit(current.limits[resource])}
                      </span>
                      <span className="mx-1.5 text-muted-foreground">→</span>
                      <span className="font-medium text-amber-600 dark:text-amber-400">
                        {free.limits[resource] === 0
                          ? "None"
                          : formatLimit(free.limits[resource])}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/*
            The alternative, offered before the exit rather than after it.
            Shown only when there IS a cheaper paid plan — on Pro this whole
            block is absent, because "downgrade to Free" is what the button
            below already does and offering it twice reads as a dark pattern.
          */}
          {onDowngrade && (
            <div className="mt-5 rounded-xl border border-indigo-200 bg-indigo-50/70 p-4 dark:border-indigo-900 dark:bg-indigo-950/40">
              <div className="flex items-start gap-2">
                <ArrowDownRight
                  className="mt-0.5 size-4 shrink-0 text-indigo-600 dark:text-indigo-400"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold">
                    Too much? Move to Pro instead — ${TIER_CONFIG.pro.monthlyPrice}
                    /mo
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                    Keeps everything except priority support, and the unused part
                    of what you have paid becomes credit against it. You save $
                    {(current.monthlyPrice ?? 0) -
                      (TIER_CONFIG.pro.monthlyPrice ?? 0)}{" "}
                    a month without losing your work.
                  </p>
                  <div className="mt-2 space-y-1">
                    {TIER_CONFIG.pro.gatedFeatures.slice(0, 3).map((feature) => (
                      <div
                        key={feature}
                        className="flex items-center gap-1.5 text-[12px]"
                      >
                        <Check
                          className="size-3 shrink-0 text-indigo-600 dark:text-indigo-400"
                          aria-hidden="true"
                        />
                        <span className="text-muted-foreground">
                          {FEATURE_LABEL[feature] ?? feature}
                        </span>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={onDowngrade}
                    disabled={busy}
                    className={`${PRIMARY_BUTTON} mt-3`}
                  >
                    {busy ? "Switching…" : "Switch to Pro"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border p-5 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={onCancelPlan}
            disabled={busy}
            className={DANGER_GHOST_BUTTON}
          >
            {busy ? "Working…" : "Cancel my plan"}
          </button>
          <button
            ref={keepRef}
            type="button"
            onClick={onKeep}
            disabled={busy}
            className={onDowngrade ? SECONDARY_BUTTON : PRIMARY_BUTTON}
          >
            Keep my {current.displayName} plan
          </button>
        </div>
      </div>
    </div>
  );
}
