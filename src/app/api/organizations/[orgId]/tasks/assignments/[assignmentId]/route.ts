/**
 * Cancel Assignment API Endpoint (Boundary Layer)
 * DELETE /api/organizations/[orgId]/tasks/assignments/[assignmentId]
 * 
 * Admin/Manager action — removes a staff assignment from a task.
 * Cannot cancel completed assignments.
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskService } from "@/services/task.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

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

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership || !["company_admin", "manager"].includes(membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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