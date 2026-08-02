/**
 * AI Recommendations API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/dashboard/ai-recommendations
 *
 * Returns AI-powered ranked recommendations for the admin dashboard.
 * Separated from the main dashboard endpoint because AI calls
 * are slow (2-5 seconds) and can fail independently.
 *
 * Only available to company_admin and manager roles.
 * Rate limit tier: moderate (20 req/min — AI endpoint).
 */
import { NextRequest, NextResponse } from "next/server";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor } from "@/lib/department-scope";

const aiService = new AIDashboardService();
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

    const result = await aiService.generateRecommendations(
      orgId,
      // Managers see only their own departments. Without this the alerts and
      // recommendations named staff and tasks from across the organisation.
      departmentScopeFor(membership)
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error("[AI Recommendations Error]", error);
    return NextResponse.json(
      { error: "Failed to generate recommendations" },
      { status: 500 }
    );
  }
}