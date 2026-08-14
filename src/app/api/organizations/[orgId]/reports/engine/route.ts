/**
 * Smart-engine Reports API (Boundary Layer)
 * GET /api/organizations/[orgId]/reports/engine?days=30
 *
 * Backs the allocation, eligibility, response and satisfaction panels: how
 * assignments were made, which strategy ranked them, whether the engine's top
 * pick held up, how often managers override the constraint checks, how quickly
 * staff answer, and what they thought of the shifts they worked.
 *
 * Admin or manager. Managers are department-scoped like every other report —
 * a manager should not learn the whole organisation's allocation mix from a
 * chart endpoint.
 *
 * ## Plan
 *
 * `advanced_analytics`, Pro and above from 2026-08-14. Checked here rather
 * than through `PERMISSION_FEATURE`, because the permission this route needs
 * is `reports:view` — which Free keeps, since the basic dashboard and its
 * task-coverage counts are core workforce management. The line is between
 * counting what happened and analysing it: `GET /reports` next door stays on
 * every plan, and these five panels do not.
 */
import { NextRequest, NextResponse } from "next/server";
import { ReportingService } from "@/services/reporting.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";
import { SubscriptionService } from "@/services/subscription.service";
import { planRefusal } from "@/lib/api-utils";

const reportingService = new ReportingService();
const subscriptionService = new SubscriptionService();

/** Bounded so a caller cannot ask for an unindexed scan of all history. */
const MIN_DAYS = 7;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

function parseWindow(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(parsed)));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const gate = await requirePermission(user.id, orgId, "reports:view");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    // After the permission, not before: the plan-before-permission ordering
    // `requirePermission` uses exists so a refusal names the right gate, and
    // here the permission is the one that decides whether this reader should
    // be offered analytics at all.
    await subscriptionService.enforceFeatureAccess(orgId, "advanced_analytics");

    const scope = departmentScopeFor(membership);
    const days = parseWindow(request.nextUrl.searchParams.get("days"));

    const [allocation, eligibility, coverage, response, satisfaction] =
      await Promise.all([
        reportingService.getAllocationEngineStats(orgId, days, scope),
        reportingService.getEligibilityEngineStats(orgId, days, scope),
        reportingService.getCalendarCoverage(orgId, scope),
        reportingService.getResponseStats(orgId, days, scope),
        reportingService.getSatisfactionStats(orgId, days, scope),
      ]);

    return NextResponse.json({
      allocation,
      eligibility,
      coverage,
      response,
      satisfaction,
    });
  } catch (error) {
    const plan = planRefusal(error);
    if (plan) return plan;

    console.error("[Engine Reports Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
