/**
 * Reset Password API Endpoint (Boundary Layer)
 * POST /api/reset-password
 * 
 * Completes password reset using a valid token and new password.
 * Called when user submits the reset password form.
 * 
 * Returns:
 * - 200: Password reset successfully
 * - 400: Validation failed or invalid/expired token
 * - 500: Internal server error
 */
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/services/auth.service";
import { resetPasswordSchema } from "@/lib/validations";

const authService = new AuthService();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = resetPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    await authService.resetPassword(parsed.data);

    return NextResponse.json({ message: "Password reset successfully" });
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