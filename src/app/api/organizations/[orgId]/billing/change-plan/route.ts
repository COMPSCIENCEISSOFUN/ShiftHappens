/**
 * Move an existing subscription between paid plans (Boundary Layer)
 * POST /api/organizations/[orgId]/billing/change-plan
 *
 * Body: { plan: "pro" | "enterprise" }
 *
 * ## Why this is not checkout
 *
 * `createCheckoutSession` refuses outright when a subscription already exists,
 * and rightly — two live subscriptions would bill one organisation twice for
 * the same product. Changing plans replaces the price on the existing
 * subscription item instead.
 *
 * ## Why it matters that this handles DOWNgrades
 *
 * It is the alternative offered to somebody about to cancel. Without it the
 * only route off Enterprise is off the product entirely, which turns every
 * "this is more than we need" into a lost customer rather than a smaller one.
 *
 * The tier is not written here. Stripe emits `customer.subscription.updated`
 * and that webhook applies it — the same single path every other tier change
 * takes.
 */
import { NextRequest, NextResponse } from "next/server";
import { BillingService } from "@/services/billing.service";
import { changePlanSchema } from "@/lib/validations";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";

export const runtime = "nodejs";

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

    const parsed = changePlanSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    await billingService.changePlan(orgId, parsed.data.plan, user.id);
    return NextResponse.json({ plan: parsed.data.plan });
  } catch (error) {
    if (error instanceof Error && error.message.includes("no subscription")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Error && error.message.includes("no billable item")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[Billing Change Plan Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
