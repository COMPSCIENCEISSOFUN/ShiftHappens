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
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const aiService = new AIDashboardService();
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

    const result = await aiService.generateRecommendations(orgId);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[AI Recommendations Error]", error);
    return NextResponse.json(
      { error: "Failed to generate recommendations" },
      { status: 500 }
    );
  }
}
