/**
 * Single Task API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/tasks/[taskId] — Get task details
 * PATCH /api/organizations/[orgId]/tasks/[taskId] — Update task
 * DELETE /api/organizations/[orgId]/tasks/[taskId] — Delete task
 * 
 * Requires authentication. Update/delete require Admin or Manager role.
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskService } from "@/services/task.service";
import { updateTaskSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { isTaskInScope } from "@/lib/department-scope";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const taskService = new TaskService();
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
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_READ)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Managers can only view tasks within their department scope.
    if (!(await isTaskInScope(taskId, membership))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const task = await taskService.getById(taskId, orgId);
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    return NextResponse.json(task);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; taskId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, taskId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_UPDATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!(await isTaskInScope(taskId, membership))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = updateTaskSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await taskService.update(taskId, orgId, parsed.data, user.id);
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Task not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("start and end time") || error.message.includes("End time must be after")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; taskId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, taskId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_DELETE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!(await isTaskInScope(taskId, membership))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    await taskService.delete(taskId, orgId, user.id);
    return NextResponse.json({ message: "Task deleted" });
  } catch (error) {
    if (error instanceof Error && error.message === "Task not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
