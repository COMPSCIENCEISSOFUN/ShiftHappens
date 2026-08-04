/**
 * Organisation Seniority API (Boundary Layer)
 * GET /api/organizations/[orgId]/members/seniority
 *
 * Every member's seniority level, keyed by membership id, with the count and
 * the explanation behind it.
 *
 * A separate endpoint rather than extra fields on the members list, because
 * the level depends on a department scope the list has no opinion about — the
 * assignment path asks for it per shift, this asks for it org-wide, and the
 * two legitimately differ. Merging them would have to pick one silently.
 *
 * Manager or admin: this is rostering information about colleagues, not
 * something every member should be able to read about everyone else.
 */
import { NextRequest, NextResponse } from "next/server";
import { SeniorityService } from "@/services/seniority.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const seniorityService = new SeniorityService();
const accessService = new AccessService();

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || !["company_admin", "manager"].includes(membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const [assessments, thresholds] = await Promise.all([
      seniorityService.assessOrganisation(orgId),
      seniorityService.getThresholds(orgId),
    ]);

    // The thresholds travel with the assessments so the UI can explain the
    // scale — "40 shifts to reach Senior" — without a second request or a
    // hard-coded copy of the defaults that drifts the moment they are changed.
    return NextResponse.json({ assessments, thresholds });
  } catch (error) {
    console.error("[Seniority Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
