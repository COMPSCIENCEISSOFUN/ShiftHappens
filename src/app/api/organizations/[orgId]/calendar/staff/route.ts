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
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const reportingService = new ReportingService();
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
    if (!membership || !hasPermission(membership, PERMISSIONS.CALENDAR_VIEW)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const staff = await reportingService.getAllStaffSchedules(orgId);
    return NextResponse.json(staff);
  } catch (error) {
    console.error("[Calendar Staff Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
