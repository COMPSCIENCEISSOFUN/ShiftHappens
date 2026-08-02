/**
 * Dashboard Insights API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/dashboard-insights
 * 
 * Returns AI-generated workforce summary, proactive alerts,
 * and rejection pattern analysis. Requires admin/manager role.
 */
import { NextRequest, NextResponse } from "next/server";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor } from "@/lib/department-scope";

const dashboardAI = new AIDashboardService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || !["company_admin", "manager"].includes(membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const insights = await dashboardAI.generateInsights(
      orgId,
      // Managers see only their own departments. Without this the alerts and
      // recommendations named staff and tasks from across the organisation.
      departmentScopeFor(membership)
    );
    return NextResponse.json(insights);
  } catch (error) {
    console.error("[Dashboard Insights Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}