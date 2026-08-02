/**
 * Hour Limit Alerts API Endpoint (Boundary Layer)
 *
 * GET  /api/organizations/[orgId]/hour-alerts
 *   Returns each staff member's hour-limit status (used vs limit, severity).
 *   Read-only — sends no notifications. Used by manager views.
 *   Supports ?atRisk=true to return only members approaching/over a limit.
 *
 * POST /api/organizations/[orgId]/hour-alerts
 *   Runs an org-wide scan and SENDS notifications to at-risk staff and their
 *   managers (US-72, US-85). Safe to call on a schedule — repeat alerts about
 *   the same member are suppressed for a cooldown window.
 *
 * Both require admin/manager role.
 */
import { NextRequest, NextResponse } from "next/server";
import { HourAlertService } from "@/services/hour-alert.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const hourAlertService = new HourAlertService();
const membershipRepo = new MembershipRepository();

/** Verifies the caller is an admin/manager of the org. */
async function requireManager(userId: string, orgId: string) {
  const membership = await membershipRepo.findByUserAndOrg(userId, orgId);
  if (!membership || !hasPermission(membership, PERMISSIONS.REPORTS_VIEW)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const forbidden = await requireManager(user.id, orgId);
    if (forbidden) return forbidden;

    const statuses = await hourAlertService.getOrganizationStatus(orgId);

    const atRiskOnly =
      request.nextUrl.searchParams.get("atRisk") === "true";
    const result = atRiskOnly
      ? statuses.filter((s) => s.severity !== "ok")
      : statuses;

    return NextResponse.json(result);
  } catch (error) {
    console.error("[HourAlerts GET Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const forbidden = await requireManager(user.id, orgId);
    if (forbidden) return forbidden;

    const { checked, alerted } = await hourAlertService.checkOrganization(orgId);

    return NextResponse.json({
      checked,
      alertedCount: alerted.length,
      alerted,
    });
  } catch (error) {
    console.error("[HourAlerts POST Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
