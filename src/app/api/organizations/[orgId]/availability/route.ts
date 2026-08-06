/**
 * Availability API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/availability — Get own weekly schedule
 * PUT /api/organizations/[orgId]/availability — Set weekly schedule
 * 
 * Any org member can manage their own availability.
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import { setWeeklyAvailabilitySchema } from "@/lib/validations";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { isFullTime } from "@/lib/role-config";

const availService = new AvailabilityService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    /*
     * An object rather than the bare array this used to return.
     *
     * The page has to know whether the caller is full-time before it can label
     * anything: for a casual member this screen is "my availability" and edits
     * bind at once, for a full-time member it is "my contracted days" and an
     * absence is a leave request. Deriving that on the client from a role or a
     * guess would put the labelling and the enforcement on different facts.
     */
    const schedule = await availService.getWeeklySchedule(membership.id);
    return NextResponse.json({
      schedule,
      employmentType: membership.employmentType ?? null,
      needsApproval: isFullTime(membership.employmentType),
    });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(
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
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = setWeeklyAvailabilitySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const schedule = await availService.setWeeklySchedule(
      membership.id,
      parsed.data.schedule
    );
    return NextResponse.json(schedule);
  } catch (error) {
    if (error instanceof Error && error.message.includes("End time")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}