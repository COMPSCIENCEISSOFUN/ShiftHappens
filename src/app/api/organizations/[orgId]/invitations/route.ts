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
import { AccessService } from "@/services/access.service";
import { SubscriptionLimitError, FeatureNotAvailableError } from "@/lib/subscription-tiers";

const userMgmtService = new UserManagementService();
const accessService = new AccessService();

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
    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || membership.role !== "company_admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || membership.role !== "company_admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const invitations = await userMgmtService.getOrgInvitations(orgId);
    return NextResponse.json(invitations);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}