/**
 * Accept Invitation API Endpoint (Boundary Layer)
 * GET /api/invitations/[token] — Get invitation details
 * POST /api/invitations/[token] — Accept invitation
 * 
 * Public endpoints — no auth required since the user may not
 * have an account yet. Token itself serves as authentication.
 */
import { NextRequest, NextResponse } from "next/server";
import { acceptInvitationSchema } from "@/lib/validations";
import { validationErrorResponse } from "@/lib/api-utils";
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

    /*
     * An existing user accepting an invitation sends no credentials — the
     * membership is simply added — so a body with neither field is valid and
     * `null` is the right registration data. A body that carries EITHER field
     * is a new-account request and must satisfy the same rules as registration.
     * It previously satisfied none: the password went to bcrypt unvalidated.
     */
    let registrationData: { name: string; password: string } | null = null;
    if (body?.name || body?.password) {
      const parsed = acceptInvitationSchema.safeParse(body);
      if (!parsed.success) return validationErrorResponse(parsed.error);
      registrationData = parsed.data;
    }

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
    // Accepting an invitation you have already accepted — a double-click, or an
    // admin who added you manually in the meantime. 409, not 500: the request
    // was well-formed and the server is fine, the state just already holds.
    if (
      error instanceof Error &&
      error.message === "You are already a member of this organization"
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}