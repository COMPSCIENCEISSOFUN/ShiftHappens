/**
 * Calendar Coverage API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/calendar/coverage
 *
 * Returns staff availability coverage counts per hour per day
 * for the calendar heatmap. Each entry contains dayOfWeek (0-6),
 * hour (6-21), and count of available staff.
 */
import { NextRequest, NextResponse } from "next/server";
import { ReportingService } from "@/services/reporting.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const reportingService = new ReportingService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const gate = await requirePermission(user.id, orgId, "calendar:view_team");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    // Managers see only their department(s)' coverage; admins see everyone.
    const coverage = await reportingService.getCalendarCoverage(
      orgId,
      departmentScopeFor(membership)
    );
    return NextResponse.json(coverage);
  } catch (error) {
    console.error("[Calendar Coverage Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}