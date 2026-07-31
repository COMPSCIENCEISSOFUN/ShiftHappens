/**
 * Accept Invitation API Endpoint (Boundary Layer)
 * GET /api/invitations/[token] — Get invitation details
 * POST /api/invitations/[token] — Accept invitation
 * 
 * Public endpoints — no auth required since the user may not
 * have an account yet. Token itself serves as authentication.
 */
import { NextRequest, NextResponse } from "next/server";
import { InvitationService } from "@/services/invitation.service";

const invitationService = new InvitationService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const details = await invitationService.getInvitationDetails(token);

    if (!details) {
      return NextResponse.json(
        { error: "Invalid or expired invitation" },
        { status: 404 }
      );
    }

    // Return safe details for the acceptance page
    return NextResponse.json({
      email: details.email,
      role: details.role,
      organization: details.organization,
    });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const body = await request.json().catch(() => null);

    const registrationData = body?.name && body?.password
      ? { name: body.name, password: body.password }
      : null;

    const result = await invitationService.acceptInvitation(
      token,
      registrationData
    );

    return NextResponse.json({
      message: "Invitation accepted",
      userId: result.user.id,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid or expired invitation") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Accepting as a brand-new user without a name/password is a bad request,
    // not a server fault.
    if (
      error instanceof Error &&
      error.message === "Registration data required for new users"
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}