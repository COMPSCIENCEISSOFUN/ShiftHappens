/**
 * Registration API Endpoint (Boundary Layer)
 * POST /api/register
 * 
 * Creates a new user account and triggers email verification.
 * Validates input with Zod before passing to AuthService.
 * 
 * Returns:
 * - 201: Registration successful
 * - 400: Validation failed
 * - 409: Email already registered
 * - 500: Internal server error
 */
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/services/auth.service";
import { registerSchema } from "@/lib/validations";

const authService = new AuthService();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate input at the Boundary layer before reaching Control
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Delegate to AuthService (Control layer)
    const { user, emailSent } = await authService.register(parsed.data);

    return NextResponse.json(
      { message: emailSent ? "Registration successful. Please check your email to verify your account." : "Registration successful, but the verification email could not be sent.", userId: user.id, emailSent },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Email already registered") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
