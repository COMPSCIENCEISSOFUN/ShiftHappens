/**
 * Display Settings API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/settings/display
 *
 * The subset of company settings that any ACTIVE MEMBER may read, as opposed to
 * the sibling `/settings` route which is company-admin only.
 *
 */
import { NextResponse } from "next/server";
import { SettingsService } from "@/services/settings.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const settingsService = new SettingsService();
const accessService = new AccessService();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    // Membership is still required — this is not public data, it just is not
    // admin-only. `getMembership` returns active memberships only, so a
    // deactivated member is treated exactly like a non-member.
    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const settings = await settingsService.getDisplaySettings(orgId);
    return NextResponse.json(settings);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
