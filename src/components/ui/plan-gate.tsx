/**
 * What a plan-locked screen and a full resource look like.
 *
 */
"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { getTierConfig, type GatedFeature } from "@/lib/subscription-tiers";
import { usePlan } from "@/components/layout/plan-provider";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";

/**
 * The whole page, when the plan does not include the feature it is for.
 *
 * `orgId` is optional because the upgrade link needs it and a page rendered
 * without one — a test, or a screen not yet scoped to an organisation — should
 * still say why it is locked rather than crash on a broken href.
 */
export function PlanLocked({
  feature,
  title,
  description,
  orgId,
}: {
  feature: GatedFeature;
  /** What is locked, in the reader's words: "Custom roles". */
  title: string;
  /** What they lose by not having it. One sentence. */
  description: string;
  orgId?: string;
}) {
  const { requiredTier, tierName } = usePlan();
  const needed = getTierConfig(requiredTier(feature)).displayName;

  return (
    <EmptyState
      icon={Lock}
      title={`${title} need the ${needed} plan`}
      description={`${description} Your organisation is on ${tierName}.`}
      action={
        orgId ? (
          <Link href={`/org/${orgId}/settings`} className={SECONDARY_BUTTON}>
            View plans
          </Link>
        ) : undefined
      }
    />
  );
}

/**
 * The "9 of 10 used" line beside a create button.
 *
 * Renders nothing on an unlimited plan and nothing while the count is still in
 * flight — an empty space is better than "— of 10", which reads as a broken
 * figure rather than a pending one.
 *
 * It is shown from the FIRST one used, not only when full. A cap you meet at
 * the moment you hit it is a refusal; a cap you can see approaching is a
 * decision, and knowing on the ninth member that there are ten is the point.
 */
export function LimitNotice({
  resource,
  noun,
}: {
  resource: Parameters<ReturnType<typeof usePlan>["limitFor"]>[0];
  /** Plural, lowercase: "members", "work rules". */
  noun: string;
}) {
  const { limitFor, usageOf, atLimit } = usePlan();
  const limit = limitFor(resource);
  const current = usageOf(resource);

  if (limit === null || current === null) return null;

  const full = atLimit(resource);
  return (
    <span
      className={`text-xs font-medium ${
        full ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
      }`}
    >
      {current} of {limit} {noun}
      {full ? " — limit reached" : ""}
    </span>
  );
}
