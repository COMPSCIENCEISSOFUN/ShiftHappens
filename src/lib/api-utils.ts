/**
 * API Utility Functions (Boundary Layer)
 * 
 * Shared helpers for API route handlers including
 * consistent error logging and response formatting.
 */
import { NextResponse } from "next/server";
import type { ZodError } from "zod";

/**
 * Logs and returns a 500 error response.
 * Ensures all API errors are visible in server logs.
 */
export function handleApiError(error: unknown, context: string) {
  console.error(`[API Error] ${context}:`, error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

/**
 * Returns a 400 for a failed Zod parse, surfacing the FIRST specific message.
 *
 * A bare "Validation failed" hides the only useful information the validator
 * produced: clients render `error` and ignore `details`, so "Password must
 * contain at least one special character" reaches the user as "Validation
 * failed" and they have no idea what to change.
 *
 * `details` is still included for callers that want per-field errors, and
 * `field` names the offending path so a form can highlight the right input.
 *
 * Note (Zod 4): the issue list is `.issues`, not `.errors`.
 */
export function validationErrorResponse(error: ZodError) {
  const first = error.issues[0];

  return NextResponse.json(
    {
      error: first?.message ?? "Validation failed",
      field: first?.path.join(".") || undefined,
      details: error.flatten(),
    },
    { status: 400 }
  );
}
