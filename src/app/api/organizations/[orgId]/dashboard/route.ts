/**
 * Dashboard API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/dashboard
 *
 * Returns whichever dashboard sections the caller may see, with per-section
 * resilience: each section is independently nullable, so one failed query does
 * not empty the page.
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
        declineReasonsResult,
        taskSummaryResult,
        coverageSummaryResult,
      ] = await Promise.allSettled([
        reportingService.getNeedsAttention(orgId, departmentIds),
        reportingService.getKeyMetrics(orgId, departmentIds),
        reportingService.getTomorrowsSchedule(orgId, departmentIds),
        reportingService.getCompletionChart(orgId, departmentIds),
        reportingService.getStaffUtilization(orgId, departmentIds),
        reportingService.getDeclineReasons(orgId, departmentIds),
        reportingService.getTaskSummary(orgId, departmentIds),
        reportingService.getCoverageSummary(orgId, departmentIds),
      ]);

      response.needsAttention = extractResult(needsAttentionResult, "NeedsAttention");
      response.keyMetrics = extractResult(keyMetricsResult, "KeyMetrics");
      response.tomorrowsSchedule = extractResult(tomorrowsScheduleResult, "TomorrowsSchedule");
      response.completionChart = extractResult(completionChartResult, "CompletionChart");
      response.staffUtilization = extractResult(staffUtilizationResult, "StaffUtilization");
      /*
       * Declines by REASON, not by person.
       *
       * `getRejectionTrends` groups the same rows by member and was returned
       * here for months with nothing rendering it — a named list of who
       * declined what, computed on every dashboard load and shown to nobody.
       * The aggregate is the half a manager can act on.
       */
      response.declineReasons = extractResult(declineReasonsResult, "DeclineReasons");
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
