/**
 * Email Verification API Endpoint (Boundary Layer)
 * POST /api/verify-email
 * 
 * Verifies a user's email address using a token sent via email.
 * Called when user clicks the verification link.
 * 
 * Returns:
 * - 200: Email verified successfully
 * - 400: Missing token or invalid/expired token
 * - 500: Internal server error
 */
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/services/auth.service";

const authService = new AuthService();

export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();

    if (!token || typeof token !== "string") {
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }

    await authService.verifyEmail(token);

    return NextResponse.json({ message: "Email verified successfully" });
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid or expired token") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // A token that resolves to a deleted account is a 404, not a server fault.
    if (error instanceof Error && error.message === "User not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}