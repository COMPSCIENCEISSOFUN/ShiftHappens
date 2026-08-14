/**
 * Priority Call API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/dashboard/ai-recommendations
 *
 * Returns which outstanding item the smart engine would do first, and why.
 *
 * It used to return a list of AI recommendations, which restated the
 * deterministic alerts computed from the same data — see the PriorityCall
 * docblock. The path is unchanged so nothing else has to move; the shape it
 * returns is `{ call: PriorityCall | null }`.
 *
 * Separate from the main dashboard endpoint because model calls are slow
 * (2-5 seconds) and must fail independently — a null answer is normal and
 * costs the page nothing.
 *
 * Only available to company_admin and manager roles.
 * Rate limit tier: moderate (20 req/min — AI endpoint).
 */
import { NextRequest, NextResponse } from "next/server";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";
import { SubscriptionService } from "@/services/subscription.service";
import { planRefusal } from "@/lib/api-utils";

const aiService = new AIDashboardService();
const subscriptionService = new SubscriptionService();

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

    /*
     * `advanced_analytics`, Pro and above from 2026-08-14. Not reachable
     * through `PERMISSION_FEATURE` because this route needs `reports:view`,
     * which Free keeps for the basic dashboard.
     *
     * The service ALSO refuses, returning `{ call: null }` so no provider call
     * is ever spent. Both are deliberate: this one tells a caller who asked
     * directly why the answer is missing, and that one is what holds when some
     * future caller reaches the service another way.
     */
    await subscriptionService.enforceFeatureAccess(orgId, "advanced_analytics");

    const result = await aiService.getPriorityCall(
      orgId,
      // Managers see only their own departments. Without this the engine could
      // point a manager at a shift in a department they cannot see.
      departmentScopeFor(membership)
    );
    return NextResponse.json(result);
  } catch (error) {
    const plan = planRefusal(error);
    if (plan) return plan;

    console.error("[Priority Call Error]", error);
    return NextResponse.json(
      { error: "Failed to determine priority" },
      { status: 500 }
    );
  }
}