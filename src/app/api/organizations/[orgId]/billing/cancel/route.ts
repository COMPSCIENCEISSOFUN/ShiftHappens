/**
 * Cancel or resume a subscription (Boundary Layer)
 * POST   /api/organizations/[orgId]/billing/cancel — schedule cancellation
 * DELETE /api/organizations/[orgId]/billing/cancel — undo a scheduled one
 *
 */
import { NextRequest, NextResponse } from "next/server";
import { BillingService } from "@/services/billing.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";

export const runtime = "nodejs";

const billingService = new BillingService();

/** Shared gate: authenticated, org not suspended, may manage billing. */
async function guard(request: NextRequest, orgId: string) {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false as const, response: unauthorizedResponse() };

  const suspended = await checkOrgSuspended(orgId);
  if (suspended) return { ok: false as const, response: suspended };

  const gate = await requirePermission(user.id, orgId, "billing:manage");
  if (!gate.ok) return { ok: false as const, response: gate.response };

  return { ok: true as const, userId: user.id };
}

/** The one refusal a caller can act on: there is nothing to cancel. */
function toResponse(error: unknown) {
  if (error instanceof Error && error.message.includes("no subscription")) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error("[Billing Cancel Error]", error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId } = await params;
    const gate = await guard(request, orgId);
    if (!gate.ok) return gate.response;

    const { accessUntil } = await billingService.cancelSubscription(
      orgId,
      gate.userId
    );
    return NextResponse.json({ accessUntil });
  } catch (error) {
    return toResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId } = await params;
    const gate = await guard(request, orgId);
    if (!gate.ok) return gate.response;

    await billingService.resumeSubscription(orgId, gate.userId);
    return NextResponse.json({ resumed: true });
  } catch (error) {
    return toResponse(error);
  }
}
