/**
 * Billing (Boundary Layer).
 *
 * ## Why this is a page and not a section of Settings
 *
 * It was a section of Settings, and Settings is three thousand lines. The thing
 * this page exists to show — that a payment has failed — cannot live where
 * people scroll past it.
 *
 * ## The defect it surfaces
 *
 * `subscriptionStatus` has been written by the Stripe webhook since billing was
 * wired up and read by nothing. An organisation whose card failed sat at
 * `past_due` in the database with nobody told, keeping full access until Stripe
 * gave up and the tier silently dropped to Free. This screen is the first
 * reader that column has ever had.
 *
 * ## Why the plans are shown here rather than linked to
 *
 * The upgrade used to be a single line of text naming one plan and a price
 * typed into the markup. It said what the next plan COST and never what it
 * DID, so the only way to find out was to buy it — and the typed price went
 * stale the first time the real one moved. The comparison below is built from
 * `TIER_CONFIG`, so it cannot disagree with what checkout charges.
 *
 * ## What is deliberately still not here
 *
 * Invoices and payment methods. They are one button away in Stripe's hosted
 * portal, because owning them would mean storing copies of amounts we did not
 * calculate, and editing a card would mean the number passing through this
 * application. Cancellation moved IN — see `cancel-plan-dialog`.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  CreditCard,
  ExternalLink,
  Lock,
  Minus,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { PageLoading } from "@/components/ui/page-loading";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertBanner } from "@/components/ui/alert-banner";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import {
  DANGER_GHOST_BUTTON,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "@/components/ui/button-styles";
import { CancelPlanDialog } from "@/components/billing/cancel-plan-dialog";
import { usePermissions } from "@/components/layout/permission-provider";
import { apiErrorMessage } from "@/lib/api-error";
import {
  PRICING_FEATURES,
  SUBSCRIPTION_TIERS,
  TIER_CONFIG,
  formatLimit,
  type SubscriptionTier,
} from "@/lib/subscription-tiers";

interface Overview {
  tier: string;
  status: string | null;
  needsAttention: boolean;
  interval: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasStripeCustomer: boolean;
  hasStripeSubscription: boolean;
  usage: {
    resources: Record<
      string,
      { current: number; limit: number | null; percentage: number | null }
    >;
  };
}

/**
 * What a Stripe status means to somebody who did not choose the word.
 *
 * `past_due` and `unpaid` are the same failure at different stages, and the
 * difference matters: one is still retrying, the other has given up. Collapsing
 * them would lose "fix your card" versus "your access is ending".
 */
const STATUS_MEANING: Record<string, string> = {
  past_due:
    "A payment failed. Stripe will retry — update your card to avoid losing your plan.",
  unpaid:
    "Payments have failed repeatedly and have stopped being retried. Update your card to restore your plan.",
  incomplete:
    "Checkout was started but never finished authorising. Nothing has been charged.",
  canceled: "This subscription has ended. You are on the Free plan.",
  active: "Everything is up to date.",
  trialing: "You are in a trial period.",
};

const RESOURCE_LABEL: Record<string, string> = {
  members: "Team members",
  active_tasks: "Active tasks",
  departments: "Departments",
  work_rules: "Work rules",
  custom_roles: "Custom roles",
  projects: "Projects",
};

const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  pro: 1,
  enterprise: 2,
};

