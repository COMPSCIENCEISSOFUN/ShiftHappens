/**
 * Subscription API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/subscription — Get tier info, usage, and feature access
 *
 * Returns the organization's current subscription tier, resource usage with
 * limits and percentages, and feature availability flags.
 * Used by: settings page (plan display), sidebar (feature gating), upgrade prompts.
 * Accessible to all org members.
 */
import { NextRequest, NextResponse } from "next/server";
import { SubscriptionService } from "@/services/subscription.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

/*
 * Never cached, at either end.
 *
 * `force-dynamic` stops the framework holding a rendered response; the
 * `Cache-Control` header on the way out stops the browser and anything between
 * doing the same. Both are needed — the client asking with `no-store` only
 * governs its own request, and a shared cache that already holds a copy will
 * still hand it to the next reader.
 *
 * The cost of a stale answer here is not a slightly old number. It is a plan
 * gate rendered from one tier while the page around it is rendered from
 * another, which is how an Enterprise organisation was told that Projects are
 * part of Pro.
 */
export const dynamic = "force-dynamic";

const subscriptionService = new SubscriptionService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const usage = await subscriptionService.getUsage(orgId);
    return NextResponse.json(usage, {
      headers: { "Cache-Control": "no-store, must-revalidate" },
    });
  } catch (error) {
    console.error("[Subscription GET Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}