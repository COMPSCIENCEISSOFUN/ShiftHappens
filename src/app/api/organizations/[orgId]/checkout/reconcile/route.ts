/**
 * Checkout Reconciliation API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/checkout/reconcile — Apply a completed checkout
 *
 * Called by the billing page when Stripe redirects back with a `session_id`.
 * The webhook normally applies the tier first and this is a no-op; it earns its
 * keep when the webhook has not arrived — which is always the case on
 * localhost, where Stripe cannot reach the app at all.
 *
 * Passing a session id here does NOT assert anything. The service reads the
 * session back from Stripe and refuses one that is unpaid or that belongs to a
 * different organisation, so the id is a lookup key rather than a claim.
 *
 * Body: { sessionId: string }
 *
 * Returns:
 * - 200: { tier } — the tier now in force, or null if the session granted nothing
 * - 400: Validation failed
 * - 401: Unauthorized
 * - 403: Lacks billing:manage
 * - 500: Internal / Stripe error
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { BillingService } from "@/services/billing.service";
import { requirePermission } from "@/lib/permission-guard";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";

export const runtime = "nodejs";

const billingService = new BillingService();

const reconcileSchema = z.object({
  // Stripe checkout session ids are `cs_test_…` / `cs_live_…`. Bounded so a
  // caller cannot make us pay for an arbitrarily long lookup against Stripe.
  sessionId: z.string().min(1).max(255).startsWith("cs_"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    // Same permission as starting the checkout. Anyone who could begin the
    // purchase can finish it; nobody else needs to.
    const gate = await requirePermission(user.id, orgId, "billing:manage");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const parsed = reconcileSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const tier = await billingService.reconcileCheckout(
      parsed.data.sessionId,
      orgId
    );

    return NextResponse.json({ tier });
  } catch (error) {
    console.error("[Checkout Reconcile Error]", error);
    return NextResponse.json(
      { error: "Failed to confirm the payment" },
      { status: 500 }
    );
  }
}
