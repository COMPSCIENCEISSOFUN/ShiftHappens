/**
 * My Tasks API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/my-tasks — Get staff's own assignments
 * 
 * Returns all task assignments for the authenticated user
 * within the specified organization. Supports status filtering.
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskService } from "@/services/task.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

const taskService = new TaskService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || undefined;

    const assignments = await taskService.getStaffTasks(membership.id, status);
    return NextResponse.json(assignments);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}