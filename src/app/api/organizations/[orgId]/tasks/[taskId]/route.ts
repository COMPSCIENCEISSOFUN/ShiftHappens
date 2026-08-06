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
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor, isDepartmentInScope } from "@/lib/department-scope";

const taskService = new TaskService();
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
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Managers can only view tasks within their department scope.
    if (!(await accessService.isTaskInScope(taskId, membership))) {
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

    const gate = await requirePermission(user.id, orgId, "tasks:update");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    if (!(await accessService.isTaskInScope(taskId, membership))) {
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

    /*
     * The destination department, not just the current one.
     *
     * `isTaskInScope` above proves the caller may REACH this task, which says
     * nothing about where they may send it. Without this a Kitchen manager
     * could PATCH `{ departmentId: <security-dept> }` and hand a shift to
     * another department — or PATCH `{ departmentId: null }`, which
     * `isDepartmentInScope` treats as out of scope for every non-admin, making
     * the task invisible and unmanageable to all managers at once.
     *
     * The create path next door already does exactly this on the submitted
     * department; update was the asymmetry.
     */
    const scope = departmentScopeFor(membership);
    if (
      parsed.data.departmentId !== undefined &&
      scope !== null &&
      !isDepartmentInScope(parsed.data.departmentId, scope)
    ) {
      return NextResponse.json({ error: "Department not found" }, { status: 404 });
    }

    const updated = await taskService.update(taskId, orgId, parsed.data);
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.message === "Task not found" ||
        error.message === "Department not found"
      ) {
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

    const gate = await requirePermission(user.id, orgId, "tasks:delete");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    if (!(await accessService.isTaskInScope(taskId, membership))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    await taskService.delete(taskId, orgId);
    return NextResponse.json({ message: "Task deleted" });
  } catch (error) {
    if (error instanceof Error && error.message === "Task not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}