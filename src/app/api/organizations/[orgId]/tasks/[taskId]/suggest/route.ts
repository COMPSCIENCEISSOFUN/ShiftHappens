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
import { AccessService } from "@/services/access.service";

const allocationService = new AllocationService();
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