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
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const hourAlertService = new HourAlertService();

/**
 * Verifies the caller is an admin/manager of the org.
 *
 * Returns the membership on success rather than just `null`: both handlers need
 * it to derive the caller's department scope, and looking it up twice would let
 * the gate and the scope drift apart.
 */
async function requireManager(userId: string, orgId: string) {
  const gate = await requirePermission(userId, orgId, "reports:view");
  if (!gate.ok) return { forbidden: gate.response, membership: null };
  return { forbidden: null, membership: gate.membership };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const { forbidden, membership } = await requireManager(user.id, orgId);
    if (forbidden) return forbidden;

    // Managers see only their department(s); company admins see everything.
    const statuses = await hourAlertService.getOrganizationStatus(
      orgId,
      departmentScopeFor(membership)
    );

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
    // A suspended tenant must not fan out notifications to its whole staff —
    // this endpoint writes notification rows and sends email.
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const { forbidden, membership } = await requireManager(user.id, orgId);
    if (forbidden) return forbidden;

    // A scoped manager may only trigger alerts about their own department(s).
    const { checked, alerted } = await hourAlertService.checkOrganization(
      orgId,
      departmentScopeFor(membership)
    );

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
