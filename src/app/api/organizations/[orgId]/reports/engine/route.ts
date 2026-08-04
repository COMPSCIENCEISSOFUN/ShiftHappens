/**
 * Smart-engine Reports API (Boundary Layer)
 * GET /api/organizations/[orgId]/reports/engine?days=30
 *
 * Backs the allocation, eligibility, response and satisfaction panels: how
 * assignments were made, which strategy ranked them, whether the engine's top
 * pick held up, how often managers override the constraint checks, how quickly
 * staff answer, and what they thought of the shifts they worked.
 *
 * Admin or manager. Managers are department-scoped like every other report —
 * a manager should not learn the whole organisation's allocation mix from a
 * chart endpoint.
 */
import { NextRequest, NextResponse } from "next/server";
import { ReportingService } from "@/services/reporting.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor } from "@/lib/department-scope";

const reportingService = new ReportingService();
const accessService = new AccessService();

/** Bounded so a caller cannot ask for an unindexed scan of all history. */
const MIN_DAYS = 7;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

function parseWindow(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(parsed)));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || !["company_admin", "manager"].includes(membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const scope = departmentScopeFor(membership);
    const days = parseWindow(request.nextUrl.searchParams.get("days"));

    const [allocation, eligibility, coverage, response, satisfaction] =
      await Promise.all([
        reportingService.getAllocationEngineStats(orgId, days, scope),
        reportingService.getEligibilityEngineStats(orgId, days, scope),
        reportingService.getCalendarCoverage(orgId, scope),
        reportingService.getResponseStats(orgId, days, scope),
        reportingService.getSatisfactionStats(orgId, days, scope),
      ]);

    return NextResponse.json({
      allocation,
      eligibility,
      coverage,
      response,
      satisfaction,
    });
  } catch (error) {
    console.error("[Engine Reports Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
