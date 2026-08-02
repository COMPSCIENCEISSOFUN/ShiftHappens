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
import { MembershipRepository } from "@/repositories/membership.repository";
import { isAssignmentTaskInScope } from "@/lib/department-scope";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const taskService = new TaskService();
const membershipRepo = new MembershipRepository();

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; assignmentId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, assignmentId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_ASSIGN)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Managers can only cancel assignments on tasks in their department scope.
    if (!(await isAssignmentTaskInScope(assignmentId, membership))) {
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
