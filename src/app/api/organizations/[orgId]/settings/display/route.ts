/**
 * Display Settings API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/settings/display
 *
 * The subset of company settings that any ACTIVE MEMBER may read, as opposed to
 * the sibling `/settings` route which is company-admin only.
 *
 * ## Why this exists as a separate route
 *
 * The calendar draws its time grid from the organisation's operating hours, and
 * the calendar is rendered for managers and staff, not just admins. Those
 * members received a 403 from the admin-only settings read; the component's
 * `if (res.ok)` swallowed it and fell back to its hard-coded 6–22 defaults. An
 * admin who set 08:00–20:00 therefore saw one grid while their team saw a
 * different one, with nothing anywhere reporting a problem — the worst kind of
 * bug, because both parties believe they are looking at the same schedule.
 *
 * The fix is deliberately a second route rather than making the existing GET
 * return a different shape depending on the caller's role. A response whose
 * fields vary by role cannot be typed honestly on the client, and every
 * consumer then has to defend against fields that may or may not be there.
 * Two routes, two fixed shapes, one obvious reason to pick each.
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
