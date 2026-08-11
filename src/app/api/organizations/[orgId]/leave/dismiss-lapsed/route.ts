/**
 * Bulk Dismiss API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/leave/dismiss-lapsed
 *
 * Clears every lapsed request inside the caller's scope. No body: there is
 * nothing to choose. "Dismiss the ones that lapsed" is the whole action, and
 * accepting a list of ids would let a caller name rows the register never
 * showed them — the scope is resolved in the service from the membership,
 * exactly as the register's own filter is.
 *
 * A POST rather than a PATCH: it is not an edit to one identified thing.
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

const availService = new AvailabilityService();

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

    /*
     * The same permission as reviewing one. Dismissing is a weaker act than
     * approving — nothing changes for anybody — so a separate grant would add a
     * checkbox to every custom role that nobody has ticked, and every existing
     * manager would silently lose the ability the moment one was assigned.
     */
    const gate = await requirePermission(
      user.id,
      orgId,
      "members:request_availability"
    );
    if (!gate.ok) return gate.response;

    const result = await availService.dismissLapsedLeave(
      orgId,
      user.id,
      departmentScopeFor(gate.membership)
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error("[Dismiss Lapsed Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
