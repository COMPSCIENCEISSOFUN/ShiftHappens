/**
 * Eligibility Check API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/tasks/[taskId]/eligibility
 * 
 * Returns eligibility status for all staff against a specific task.
 * Shows which staff are eligible and reasons for any blocks.
 * Requires admin/manager role.
 */
import { NextRequest, NextResponse } from "next/server";
import { EligibilityService } from "@/services/eligibility.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const eligibilityService = new EligibilityService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; taskId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, taskId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || !["company_admin", "manager"].includes(membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!(await accessService.isTaskInScope(taskId, membership))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const eligibility = await eligibilityService.checkEligibilityForTask(
      taskId,
      orgId
    );
    return NextResponse.json(eligibility);
  } catch (error) {
    if (error instanceof Error && error.message === "Task not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}