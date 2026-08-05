/**
 * Cancel Assignment API Endpoint (Boundary Layer)
 * DELETE /api/organizations/[orgId]/tasks/assignments/[assignmentId]
 * 
 * Admin/Manager action — removes a staff assignment from a task.
 * Cannot cancel completed assignments.
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskService } from "@/services/task.service";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";

const taskService = new TaskService();
const accessService = new AccessService();

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; assignmentId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, assignmentId } = await params;

    // Suspension gate, missing here while every comparable sibling had one.
    // It deletes an assignment and notifies the staff member. Cancelling a shift and mailing about it are both actions a suspended tenant should not take.
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "tasks:assign");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    // Managers can only cancel assignments on tasks in their department scope.
    if (!(await accessService.isAssignmentTaskInScope(assignmentId, membership))) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    await taskService.cancelAssignment(assignmentId, orgId, user.id);
    return NextResponse.json({ message: "Assignment cancelled" });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Assignment not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("Cannot cancel")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}