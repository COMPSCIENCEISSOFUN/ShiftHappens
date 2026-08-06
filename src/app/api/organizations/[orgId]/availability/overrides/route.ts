/**
 * Availability Overrides API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/availability/overrides — List overrides
 * POST /api/organizations/[orgId]/availability/overrides — Create override
 * 
 * Staff can create date-specific overrides for their own schedule.
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import { createAvailabilityOverrideSchema } from "@/lib/validations";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

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

    const overrides = await availService.getOverrides(membership.id);
    return NextResponse.json(overrides);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

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
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createAvailabilityOverrideSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const override = await availService.createOverride(membership.id, parsed.data);
    return NextResponse.json(override, { status: 201 });
  } catch (error) {
    // A full-time member asking to WORK a day they are not contracted for.
    // 403 rather than 400: the request is well-formed, they are simply not the
    // one who decides which days those are.
    if (
      error instanceof Error &&
      error.message === "Contracted days are set by your organisation"
    ) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}