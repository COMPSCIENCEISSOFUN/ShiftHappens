/**
 * Auto-Schedule Confirm API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/auto-schedule/confirm
 *
 * Confirms a draft schedule by creating all assignments in batch.
 * Body: { assignments: [{ taskId, taskTitle, membershipId, staffName, reasoning }] }
 * Returns count of created and failed assignments.
 */
import { NextRequest, NextResponse } from "next/server";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const autoScheduleService = new AutoScheduleService();
const accessService = new AccessService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || membership.role !== "company_admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    if (!body.assignments || !Array.isArray(body.assignments)) {
      return NextResponse.json(
        { error: "assignments array is required" },
        { status: 400 }
      );
    }

    const result = await autoScheduleService.confirmSchedule(
      orgId,
      body.assignments,
      user.id,
      // Echoed from the draft the client was given. The service validates it
      // against the known provider names and drops anything else.
      typeof body.provider === "string" ? body.provider : undefined
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Auto-Schedule Confirm Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}