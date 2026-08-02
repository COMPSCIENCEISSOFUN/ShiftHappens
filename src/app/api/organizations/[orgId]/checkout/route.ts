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
import { MembershipRepository } from "@/repositories/membership.repository";
import { createCheckoutSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

export const runtime = "nodejs";

const billingService = new BillingService();
const membershipRepo = new MembershipRepository();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    // Only company admins can change billing.
    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!hasPermission(membership, PERMISSIONS.BILLING_MANAGE)) {
      return NextResponse.json(
        { error: "Only a company admin can manage billing." },
        { status: 403 }
      );
    }

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
      const dbUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { email: true },
      });
      email = dbUser?.email ?? null;
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
