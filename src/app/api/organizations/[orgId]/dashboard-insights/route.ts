/**
 * Dashboard Insights API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/dashboard-insights
 * 
 * Returns AI-generated workforce summary, proactive alerts,
 * and review-queue analysis. Requires admin/manager role.
 */
import { NextRequest, NextResponse } from "next/server";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const dashboardAI = new AIDashboardService();
const membershipRepo = new MembershipRepository();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.REPORTS_VIEW)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const insights = await dashboardAI.generateInsights(orgId);
    return NextResponse.json(insights);
  } catch (error) {
    console.error("[Dashboard Insights Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
