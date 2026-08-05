/**
 * Invitations API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/invitations — Send invitation
 * GET /api/organizations/[orgId]/invitations — List invitations
 *
 * Requires authentication and Company Admin role.
 */
import { NextRequest, NextResponse } from "next/server";
import { UserManagementService } from "@/services/user-management.service";
import { inviteUserSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { SubscriptionLimitError, FeatureNotAvailableError } from "@/lib/subscription-tiers";

const userMgmtService = new UserManagementService();

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

    // Only Company Admin can invite users
    const gate = await requirePermission(user.id, orgId, "members:invite");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const parsed = inviteUserSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const invitation = await userMgmtService.inviteUser(
      parsed.data,
      orgId,
      user.id
    );
    return NextResponse.json(invitation, { status: 201 });
  } catch (error) {
    if (error instanceof SubscriptionLimitError || error instanceof FeatureNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof Error) {
      if (
        error.message === "User is already a member of this organization" ||
        error.message === "An invitation has already been sent to this email"
      ) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      // An invitation is a membership waiting to happen, so it carries the same
      // ceiling as the role picker: you cannot invite above your own level.
      if (
        error.message === "You cannot grant a role above your own" ||
        error.message === "Not authorized to change roles"
      ) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const gate = await requirePermission(user.id, orgId, "members:invite");
    if (!gate.ok) return gate.response;

    const invitations = await userMgmtService.getOrgInvitations(orgId);
    return NextResponse.json(invitations);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}