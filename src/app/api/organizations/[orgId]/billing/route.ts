/**
 * Billing Overview API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/billing — plan, status, renewal, usage
 *
 * Gated on `billing:manage`, the permission that already means "may change what
 * this organisation pays". No new permission was invented: a new one is
 * unticked on every existing custom role, so every administrator holding one
 * would silently lose access the moment it shipped — the trap the leave routes
 * documented.
 *
 * Usage is deliberately ALSO available without this permission, from
 * `GET /subscription`, because a manager blocked by a member limit needs to know
 * it is a plan limit and not a fault. What this permission gates is the money.
 */
import { NextRequest, NextResponse } from "next/server";
import { BillingService } from "@/services/billing.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";

const billingService = new BillingService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const gate = await requirePermission(user.id, orgId, "billing:manage");
    if (!gate.ok) return gate.response;

    return NextResponse.json(await billingService.getOverview(orgId));
  } catch (error) {
    console.error("[Billing Overview Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
