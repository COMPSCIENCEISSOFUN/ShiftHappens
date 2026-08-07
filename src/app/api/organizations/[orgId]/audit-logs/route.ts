/**
 * Audit Logs API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/audit-logs
 *
 * Returns paginated audit logs with optional filters.
 * Company Admin only. Requires Pro or Enterprise subscription tier.
 */
import { NextRequest, NextResponse } from "next/server";
import { AuditLogService } from "@/services/audit-log.service";
import { SubscriptionService } from "@/services/subscription.service";
import { SubscriptionLimitError, FeatureNotAvailableError } from "@/lib/subscription-tiers";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const auditService = new AuditLogService();
const subscriptionService = new SubscriptionService();
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
    if (!membership || !hasPermission(membership, PERMISSIONS.AUDIT_VIEW)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Feature gate: audit log is available on Pro and Enterprise.
    await subscriptionService.enforceFeatureAccess(orgId, "audit_log");

    const searchParams = request.nextUrl.searchParams;
    const filters = {
      action: searchParams.get("action") || undefined,
      entityType: searchParams.get("entityType") || undefined,
      userId: searchParams.get("userId") || undefined,
      search: searchParams.get("search") || undefined,
      startDate: searchParams.get("startDate")
        ? new Date(searchParams.get("startDate")!)
        : undefined,
      endDate: searchParams.get("endDate")
        ? new Date(searchParams.get("endDate")!)
        : undefined,
    };
    const limit = parseInt(searchParams.get("limit") || "50");
    const offset = parseInt(searchParams.get("offset") || "0");

    const result = await auditService.getLogs(orgId, filters, limit, offset);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SubscriptionLimitError || error instanceof FeatureNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("[Audit Logs Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
