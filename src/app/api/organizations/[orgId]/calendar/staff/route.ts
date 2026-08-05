/**
 * Calendar Staff API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/calendar/staff
 *
 * Returns all active staff members with their weekly availability
 * schedules. Used by the calendar day-view staff panel.
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

    // Managers see only their department(s)' roster; admins see everyone.
    const staff = await reportingService.getAllStaffSchedules(
      orgId,
      departmentScopeFor(membership)
    );
    return NextResponse.json(staff);
  } catch (error) {
    console.error("[Calendar Staff Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}