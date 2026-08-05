/**
 * Dashboard API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/dashboard
 *
 * Returns role-specific dashboard data with per-section resilience.
 * Each section is independently nullable — if one query fails,
 * the rest still render. Uses Promise.allSettled for parallel execution.
 *
 * Role behavior:
 * - company_admin: full org overview + department workload
 * - manager: department-scoped data + team roster
 * - staff: personal calendar, stats, and certifications
 *
 * Rate limit tier: relaxed (100 req/min)
 */
import { NextRequest, NextResponse } from "next/server";
import { ReportingService } from "@/services/reporting.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";

const reportingService = new ReportingService();
const membershipRepo = new MembershipRepository();

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

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const role = membership.role;

    // ---- Staff: personal dashboard ----
    if (role === "staff") {
      try {
        const staffData = await reportingService.getStaffDashboardData(
          membership.id,
          orgId
        );
        return NextResponse.json({ role, staffData });
      } catch (error) {
        console.error("[Dashboard Staff Error]", error);
        return NextResponse.json({ role, staffData: null });
      }
    }

    // ---- Admin / Manager: org-level dashboard ----
    // Manager views are scoped to their departments (BCE: route → service → repo)
    let departmentIds: string[] | undefined;
    if (role === "manager") {
      departmentIds = await reportingService.getMemberDepartmentIds(
        membership.id
      );
    }

    // Parallel fetch — 8 shared sections for admin and manager
    const [
      needsAttentionResult,
      keyMetricsResult,
      tomorrowsScheduleResult,
      completionChartResult,
      staffUtilizationResult,
      taskSummaryResult,
      coverageSummaryResult,
    ] = await Promise.allSettled([
      reportingService.getNeedsAttention(orgId, departmentIds),
      reportingService.getKeyMetrics(orgId, departmentIds),
      reportingService.getTomorrowsSchedule(orgId, departmentIds),
      reportingService.getCompletionChart(orgId, departmentIds),
      reportingService.getStaffUtilization(orgId, departmentIds),
      reportingService.getTaskSummary(orgId, departmentIds),
      reportingService.getCoverageSummary(orgId, departmentIds),
    ]);

    const response: Record<string, unknown> = {
      role,
      needsAttention: extractResult(needsAttentionResult, "NeedsAttention"),
      keyMetrics: extractResult(keyMetricsResult, "KeyMetrics"),
      tomorrowsSchedule: extractResult(tomorrowsScheduleResult, "TomorrowsSchedule"),
      completionChart: extractResult(completionChartResult, "CompletionChart"),
      staffUtilization: extractResult(staffUtilizationResult, "StaffUtilization"),
      taskSummary: extractResult(taskSummaryResult, "TaskSummary"),
      coverageSummary: extractResult(coverageSummaryResult, "CoverageSummary"),
    };

    if (role === "manager") {
      response.managedDepartments = membership.departmentMemberships.map((item) => item.department.name);
    }

    // Role-specific section (resilient — failure doesn't affect shared sections)
    if (role === "company_admin") {
      try {
        response.departmentWorkload =
          await reportingService.getDepartmentWorkload(orgId);
      } catch (error) {
        console.error("[Dashboard DepartmentWorkload Error]", error);
        response.departmentWorkload = null;
      }

      // Certifications are org-wide (not department-scoped), so admin only.
      try {
        response.certificationSummary =
          await reportingService.getCertificationSummary(orgId);
      } catch (error) {
        console.error("[Dashboard CertificationSummary Error]", error);
        response.certificationSummary = null;
      }
    } else if (role === "manager" && departmentIds?.length) {
      try {
        response.teamRoster = await reportingService.getTeamRoster(
          orgId,
          departmentIds
        );
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
