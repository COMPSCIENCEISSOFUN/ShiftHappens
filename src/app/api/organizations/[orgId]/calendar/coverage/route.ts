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

    const coverage = await reportingService.getCalendarCoverage(orgId);
    return NextResponse.json(coverage);
  } catch (error) {
    console.error("[Calendar Coverage Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
