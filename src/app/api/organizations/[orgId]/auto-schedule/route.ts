/**
 * Auto-Schedule Generate API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/auto-schedule
 *
 * Generates an AI-powered draft schedule for the specified week.
 * Body: { weekStart: "2026-06-22T00:00:00.000Z" }
 * Returns draft assignments for admin review before confirmation.
 */
import { NextRequest, NextResponse } from "next/server";
import { AutoScheduleService } from "@/services/auto-schedule.service";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const autoScheduleService = new AutoScheduleService();

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

    const gate = await requirePermission(user.id, orgId, "allocation:auto_schedule");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    if (!body.weekStart) {
      return NextResponse.json(
        { error: "weekStart is required" },
        { status: 400 }
      );
    }

    const weekStart = new Date(body.weekStart);
    if (isNaN(weekStart.getTime())) {
      return NextResponse.json(
        { error: "Invalid weekStart date" },
        { status: 400 }
      );
    }

    /*
     * A manager drafts their own departments; an admin drafts the organisation.
     *
     * This ran org-wide for everyone, so a manager granted
     * `allocation:auto_schedule` through a custom role drafted — and confirmed —
     * assignments across departments they have no authority over.
     * `permission-guard` states that a custom role can never widen a manager's
     * department scope; here it did.
     */
    const draft = await autoScheduleService.generateSchedule(
      orgId,
      weekStart,
      departmentScopeFor(gate.membership)
    );
    return NextResponse.json(draft);
  } catch (error) {
    console.error("[Auto-Schedule Generate Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}