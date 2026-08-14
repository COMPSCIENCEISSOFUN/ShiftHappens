/**
 * Company Settings API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/settings — Get current settings
 * PATCH /api/organizations/[orgId]/settings — Update settings
 *
 * Requires authentication and Company Admin role.
 * Settings are lazily initialized with defaults on first access.
 */
import { NextRequest, NextResponse } from "next/server";
import { SettingsService } from "@/services/settings.service";
import { updateCompanySettingsSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { WEIGHTS_ERROR_PREFIX } from "@/lib/ranking-weights";
import { planRefusal } from "@/lib/api-utils";

const settingsService = new SettingsService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const gate = await requirePermission(user.id, orgId, "settings:read");
    if (!gate.ok) return gate.response;

    const settings = await settingsService.getSettings(orgId);
    return NextResponse.json(settings);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    /*
     * Permission BEFORE suspension, matching `PATCH /organizations/[orgId]`.
     *
     * `checkOrgActive` answers false for a suspended org and for one that does
     * not exist, so running it first made this endpoint answer a question about
     * an organisation the caller had not been proved to belong to. Three
     * distinguishable replies — "suspended", "Forbidden", "Validation failed" —
     * turned a guessed id into an existence-and-status oracle for other
     * tenants. The gate has to come first for the suspension answer to be one
     * the caller was entitled to.
     */
    /*
     * Permission BEFORE suspension, matching `PATCH /organizations/[orgId]`.
     *
     * `checkOrgActive` answers false for a suspended org and for one that does
     * not exist, so running it first made this endpoint answer a question about
     * an organisation the caller had not been proved to belong to. Three
     * distinguishable replies — "suspended", "Forbidden", "Validation failed" —
     * turned a guessed id into an existence-and-status oracle for other
     * tenants. The gate has to come first for the suspension answer to be one
     * the caller was entitled to.
     */
    const gate = await requirePermission(user.id, orgId, "settings:update");
    if (!gate.ok) return gate.response;

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const body = await request.json();
    const parsed = updateCompanySettingsSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await settingsService.updateSettings(orgId, parsed.data, user.id);
    return NextResponse.json(updated);
  } catch (error) {
    /*
     * A plan refusal — a Free organisation trying to select an allocation mode
     * its plan does not include. 403 with the plan's own message, so the
     * screen can say which plan grants it rather than showing "Internal
     * server error" for a setting that is working exactly as sold.
     */
    const plan = planRefusal(error);
    if (plan) return plan;

    /*
     * The ranking-priority rules are cross-field, so Zod cannot express them —
     * "not all zero" and "no dimension above 70% of the total" are properties
     * of the whole object. The service throws with the message the screen
     * should show, and this is a rejected input, not a server fault.
     */
    if (
      error instanceof Error &&
      error.message.startsWith(WEIGHTS_ERROR_PREFIX)
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // The "Operating hours end must be after start" mapping that used to live
    // here has been removed along with the rule itself: `end <= start` now
    // means the window wraps past midnight, which is a legal window and not an
    // error. Zod bounds each hour individually, so there is nothing left for
    // this handler to translate.
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}