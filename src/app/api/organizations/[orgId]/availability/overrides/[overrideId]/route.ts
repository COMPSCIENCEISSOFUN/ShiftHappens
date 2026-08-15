/**
 * Availability Override API Endpoint (Boundary Layer)
 * DELETE /api/organizations/[orgId]/availability/overrides/[overrideId]
 *
 * Removes one of the caller's own date overrides.
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const availService = new AvailabilityService();
const accessService = new AccessService();

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; overrideId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, overrideId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    /*
     * Ownership is proved in the SERVICE, which is why this route no longer
     * reads `AvailabilityRepository`. Missing and somebody else's are the same
     * answer either way — distinguishing them would confirm an override exists
     * on a membership the caller cannot see.
     */
    await availService.deleteOverride(overrideId, membership.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Override not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      // 409: the row exists and is theirs, but a manager's decision stands on
      // it. Well-formed request, refused by state rather than by permission.
      if (error.message.includes("only be changed by a manager")) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
