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
import { MembershipRepository } from "@/repositories/membership.repository";
import { isTaskInScope } from "@/lib/department-scope";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const allocationService = new AllocationService();
const membershipRepo = new MembershipRepository();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; taskId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, taskId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.ALLOCATION_AUTO_ALLOCATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!(await isTaskInScope(taskId, membership))) {
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
