/**
 * Project Slot Purchase API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/projects/slots — Buy extra project quota
 *
 * Starts a ONE-OFF Stripe Checkout. Projects are permanent — they cannot be
 * archived and only an empty one can be deleted — so the slot that holds one is
 * bought once rather than rented monthly.
 *
 * Grants nothing on its own. The quota is credited by the webhook once Stripe
 * confirms the payment, which is the same rule the plan tiers follow: the
 * client may start a purchase, never complete one.
 *
 * Body: { quantity: number }
 *
 * Returns:
 * - 200: { url } — redirect the browser here
 * - 400: Validation failed, or Stripe refused
 * - 401: Unauthorized
 * - 403: Lacks billing:manage, or the org is suspended
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { BillingService } from "@/services/billing.service";
import { ProfileService } from "@/services/profile.service";
import { requirePermission } from "@/lib/permission-guard";
import { planRefusal } from "@/lib/api-utils";
import { MAX_SLOTS_PER_PURCHASE } from "@/lib/stripe";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";

export const runtime = "nodejs";

const billingService = new BillingService();
const profileService = new ProfileService();

const slotSchema = z.object({
  quantity: z.number().int().min(1).max(MAX_SLOTS_PER_PURCHASE),
});

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

    // `billing:manage`, not a projects permission. This spends money, and the
    // person who may create a project is not necessarily the person who may
    // commit the organisation to paying for one.
    const gate = await requirePermission(user.id, orgId, "billing:manage");
    if (!gate.ok) return gate.response;

    const parsed = slotSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Prefer the session email; fall back to the DB record, as the plan
    // checkout does — Stripe needs somebody to send the receipt to.
    let email: string | null = user.email ?? null;
    if (!email) {
      const profile = await profileService.getProfile(user.id);
      email = profile?.email ?? null;
    }
    if (!email) {
      return NextResponse.json(
        { error: "No email on file for billing." },
        { status: 400 }
      );
    }

    const url = await billingService.createSlotCheckout({
      organizationId: orgId,
      userId: user.id,
      userEmail: email,
      quantity: parsed.data.quantity,
      origin: request.nextUrl.origin,
    });

    return NextResponse.json({ url });
  } catch (error) {
    /*
     * A plan refusal, not a bad request. `projects` is Pro and above, and a
     * Free organisation reaching here is being stopped from paying for quota
     * on a feature it does not have — which deserves the plan's own message
     * and a 403, not the blanket 400 below.
     */
    const plan = planRefusal(error);
    if (plan) return plan;

    console.error("[Slot Checkout Error]", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not start checkout",
      },
      { status: 400 }
    );
  }
}
