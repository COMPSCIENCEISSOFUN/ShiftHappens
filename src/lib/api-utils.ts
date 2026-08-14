/**
 * API Utility Functions (Boundary Layer)
 * 
 * Shared helpers for API route handlers including
 * consistent error logging and response formatting.
 */
import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import {
  FeatureNotAvailableError,
  SubscriptionLimitError,
} from "@/lib/subscription-tiers";

/**
 * A 403 carrying the plan's own message, or null if this is not a plan
 * refusal.
 *
 * ## Why every route needs this and not just the gated ones
 *
 * Plan enforcement lives in the SERVICES — `AllocationService.coverOptions`,
 * `AITaskParserService.parseTaskDescription`, `SettingsService.updateSettings`
 * — because a service has callers a route guard never sees: cron jobs, other
 * services, the recurring materialiser. That is what makes the gate real
 * rather than a decoration on one URL.
 *
 * The consequence is that a `FeatureNotAvailableError` can now surface at a
 * route whose own guard said yes, and a route that does not recognise it
 * answers 500 — telling an admin the product is broken when it is in fact
 * working exactly as sold, and burying the upgrade message that was the whole
 * point of raising a typed error.
 *
 * Usage, at the top of an existing catch:
 *
 *     const plan = planRefusal(error);
 *     if (plan) return plan;
 *
 * @returns 403 for a feature the plan excludes, 403 for a limit reached, or
 *   null for anything else — which the caller should go on handling as before.
 */
export function planRefusal(error: unknown): NextResponse | null {
  if (
    error instanceof FeatureNotAvailableError ||
    error instanceof SubscriptionLimitError
  ) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  return null;
}

/**
 * Logs and returns a 500 error response.
 * Ensures all API errors are visible in server logs.
 *
 * Plan refusals are answered before they can reach the log: a
 * `FeatureNotAvailableError` is a correct outcome, and logging it as an
 * `[API Error]` would fill the log with the product working.
 */
export function handleApiError(error: unknown, context: string) {
  const plan = planRefusal(error);
  if (plan) return plan;

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
