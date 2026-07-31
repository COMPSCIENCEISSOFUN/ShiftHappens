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

    const draft = await autoScheduleService.generateSchedule(orgId, weekStart);
    return NextResponse.json(draft);
  } catch (error) {
    console.error("[Auto-Schedule Generate Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}