export default function BillingPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const { can } = usePermissions();
  const mayManage = can("billing:manage");

  const [data, setData] = useState<Overview | null>(null);
  // Starts false for somebody who cannot manage billing, rather than being
  // switched off inside the effect — a synchronous setState for a value that
  // was knowable before the first render.
  const [loading, setLoading] = useState(mayManage);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [working, setWorking] = useState(false);
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [showCancel, setShowCancel] = useState(false);
  const [checkoutBanner, setCheckoutBanner] = useState<
    "success" | "canceled" | null
  >(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/billing`);
      const body = await res.json();
      if (!res.ok || typeof body?.tier !== "string") {
        setError(
          typeof body?.error === "string" ? body.error : "Failed to load billing"
        );
        return;
      }
      setData(body);
      setError(null);
    } catch {
      setError("Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    if (!mayManage) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: loads the billing overview on mount
    load();
  }, [mayManage, load]);

  /*
   * Stripe returns here with `?checkout=`, and this page is now the one that
   * reads it — the handler moved with the button that starts checkout. Those
   * two must travel together: a return URL pointing at a page without this
   * effect means somebody pays and nothing on screen acknowledges it.
   *
   * The parameter is cleared afterwards so a refresh does not re-announce a
   * payment made an hour ago.
   */
  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get("checkout");
    if (status === "success" || status === "canceled") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronising with an external system: reads the ?checkout= result Stripe put in the URL, then clears it
      setCheckoutBanner(status);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function startCheckout(plan: "pro" | "enterprise") {
    setWorking(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `source: "billing"` is what sends Stripe back to THIS page rather
        // than to Settings, where the banner used to live.
        body: JSON.stringify({ plan, interval, source: "billing" }),
      });
      const body = await res.json();
      if (res.ok && body.url) {
        // eslint-disable-next-line react-hooks/immutability -- navigating to Stripe's hosted checkout; assigning location.href is the navigation API, not a mutation of React state
        window.location.href = body.url;
        return;
      }
      setError(apiErrorMessage(body, "Could not start checkout"));
    } catch {
      setError("Could not start checkout");
    } finally {
      setWorking(false);
    }
  }

  /**
   * Move between paid plans on the existing subscription.
   *
   * Used for both directions. The tier is not set here — Stripe's webhook
   * applies it — so the page reloads rather than assuming, and the notice says
   * "shortly" for the same reason the checkout banner does.
   */
  async function changePlan(plan: "pro" | "enterprise") {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/billing/change-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(apiErrorMessage(body, "Could not change plan"));
        return;
      }
      setShowCancel(false);
      setNotice(
        `Switched to ${TIER_CONFIG[plan].displayName}. Any unused time on your old plan becomes credit. Your plan will update here shortly.`
      );
      await load();
    } catch {
      setError("Could not change plan");
    } finally {
      setWorking(false);
    }
  }

  async function cancelPlan() {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/billing/cancel`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(apiErrorMessage(body, "Could not cancel the plan"));
        return;
      }
      setShowCancel(false);
      setNotice(
        "Your plan is scheduled to end. You keep every feature until then, and you can undo this at any point before it."
      );
      await load();
    } catch {
      setError("Could not cancel the plan");
    } finally {
      setWorking(false);
    }
  }

  async function resumePlan() {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/billing/cancel`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(apiErrorMessage(body, "Could not resume the plan"));
        return;
      }
      setNotice("Your plan will continue as normal. Nothing has been lost.");
      await load();
    } catch {
      setError("Could not resume the plan");
    } finally {
      setWorking(false);
    }
  }

  async function openPortal() {
    setOpening(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/billing/portal`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok || typeof body?.url !== "string") {
        setError(apiErrorMessage(body, "Could not open the billing portal"));
        return;
      }
      // A full navigation, not a new tab: the portal returns the reader here
      // when they are done, and a popup would strand that return.
      window.location.href = body.url;
    } catch {
      setError("Could not open the billing portal");
    } finally {
      setOpening(false);
    }
  }

  if (!mayManage) {
    return (
      <div className="w-full">
        <EmptyState
          icon={Lock}
          title="Not available to you"
          description="Only people who can manage the subscription see billing."
        />
      </div>
    );
  }

  if (loading) return <PageLoading />;

  const tier = (data?.tier ?? "free") as SubscriptionTier;
  const config = TIER_CONFIG[tier];
  const periodDate = data?.currentPeriodEnd
    ? new Date(data.currentPeriodEnd).toLocaleDateString([], {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;
  const scheduledToEnd = data?.cancelAtPeriodEnd === true;

  return (
    <div className="w-full pb-10">
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Billing</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Your plan, and what it includes. Invoices and payment details are held
          by Stripe.
        </p>
      </div>

      {error && <AlertBanner message={error} variant="error" />}
      {notice && <AlertBanner message={notice} variant="success" />}

      {/*
        The post-checkout result, which arrives as a URL parameter because
        Stripe redirects rather than calling back into the page.

        "Momentarily" is doing real work in that first message: the tier is
        granted by the WEBHOOK, not by this redirect, so the plan genuinely may
        not have changed yet when the reader lands here. Claiming it had would
        send somebody to look for a feature that is thirty seconds away.
      */}
      {checkoutBanner === "success" && (
        <AlertBanner
          message="Payment received — your plan will update momentarily. Refresh if it hasn't updated."
          variant="success"
        />
      )}
      {checkoutBanner === "canceled" && (
        <AlertBanner
          message="Checkout canceled — no charge was made."
          variant="warning"
        />
      )}

      {/*
        The banner this page was built for. First, and unmissable: the whole
        defect was that a failed payment was visible to nobody.
      */}
      {data?.needsAttention && data.status && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950">
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              There is a problem with your payments
            </p>
            <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
              {STATUS_MEANING[data.status] ?? `Stripe reports: ${data.status}.`}
            </p>
          </div>
        </div>
      )}

      {/*
        A scheduled cancellation, with the way back.

        This is the window in which somebody changes their mind, and it is worth
        one button: without it the only route back is a fresh checkout, at
        whatever the price is by then.
      */}
      {scheduledToEnd && (
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <CalendarClock
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Your {config.displayName} plan ends
                {periodDate ? ` on ${periodDate}` : " at the end of this period"}
              </p>
              <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
                Nothing changes until then — every feature stays available.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={resumePlan}
            disabled={working}
            className={`${PRIMARY_BUTTON} shrink-0`}
          >
            {working ? "Working…" : "Keep my plan"}
          </button>
        </div>
      )}

      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            <StatTile
              label="Plan"
              value={config.displayName}
              detail={config.tagline}
              accentColour={STAT_ACCENT.indigo}
            />
            <StatTile
              label="Billed"
              value={
                data.interval === "year"
                  ? "Yearly"
                  : data.interval === "month"
                    ? "Monthly"
                    : "—"
              }
              detail={data.interval ? "per organisation" : "no paid subscription"}
              accentColour={STAT_ACCENT.blue}
            />
            <StatTile
              label={scheduledToEnd ? "Access until" : "Renews"}
              value={periodDate ?? "—"}
              detail={periodDate ? "" : "nothing scheduled"}
              accentColour={scheduledToEnd ? STAT_ACCENT.amber : STAT_ACCENT.slate}
            />
            <StatTile
              label="Status"
              value={data.status ?? "free"}
              detail={data.needsAttention ? "needs attention" : "no action needed"}
              accentColour={
                data.needsAttention ? STAT_ACCENT.amber : STAT_ACCENT.green
              }
              valueColour={
                data.needsAttention ? "text-amber-600 dark:text-amber-400" : ""
              }
            />
          </div>

          {/* ── Plan comparison ─────────────────────────────────────────── */}
          <section className="mt-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-base font-semibold">Plans</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Change or cancel at any time. Prices are per organisation.
                </p>
              </div>

              <div className="inline-flex shrink-0 rounded-lg border border-border p-0.5">
                {(["month", "year"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setInterval(option)}
                    aria-pressed={interval === option}
                    className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                      interval === option
                        ? "bg-indigo-600 text-white"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {option === "month" ? "Monthly" : "Annual"}
                    {option === "year" && (
                      <span className="ml-1 text-xs opacity-80">
                        2 months free
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {SUBSCRIPTION_TIERS.map((name) => {
                const plan = TIER_CONFIG[name];
                const isCurrent = name === tier;
                const isUpgrade = TIER_RANK[name] > TIER_RANK[tier];
                const price =
                  interval === "year" ? plan.yearlyPrice : plan.monthlyPrice;
                const saving =
                  plan.monthlyPrice && plan.yearlyPrice
                    ? plan.monthlyPrice * 12 - plan.yearlyPrice
                    : 0;

                return (
                  <div
                    key={name}
                    className={`relative flex flex-col rounded-xl border p-4 transition-shadow ${
                      isCurrent
                        ? "border-indigo-400 bg-indigo-50/50 shadow-sm ring-1 ring-indigo-400/30 dark:border-indigo-700 dark:bg-indigo-950/30"
                        : "border-border bg-card hover:shadow-md"
                    }`}
                  >
                    {isCurrent && (
                      <span className="absolute -top-2 left-4 rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">
                        Current plan
                      </span>
                    )}
                    {!isCurrent && name === "pro" && (
                      <span className="absolute -top-2 left-4 inline-flex items-center gap-1 rounded-full bg-foreground px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-background">
                        <Sparkles className="size-2.5" aria-hidden="true" />
                        Most popular
                      </span>
                    )}

                    <p className="mt-1 text-sm font-semibold">
                      {plan.displayName}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {plan.tagline}
                    </p>

                    <div className="mt-3 flex items-baseline gap-1">
                      <span className="text-2xl font-bold">${price ?? 0}</span>
                      {(price ?? 0) > 0 && (
                        <span className="text-xs text-muted-foreground">
                          /{interval === "year" ? "yr" : "mo"}
                        </span>
                      )}
                    </div>
                    {interval === "year" && saving > 0 && (
                      <p className="mt-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400">
                        Save ${saving} a year
                      </p>
                    )}

                    <div className="mt-3 space-y-1 border-t border-border/70 pt-3">
                      {(
                        Object.keys(plan.limits) as (keyof typeof plan.limits)[]
                      ).map((resource) => (
                        <div
                          key={resource}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-muted-foreground">
                            {RESOURCE_LABEL[resource] ?? resource}
                          </span>
                          <span className="font-medium tabular-nums">
                            {plan.limits[resource] === 0
                              ? "—"
                              : formatLimit(plan.limits[resource])}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="mt-3 flex-1 space-y-1 border-t border-border/70 pt-3">
                      {PRICING_FEATURES.filter((f) => f.category === "tools").map(
                        (feature) => {
                          const included = feature[name] === true;
                          return (
                            <div
                              key={feature.name}
                              className="flex items-center gap-1.5 text-xs"
                            >
                              {included ? (
                                <Check
                                  className="size-3 shrink-0 text-indigo-500"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Minus
                                  className="size-3 shrink-0 text-muted-foreground/40"
                                  aria-hidden="true"
                                />
                              )}
                              <span
                                className={
                                  included
                                    ? "text-foreground"
                                    : "text-muted-foreground/60"
                                }
                              >
                                {feature.name}
                              </span>
                            </div>
                          );
                        }
                      )}
                    </div>

                    {/*
                      One button per card, and which one depends on three things:
                      whether this IS the plan, whether Stripe has a subscription
                      to modify, and which direction the move is. An organisation
                      whose tier was set by hand has no subscription to change,
                      so it is sent to checkout rather than offered a switch that
                      would fail at Stripe.
                    */}
                    <div className="mt-4">
                      {isCurrent ? (
                        <span className="block rounded-lg border border-border bg-muted/40 py-1.5 text-center text-xs font-medium text-muted-foreground">
                          Your plan
                        </span>
                      ) : name === "free" ? (
                        data.hasStripeSubscription && !scheduledToEnd ? (
                          <button
                            type="button"
                            onClick={() => setShowCancel(true)}
                            disabled={working}
                            className={`${DANGER_GHOST_BUTTON} w-full justify-center`}
                          >
                            Cancel plan
                          </button>
                        ) : (
                          <span className="block py-1.5 text-center text-xs text-muted-foreground">
                            {scheduledToEnd ? "Scheduled" : "—"}
                          </span>
                        )
                      ) : data.hasStripeSubscription ? (
                        <button
                          type="button"
                          onClick={() => changePlan(name as "pro" | "enterprise")}
                          disabled={working}
                          className={`${
                            isUpgrade ? PRIMARY_BUTTON : SECONDARY_BUTTON
                          } w-full justify-center`}
                        >
                          {working
                            ? "Working…"
                            : isUpgrade
                              ? `Upgrade to ${plan.displayName}`
                              : `Switch to ${plan.displayName}`}
                          {isUpgrade && (
                            <ArrowUpRight className="size-3.5" aria-hidden="true" />
                          )}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            startCheckout(name as "pro" | "enterprise")
                          }
                          disabled={working}
                          className={`${
                            isUpgrade ? PRIMARY_BUTTON : SECONDARY_BUTTON
                          } w-full justify-center`}
                        >
                          <CreditCard className="size-3.5" aria-hidden="true" />
                          {working ? "Redirecting…" : `Get ${plan.displayName}`}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── Usage ───────────────────────────────────────────────────── */}
          <div className="mt-6 rounded-xl border border-border bg-card p-4">
            <p className="text-sm font-medium">What you are using</p>
            <div className="mt-3 space-y-2">
              {Object.entries(data.usage.resources).map(([name, use]) => {
                const unlimited = use.limit === null;
                const full = !unlimited && use.current >= (use.limit ?? 0);
                const percent = unlimited
                  ? 100
                  : Math.min(100, use.percentage ?? 0);

                return (
                  <div key={name} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-xs text-muted-foreground">
                      {RESOURCE_LABEL[name] ?? name.replace(/_/g, " ")}
                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${
                          unlimited
                            ? "bg-indigo-300/50"
                            : full
                              ? "bg-amber-500"
                              : "bg-indigo-500"
                        }`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    {/*
                      Plain text in the same words `LimitNotice` uses elsewhere,
                      not a StatusBadge. That component maps a known VALUE through
                      a palette — "limit reached" is not one of its values, so it
                      would have rendered through a fallback style and quietly
                      looked like a different thing on every page.
                    */}
                    <span
                      className={`w-36 shrink-0 text-right text-xs tabular-nums ${
                        full
                          ? "font-medium text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground"
                      }`}
                    >
                      {use.current} of {use.limit ?? "∞"}
                      {full ? " — limit reached" : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Invoices, and the way out ───────────────────────────────── */}
          <div className="mt-4 rounded-xl border border-border bg-card p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">Invoices and payment</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Receipts and card details are managed by Stripe.
                  {!data.hasStripeSubscription &&
                    tier !== "free" &&
                    " Your access is active, but its billing details are not linked to Stripe yet."}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {data.hasStripeCustomer && (
                  <button
                    type="button"
                    onClick={openPortal}
                    disabled={opening}
                    className={SECONDARY_BUTTON}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    {opening ? "Opening…" : "Invoices in Stripe"}
                  </button>
                )}
                {data.hasStripeSubscription && !scheduledToEnd && (
                  <button
                    type="button"
                    onClick={() => setShowCancel(true)}
                    disabled={working}
                    className={DANGER_GHOST_BUTTON}
                  >
                    Cancel plan
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <CancelPlanDialog
        open={showCancel}
        tier={tier}
        accessUntil={periodDate}
        busy={working}
        onKeep={() => setShowCancel(false)}
        // Only Enterprise has a cheaper paid plan to be offered. On Pro the
        // step down IS Free, which is what cancelling already does.
        onDowngrade={tier === "enterprise" ? () => changePlan("pro") : undefined}
        onCancelPlan={cancelPlan}
      />
    </div>
  );
}
