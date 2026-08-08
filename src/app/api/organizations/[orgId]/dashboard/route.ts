/**
 * Dashboard API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/dashboard
 *
 * Returns whichever dashboard sections the caller may see, with per-section
 * resilience: each section is independently nullable, so one failed query does
 * not empty the page.
 *
 * ## Why this stopped branching on the role string
 *
 * It used to read:
 *
 *     if (role === "staff")         → personal sections only
 *     if (role === "manager")       → org sections, department-scoped
 *     if (role === "company_admin") → org sections, plus two org-wide ones
 *
 * Permissions were never consulted, on the single largest data surface in the
 * product — which made the custom-role feature untrue in both directions. An
 * admin who composed a role deliberately WITHOUT `reports:view` and gave it to
 * a manager still sent them key metrics, staff utilisation, rejection trends,
 * coverage and tomorrow's schedule. The permission was removed and nothing
 * happened. In the other direction a senior staff member granted `reports:view`
 * got nothing, because the branch never asked.
 *
 * Every section is now gated by the permission that owns its data, so the
 * catalogue governs this endpoint the way it governs every other one. The three
 * system roles receive exactly what they received before — that is the
 * contract, and `tests/api/dashboard-permissions.test.ts` pins it.
 *
 * ## Permission and scope are separate questions
 *
 * Two sections are org-wide by nature: `departmentWorkload` compares
 * departments against each other, and `certificationSummary` counts across all
 * of them. Neither can be honestly narrowed to one department, so both need an
 * UNRESTRICTED caller as well as the permission. `certificationSummary` is the
 * one where that matters: managers hold `certifications:review` in their
 * bundle, so gating on the permission alone would newly hand every manager an
 * org-wide figure — a scoping regression introduced by a permissions fix.
 *
 * `teamRoster` is the mirror image: it is a scoped member's view of their own
 * team, so it needs a scope with departments in it, which is why an admin does
 * not receive it and did not before.
 *
 * Rate limit tier: relaxed (100 req/min)
 */
import { NextRequest, NextResponse } from "next/server";
import { ReportingService } from "@/services/reporting.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { departmentScopeFor } from "@/lib/department-scope";
import { canBeRostered } from "@/lib/role-config";

const reportingService = new ReportingService();
const accessService = new AccessService();

/** Extracts value from a settled promise, logging errors and returning null on failure */
function extractResult<T>(
  result: PromiseSettledResult<T>,
  sectionName: string
): T | null {
  if (result.status === "fulfilled") return result.value;
  console.error(`[Dashboard ${sectionName} Error]`, result.reason);
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

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const role = membership.role;
    const permissions = accessService.permissionsFor(membership);
    /*
     * Read from the membership the guard already loaded, rather than the
     * separate `getMemberDepartmentIds` round trip this used to make. Same
     * answer, one less query, and — the reason that matters — the same helper
     * every other route scopes with, so this endpoint cannot come to disagree
     * with them about what a member's scope is.
     */
    const scope = departmentScopeFor(membership);
    const unrestricted = scope === null;

    const response: Record<string, unknown> = { role };

    /*
     * The caller's own shifts, stats and certificates.
     *
     * Not a permission: `canBeRostered` is a structural fact about who the
     * engine will consider for a shift, stated once in `role-config` precisely
     * so a fourth caller cannot quietly disagree with the three that already
     * enforce it. Admins are excluded because they can hold no shifts, so the
     * section would render empty for them by construction — and self-service
     * data needs no permission, which is why the twelve self-service entries
     * were retired from the catalogue.
     */
    if (canBeRostered(role)) {
      try {
        response.staffData = await reportingService.getStaffDashboardData(
          membership.id,
          orgId
        );
      } catch (error) {
        console.error("[Dashboard Staff Error]", error);
        response.staffData = null;
      }
    }

    if (permissions.has("reports:view")) {
      // `undefined` is org-wide; an array scopes, and an EMPTY array scopes to
      // nothing. That last case is a member with the permission and no
      // department, who correctly sees no one else's data.
      const departmentIds = scope ?? undefined;

      const [
        needsAttentionResult,
        keyMetricsResult,
        tomorrowsScheduleResult,
        completionChartResult,
        staffUtilizationResult,
        rejectionTrendsResult,
        taskSummaryResult,
        coverageSummaryResult,
      ] = await Promise.allSettled([
        reportingService.getNeedsAttention(orgId, departmentIds),
        reportingService.getKeyMetrics(orgId, departmentIds),
        reportingService.getTomorrowsSchedule(orgId, departmentIds),
        reportingService.getCompletionChart(orgId, departmentIds),
        reportingService.getStaffUtilization(orgId, departmentIds),
        reportingService.getRejectionTrends(orgId, departmentIds),
        reportingService.getTaskSummary(orgId, departmentIds),
        reportingService.getCoverageSummary(orgId, departmentIds),
      ]);

      response.needsAttention = extractResult(needsAttentionResult, "NeedsAttention");
      response.keyMetrics = extractResult(keyMetricsResult, "KeyMetrics");
      response.tomorrowsSchedule = extractResult(tomorrowsScheduleResult, "TomorrowsSchedule");
      response.completionChart = extractResult(completionChartResult, "CompletionChart");
      response.staffUtilization = extractResult(staffUtilizationResult, "StaffUtilization");
      response.rejectionTrends = extractResult(rejectionTrendsResult, "RejectionTrends");
      response.taskSummary = extractResult(taskSummaryResult, "TaskSummary");
      response.coverageSummary = extractResult(coverageSummaryResult, "CoverageSummary");
    }

    // Compares departments against one another, so it means nothing to someone
    // who can only see one of them.
    if (permissions.has("reports:view") && unrestricted) {
      try {
        response.departmentWorkload =
          await reportingService.getDepartmentWorkload(orgId);
      } catch (error) {
        console.error("[Dashboard DepartmentWorkload Error]", error);
        response.departmentWorkload = null;
      }
    }

    // Certifications are counted org-wide and cannot be narrowed to a
    // department, so the permission alone is not enough — see the header.
    if (permissions.has("certifications:review") && unrestricted) {
      try {
        response.certificationSummary =
          await reportingService.getCertificationSummary(orgId);
      } catch (error) {
        console.error("[Dashboard CertificationSummary Error]", error);
        response.certificationSummary = null;
      }
    }

    // A scoped member's view of their own team. An unrestricted caller has no
    // "own team", which is why an admin does not get this one.
    if (
      permissions.has("calendar:view_team") &&
      scope !== null &&
      scope.length > 0
    ) {
      try {
        response.teamRoster = await reportingService.getTeamRoster(orgId, scope);
      } catch (error) {
        console.error("[Dashboard TeamRoster Error]", error);
        response.teamRoster = null;
      }
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error("[Dashboard Error]", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
