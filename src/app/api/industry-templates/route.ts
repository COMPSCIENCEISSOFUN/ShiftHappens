/**
 * Industry Templates — the member-facing read (Boundary Layer).
 * GET /api/industry-templates — the ACTIVE templates, for any signed-in user.
 *
 * ## Why this exists separately
 *
 * This list used to be served by `GET /api/platform/templates`, which branched
 * on `isPlatformAdmin` and never denied: an admin got every template with usage
 * counts, and everyone else got the active ones. It was documented as a KNOWN
 * GAP in the route manifest because a path under `/api/platform/` that any
 * authenticated user may call is a contradiction — the prefix is the only thing
 * telling the next person what the audience is, and there it was lying.
 *
 * The two audiences want genuinely different things, which is what makes the
 * split clean rather than cosmetic:
 *
 *   onboarding / settings → the active templates, to pick one
 *   platform admin        → every template including retired ones, plus how
 *                           many organisations were built from each
 *
 * Usage counts are the part that had to move. They are a cross-tenant
 * aggregate — how many organisations chose each template — and nothing outside
 * the platform console has any business reading them.
 *
 * Membership is not required. A user mid-onboarding has no organisation yet,
 * and this list is what they choose one from; requiring a membership would make
 * the first screen after sign-up unreachable.
 */
import { NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { IndustryTemplateService } from "@/services/industry-template.service";

const templateService = new IndustryTemplateService();

export async function GET() {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const templates = await templateService.getActiveTemplates();
    return NextResponse.json(templates);
  } catch (error) {
    console.error("[GET /api/industry-templates]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
