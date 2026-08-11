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
 * ## What is deliberately not here
 *
 * Invoices, payment methods and cancellation. They are one button away in
 * Stripe's hosted portal, because owning them would mean storing copies of
 * amounts we did not calculate, and editing a card would mean the number
 * passing through this application.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  ArrowUpRight,
  CreditCard,
  ExternalLink,
  Lock,
  TriangleAlert,
} from "lucide-react";
import { PageLoading } from "@/components/ui/page-loading";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertBanner } from "@/components/ui/alert-banner";
import { StatTile, STAT_ACCENT } from "@/components/ui/stat-tile";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { usePermissions } from "@/components/layout/permission-provider";
import { TIER_CONFIG } from "@/lib/subscription-tiers";

interface Overview {
  tier: string;
  status: string | null;
  needsAttention: boolean;
  interval: string | null;
  currentPeriodEnd: string | null;
  hasStripeCustomer: boolean;
  hasStripeSubscription: boolean;
  usage: {
    resources: Record<
      string,
      { current: number; limit: number | null; percentage: number }
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
  past_due: "A payment failed. Stripe will retry — update your card to avoid losing Pro features.",
  unpaid: "Payments have failed repeatedly and have stopped being retried. Update your card to restore Pro features.",
  incomplete: "Checkout was started but never finished authorising. Nothing has been charged.",
  canceled: "This subscription has ended. You are on the Free plan.",
  active: "Everything is up to date.",
  trialing: "You are in a trial period.",
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
  const [opening, setOpening] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [interval, setInterval] = useState<"month" | "year">("month");
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
    setUpgrading(true);
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
        window.location.href = body.url;
        return;
      }
      setError(body.error || "Could not start checkout");
    } catch {
      setError("Could not start checkout");
    } finally {
      setUpgrading(false);
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
        setError(body?.error || "Could not open the billing portal");
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

  const config = data ? TIER_CONFIG[data.tier as keyof typeof TIER_CONFIG] : null;
  const renews = data?.currentPeriodEnd
    ? new Date(data.currentPeriodEnd).toLocaleDateString([], {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <div className="w-full">
      <div className="mb-4">
        <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Billing</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Your plan, and what it includes. Invoices and payment details are held
          by Stripe.
        </p>
      </div>

      {error && <AlertBanner message={error} variant="error" />}

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
          message="Payment received — your plan will update to Pro momentarily. Refresh if it hasn't updated."
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
            <p className="text-[13px] font-medium text-amber-900 dark:text-amber-200">
              There is a problem with your payments
            </p>
            <p className="mt-0.5 text-[12px] text-amber-800 dark:text-amber-300">
              {STATUS_MEANING[data.status] ?? `Stripe reports: ${data.status}.`}
            </p>
          </div>
        </div>
      )}

      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            <StatTile
              label="Plan"
              value={config?.displayName ?? data.tier}
              detail={config?.tagline ?? ""}
              accentColour={STAT_ACCENT.indigo}
            />
            <StatTile
              label="Billed"
              value={data.interval === "year" ? "Yearly" : data.interval === "month" ? "Monthly" : "—"}
              detail={data.interval ? "per organisation" : "no paid subscription"}
              accentColour={STAT_ACCENT.blue}
            />
            <StatTile
              label={data.status === "canceled" ? "Access until" : "Renews"}
              value={renews ?? "—"}
              detail={renews ? "" : "nothing scheduled"}
              accentColour={STAT_ACCENT.slate}
            />
            <StatTile
              label="Status"
              value={data.status ?? "free"}
              detail={data.needsAttention ? "needs attention" : "no action needed"}
              accentColour={data.needsAttention ? STAT_ACCENT.amber : STAT_ACCENT.green}
              valueColour={
                data.needsAttention ? "text-amber-600 dark:text-amber-400" : ""
              }
            />
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Invoices and payment</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  Receipts, card details and cancellation are managed by Stripe.
                  {!data.hasStripeSubscription &&
                    " Your Pro access is active, but its billing details are not linked to Stripe yet."}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {data.hasStripeSubscription ? (
                  <button
                    type="button"
                    onClick={openPortal}
                    disabled={opening}
                    className={SECONDARY_BUTTON}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    {opening ? "Opening…" : "Manage or cancel plan"}
                  </button>
                ) : (
                  <span className="text-[12px] text-muted-foreground">
                    Billing setup pending
                  </span>
                )}
              </div>
            </div>
          </div>

          {/*
            The upgrade card, moved here from Settings.

            It lived on a page called Settings while this page was called
            Billing, so Billing could report a plan and not change it — and the
            only button it had sent the reader somewhere else. A page named
            after the money has to be where the money happens.

            Checkout is only for Free organisations. A customer who is already
            on Pro must not be offered a second Pro subscription.
          */}
          {data.tier === "free" && !data.hasStripeSubscription && (
            <div className="mt-4 rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">Upgrade to Pro</p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {TIER_CONFIG.pro.tagline}
                  </p>
                </div>
                <p className="shrink-0 text-lg font-bold">
                  $
                  {interval === "year"
                    ? TIER_CONFIG.pro.yearlyPrice
                    : TIER_CONFIG.pro.monthlyPrice}
                  <span className="text-xs font-normal text-muted-foreground">
                    /{interval === "year" ? "yr" : "mo"}
                  </span>
                </p>
              </div>

              <div className="mt-3 flex items-center gap-2 text-[13px]">
                <span className="text-muted-foreground">Billed:</span>
                <div className="inline-flex rounded-lg border border-border p-0.5">
                  {(["month", "year"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setInterval(option)}
                      aria-pressed={interval === option}
                      className={`rounded px-3 py-1 text-xs transition-colors ${
                        interval === option
                          ? "bg-indigo-600 text-white"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {option === "month" ? "Monthly" : "Annual"}
                      {option === "year" && (
                        <span className="ml-1 text-[10px] opacity-80">
                          (2 months free)
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() => startCheckout("pro")}
                disabled={upgrading}
                className={`${PRIMARY_BUTTON} mt-3`}
              >
                <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
                {upgrading ? "Redirecting…" : "Upgrade to Pro"}
              </button>
            </div>
          )}

          {data.tier === "pro" && (
            <div className="mt-4 flex flex-col gap-4 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900 dark:bg-indigo-950/30 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">Ready for Enterprise?</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {data.hasStripeSubscription
                    ? "Switch plans from your Stripe billing portal without creating a second subscription."
                    : "Get unlimited limits, audit logs and priority support for $79 per month."}
                </p>
              </div>
              <button
                type="button"
                onClick={
                  data.hasStripeSubscription
                    ? openPortal
                    : () => startCheckout("enterprise")
                }
                disabled={upgrading || opening}
                className={`${PRIMARY_BUTTON} shrink-0`}
              >
                {upgrading || opening
                  ? "Redirecting…"
                  : data.hasStripeSubscription
                    ? "Upgrade in Stripe"
                    : "Upgrade to Enterprise"}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="mt-4 rounded-xl border border-border bg-card p-4">
            <p className="text-[13px] font-medium">What you are using</p>
            <div className="mt-3 space-y-2">
              {Object.entries(data.usage.resources).map(([name, use]) => (
                <div key={name} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-[12px] capitalize text-muted-foreground">
                    {name.replace(/_/g, " ")}
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${
                        use.percentage >= 100 ? "bg-amber-500" : "bg-indigo-500"
                      }`}
                      style={{ width: `${Math.min(100, use.percentage)}%` }}
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
                    className={`w-32 shrink-0 text-right text-[12px] ${
                      use.limit !== null && use.current >= use.limit
                        ? "font-medium text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground"
                    }`}
                  >
                    {use.current} of {use.limit ?? "∞"}
                    {use.limit !== null && use.current >= use.limit
                      ? " — limit reached"
                      : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
