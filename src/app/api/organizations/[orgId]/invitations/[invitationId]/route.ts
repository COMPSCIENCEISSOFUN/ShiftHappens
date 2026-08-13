/**
 * Single Invitation API Endpoint (Boundary Layer)
 * DELETE /api/organizations/[orgId]/invitations/[invitationId] — Revoke a pending invite
 *
 * Requires authentication and the same permission as sending one. Anybody who
 * could issue the invitation can withdraw it; nobody else needs to.
 *
 * The service scopes the lookup to the organisation, so an id belonging to
 * another tenant answers 404 rather than deleting anything.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserManagementService } from "@/services/user-management.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";

const userMgmtService = new UserManagementService();

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; invitationId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, invitationId } = await params;

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "members:invite");
    if (!gate.ok) return gate.response;

    await userMgmtService.revokeInvitation(invitationId, orgId, user.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Invitation not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      // Already accepted is a CONFLICT, not a bad request: the invitation was
      // real and the caller's view of it is simply out of date, which is what
      // 409 says and 400 does not.
      if (error.message === "This invitation has already been accepted") {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (
        error.message === "You cannot revoke an invitation above your own role" ||
        error.message === "Not authorized to change roles"
      ) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
    }
    console.error("[Invitation DELETE Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
