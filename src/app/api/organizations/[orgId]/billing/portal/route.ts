/**
 * Stripe Billing Portal Session (Boundary Layer)
 * POST /api/organizations/[orgId]/billing/portal — a link into Stripe's portal
 *
 * Invoices, payment methods and cancellation live in Stripe's hosted portal
 * rather than here. That is a decision, not a shortcut: building them would
 * mean storing copies of amounts we do not own — each one a chance to show
 * somebody a figure that disagrees with what they were charged — and card
 * details would have to pass through this application to be edited.
 *
 * POST rather than GET because it CREATES a session at Stripe. A GET that
 * mutates is one a browser may prefetch.
 */
import { NextRequest, NextResponse } from "next/server";
import { BillingService } from "@/services/billing.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";

const billingService = new BillingService();

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

    const gate = await requirePermission(user.id, orgId, "billing:manage");
    if (!gate.ok) return gate.response;

    /*
     * The return address is built from the request rather than from an
     * environment variable, so it is correct in development, in a preview
     * deployment and in production without three settings that can disagree.
     */
    const returnUrl = new URL(
      `/org/${orgId}/billing`,
      request.nextUrl.origin
    ).toString();

    return NextResponse.json({
      url: await billingService.createPortalSession(orgId, returnUrl),
    });
  } catch (error) {
    // The one refusal a caller can act on: they have never paid, so Stripe has
    // no customer to open a portal for.
    if (error instanceof Error && error.message.includes("no billing account")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[Billing Portal Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
