/**
 * Registration API Endpoint (Boundary Layer)
 * POST /api/register
 * 
 * Creates a new user account and triggers email verification.
 * Validates input with Zod before passing to AuthService.
 * 
 * Returns:
 * - 201: Accepted — the same body whether or not an account was created
 * - 400: Validation failed
 * - 500: Internal server error
 *
 * There is deliberately no 409. Answering "Email already registered" told an
 * unauthenticated caller exactly what `/api/forgot-password` refuses to say,
 * so a list of a company's addresses posted here sorted the real ones from the
 * invented ones. The reply is now identical either way, the expensive hash runs
 * on both paths so the two cannot be told apart by stopwatch, and the account
 * holder is emailed instead — they are the one person entitled to know.
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
    await authService.register(parsed.data);

    /*
     * No `userId`, and the same wording on both paths. Returning the new user's
     * id would put the distinction straight back into the body — present for a
     * free address, absent for a taken one. Nothing consumes it: the form
     * redirects to /verify-email on any 2xx.
     */
    return NextResponse.json(
      {
        message:
          "Registration successful. Please check your email to verify your account.",
      },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}