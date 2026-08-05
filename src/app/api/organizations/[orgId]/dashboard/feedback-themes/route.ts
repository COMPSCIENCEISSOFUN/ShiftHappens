/**
 * Feedback Themes API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/dashboard/feedback-themes
 *
 * Returns what recurs in the free text staff wrote about their shifts —
 * satisfaction comments, decline notes, withdrawal notes.
 *
 * Separate endpoint rather than part of the dashboard payload for the same
 * reason as the priority call: model calls take seconds and must fail on their
 * own. An empty `themes` array is a normal answer and costs the page nothing.
 *
 * Only available to company_admin and manager roles.
 * Rate limit tier: moderate (20 req/min — AI endpoint).
 */
import { NextRequest, NextResponse } from "next/server";
import { AIDashboardService } from "@/services/ai-dashboard.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const aiService = new AIDashboardService();

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

    const result = await aiService.getFeedbackThemes(
      orgId,
      // Managers read only their own departments' feedback. Staff comments name
      // shifts and conditions, so an unscoped read would show a manager what
      // another department's team said about work they do not run.
      departmentScopeFor(membership)
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error("[Feedback Themes Error]", error);
    return NextResponse.json(
      { error: "Failed to read feedback" },
      { status: 500 }
    );
  }
}
