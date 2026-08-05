/**
 * Reports API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/reports
 * 
 * Returns aggregated reporting data for dashboard charts.
 * Requires admin or manager role.
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

    const gate = await requirePermission(user.id, orgId, "reports:view");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    // Managers see only their department(s); company admins see everything.
    const reports = await reportingService.getDashboardReports(
      orgId,
      departmentScopeFor(membership)
    );
    return NextResponse.json(reports);
  } catch (error) {
    console.error("[Reports Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}