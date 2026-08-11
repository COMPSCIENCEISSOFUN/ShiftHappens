/**
 * Audit Logs API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/audit-logs
 *
 * Returns paginated audit logs with optional filters.
 * Company Admin only. Requires Enterprise subscription tier.
 */
import { NextRequest, NextResponse } from "next/server";
import { AuditLogService } from "@/services/audit-log.service";
import { DATE_RANGE_MESSAGE } from "@/lib/date-range";
import { SubscriptionService } from "@/services/subscription.service";
import { SubscriptionLimitError, FeatureNotAvailableError } from "@/lib/subscription-tiers";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";

const auditService = new AuditLogService();
const subscriptionService = new SubscriptionService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const gate = await requirePermission(user.id, orgId, "audit:view");
    if (!gate.ok) return gate.response;

    // Feature gate: audit log is Enterprise only
    await subscriptionService.enforceFeatureAccess(orgId, "audit_log");

    const searchParams = request.nextUrl.searchParams;
    const filters = {
      action: searchParams.get("action") || undefined,
      entityType: searchParams.get("entityType") || undefined,
      userId: searchParams.get("userId") || undefined,
      /*
       * Calendar days, passed through untouched. Building instants here meant
       * doing timezone arithmetic in the Boundary layer, and doing it in the
       * READER's zone rather than the organisation's — see `getLogs`.
       */
      from: searchParams.get("from"),
      to: searchParams.get("to"),
    };
    const limit = parseInt(searchParams.get("limit") || "50");
    const offset = parseInt(searchParams.get("offset") || "0");

    const result = await auditService.getLogs(orgId, filters, limit, offset);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SubscriptionLimitError || error instanceof FeatureNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    // A range that cannot mean anything is the caller's mistake, not a fault.
    if (
      error instanceof Error &&
      Object.values(DATE_RANGE_MESSAGE).includes(error.message)
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[Audit Logs Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}