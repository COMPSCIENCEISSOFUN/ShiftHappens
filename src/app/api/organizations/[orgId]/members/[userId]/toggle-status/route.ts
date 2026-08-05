/**
 * Toggle Member Status API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/members/[userId]/toggle-status
 * 
 * Toggles a member between active and inactive status.
 * Requires authentication and Company Admin role.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserManagementService } from "@/services/user-management.service";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";

const userMgmtService = new UserManagementService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; userId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, userId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "members:deactivate");
    if (!gate.ok) return gate.response;

    const updated = await userMgmtService.toggleMemberStatus(userId, orgId, user.id);
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Membership not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("Cannot deactivate")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      // Authorisation refusals, not bad input — the request is well-formed and
      // the caller simply may not make it against this member.
      if (
        error.message === "You cannot change your own status" ||
        error.message === "You cannot change the status of a member above your own" ||
        error.message === "Not authorized to change roles"
      ) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}