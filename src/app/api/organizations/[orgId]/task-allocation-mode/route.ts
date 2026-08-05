/**
 * Minimal allocation setting needed by task operators.
 * Managers may read this operational flag without being allowed to view or
 * modify the wider company settings surface.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { SettingsService } from "@/services/settings.service";

const membershipRepo = new MembershipRepository();
const settingsService = new SettingsService();

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_READ)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const settings = await settingsService.getSettings(orgId);
    return NextResponse.json({ allocationMode: settings.allocationMode });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
