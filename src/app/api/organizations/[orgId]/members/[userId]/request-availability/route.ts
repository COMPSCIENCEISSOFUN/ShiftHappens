/**
 * Request Availability Review API (Boundary Layer)
 * POST /api/organizations/[orgId]/members/[userId]/request-availability
 *
 * Asks a member to check that their weekly availability is still right.
 *
 * This is deliberately a nudge and not an edit. No endpoint anywhere lets a
 * manager write another member's availability, and adding one would turn the
 * eligibility engine's hardest constraint into an advisory — the documented
 * per-task eligibility override already covers the case where a manager needs
 * to proceed anyway, with a reason attached.
 *
 * Manager or admin. The dashboard surfaces this when someone has declined
 * several shifts citing schedule conflicts; the recommendation states that
 * fact and asks, rather than asserting the availability is out of date, which
 * is not something the data can establish.
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const availabilityService = new AvailabilityService();

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string; userId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, userId } = await params;

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "members:request_availability");
    if (!gate.ok) return gate.response;

    const result = await availabilityService.requestAvailabilityReview(
      orgId,
      userId,
      // Named in the notification, so the recipient knows who is asking rather
      // than receiving an anonymous instruction from "the system".
      user.name ?? "A manager",
      user.id,
      departmentScopeFor(gate.membership)
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "Member not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
