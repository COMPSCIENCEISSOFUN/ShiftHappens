/**
 * Auto Allocation API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/tasks/[taskId]/auto-allocate
 * 
 * Triggers automatic allocation for a task.
 * AI ranks eligible staff and assigns top N based on headcount.
 * Only works when company settings allocationMode is "auto".
 * Requires admin/manager role.
 */
import { NextRequest, NextResponse } from "next/server";
import { AllocationService } from "@/services/allocation.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const allocationService = new AllocationService();
const accessService = new AccessService();

export async function POST(
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

    const assignments = await allocationService.autoAllocate(
      taskId,
      orgId,
      user.id
    );
    return NextResponse.json(assignments, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Task not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("not enabled") || error.message.includes("No eligible")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    console.error("[Auto Allocation Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}