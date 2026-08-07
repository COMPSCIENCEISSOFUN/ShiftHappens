/**
 * POST /api/organizations/[orgId]/billing-portal
 * Opens Stripe's hosted customer portal for payment methods, invoices, and
 * subscription changes. Billing permissions match the Checkout endpoint.
 */
import { NextRequest, NextResponse } from "next/server";
import { BillingService } from "@/services/billing.service";
import { MembershipRepository } from "@/repositories/membership.repository";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";
import { getTrustedAppOrigin } from "@/lib/stripe";

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
    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.BILLING_MANAGE)) {
      return NextResponse.json({ error: "Only a company admin can manage billing." }, { status: 403 });
    }

    const url = await billingService.createPortalSession({
      organizationId: orgId,
      origin: getTrustedAppOrigin(request.nextUrl.origin),
    });
    return NextResponse.json({ url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to open billing portal";
    if (/No Stripe billing profile exists/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    console.error("[Billing portal POST Error]", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
