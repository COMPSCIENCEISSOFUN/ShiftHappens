/**
 * AI Suggestion API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/tasks/[taskId]/suggest
 * 
 * Returns AI-ranked staff suggestions for a task.
 * Requires admin/manager role.
 */
import { NextRequest, NextResponse } from "next/server";
import { AllocationService } from "@/services/allocation.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { isTaskInScope } from "@/lib/department-scope";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const allocationService = new AllocationService();
const membershipRepo = new MembershipRepository();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; taskId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, taskId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.ALLOCATION_USE_SUGGESTIONS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!(await isTaskInScope(taskId, membership))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const suggestions = await allocationService.getSuggestions(taskId, orgId);
    return NextResponse.json(suggestions);
  } catch (error) {
    if (error instanceof Error && error.message === "Task not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[AI Suggestion Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
