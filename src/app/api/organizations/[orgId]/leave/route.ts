/**
 * Pending Leave API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/leave — leave awaiting a decision
 *
 * Department-scoped: a manager sees their own members' requests, an admin sees
 * everyone's. The scope comes from `departmentScopeFor(membership)` rather than
 * from the query string, which is the mistake four reporting surfaces made
 * before the 2026-08-05 audit.
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const availService = new AvailabilityService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    /*
     * Gated on `members:request_availability` — the permission that already
     * means "may act on somebody else's availability". Inventing a
     * `leave:review` permission would add a checkbox to every custom role that
     * nobody has ticked, so every existing manager would silently lose the
     * ability the moment a custom role was assigned to them.
     */
    const gate = await requirePermission(
      user.id,
      orgId,
      "members:request_availability"
    );
    if (!gate.ok) return gate.response;

    const pending = await availService.getPendingLeave(
      orgId,
      departmentScopeFor(gate.membership)
    );
    return NextResponse.json(pending);
  } catch (error) {
    console.error("[Leave Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
