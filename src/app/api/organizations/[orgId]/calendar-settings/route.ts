import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { SettingsService } from "@/services/settings.service";

const memberships = new MembershipRepository();
const settings = new SettingsService();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();
    const { orgId } = await params;
    const membership = await memberships.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.CALENDAR_VIEW)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const companySettings = await settings.getSettings(orgId);
    return NextResponse.json({ operatingHoursStart: companySettings.operatingHoursStart, operatingHoursEnd: companySettings.operatingHoursEnd });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
