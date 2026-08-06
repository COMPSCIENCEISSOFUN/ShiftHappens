/**
 * Availability Override API Endpoint (Boundary Layer)
 * DELETE /api/organizations/[orgId]/availability/overrides/[overrideId]
 *
 * Removes one of the caller's own date overrides.
 *
 * ## Why this did not exist
 *
 * `AvailabilityService.deleteOverride` and its repository method were both
 * written — with a docblock explaining that removing an "I CAN work the 14th"
 * override NARROWS availability and so has to run the ineligibility check —
 * and nothing could reach them. A member could add an override and never remove
 * it, including one added by mistake.
 *
 * ## Ownership, not permission
 *
 * There is no permission for this: overrides are personal, and the check is
 * that the row belongs to the caller's own membership. A 404 rather than a 403
 * for somebody else's override — the caller has no business knowing it exists.
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const availService = new AvailabilityService();
const availRepo = new AvailabilityRepository();
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

    const override = await availRepo.getOverrideById(overrideId);
    // Missing and somebody else's are the same answer. Distinguishing them
    // would confirm an override exists on a membership the caller cannot see.
    if (!override || override.membershipId !== membership.id) {
      return NextResponse.json({ error: "Override not found" }, { status: 404 });
    }

    await availService.deleteOverride(overrideId);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
