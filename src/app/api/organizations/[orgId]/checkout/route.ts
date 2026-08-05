/**
 * Checkout API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/checkout — Start a Stripe Checkout session
 *
 * Creates a Stripe Checkout Session for the Pro plan and returns its hosted
 * payment URL. Only a company_admin may initiate an upgrade. The actual tier
 * change happens later, when Stripe confirms payment via the webhook — this
 * endpoint never grants Pro on its own.
 *
 * Body: { interval: "month" | "year", source: "onboarding" | "settings" }
 *
 * Returns:
 * - 200: { url } — redirect the browser here
 * - 400: Validation failed
 * - 401: Unauthorized
 * - 403: Not a company admin
 * - 500: Internal / Stripe error
 */
import { NextRequest, NextResponse } from "next/server";
import { BillingService } from "@/services/billing.service";
import { requirePermission } from "@/lib/permission-guard";
import { ProfileService } from "@/services/profile.service";
import { createCheckoutSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";

export const runtime = "nodejs";

const billingService = new BillingService();
const profileService = new ProfileService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    // Only holders of billing:manage can change the plan. The bespoke message
    // is gone with the role check: the guard cannot know whether the caller was
    // refused for lacking the permission or for not being a member, and
    // inventing a reason would be a guess printed as a fact.
    const gate = await requirePermission(user.id, orgId, "billing:manage");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const parsed = createCheckoutSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Prefer the session email; fall back to the DB record if absent.
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

    const url = await billingService.createCheckoutSession({
      organizationId: orgId,
      userId: user.id,
      userEmail: email,
      interval: parsed.data.interval,
      source: parsed.data.source,
      origin: request.nextUrl.origin,
    });

    return NextResponse.json({ url });
  } catch (error) {
    console.error("[Checkout POST Error]", error);
    return NextResponse.json(
      { error: "Failed to start checkout" },
      { status: 500 }
    );
  }
}
