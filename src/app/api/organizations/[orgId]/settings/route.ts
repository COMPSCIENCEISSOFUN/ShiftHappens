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
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const settingsService = new SettingsService();
const membershipRepo = new MembershipRepository();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.SETTINGS_READ)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.SETTINGS_UPDATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
    const message = error instanceof Error ? error.message : "";

    if (message === "Operating hours end must be after start") {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
