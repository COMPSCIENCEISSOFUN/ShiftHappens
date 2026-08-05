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
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";

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

    // Suspension gate, missing here while every comparable sibling had one.
    // It creates real assignments and notifies staff — new obligations, which is exactly what suspension exists to stop. Its sibling `assign` refuses the identical write.
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "allocation:auto_allocate");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

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