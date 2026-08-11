/**
 * Tasks API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/tasks — Create task
 * GET /api/organizations/[orgId]/tasks — List tasks with filters
 * 
 * Create requires Company Admin or Manager role.
 * List is accessible to all org members.
 */
import { NextRequest, NextResponse } from "next/server";
import { TASK_LIST_READERS } from "@/lib/permissions";
import { TaskService } from "@/services/task.service";
import { createTaskSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { requirePermission, requireAnyPermission } from "@/lib/permission-guard";
import { SubscriptionLimitError, FeatureNotAvailableError } from "@/lib/subscription-tiers";
import { departmentScopeFor, isDepartmentInScope } from "@/lib/department-scope";

const taskService = new TaskService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "tasks:create");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    const body = await request.json();
    const parsed = createTaskSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // A scoped manager may only create tasks within their own department(s).
    const scope = departmentScopeFor(membership);
    if (scope !== null && !isDepartmentInScope(parsed.data.departmentId, scope)) {
      return NextResponse.json(
        { error: "You can only create tasks in your assigned department(s)." },
        { status: 403 }
      );
    }

    const task = await taskService.create(parsed.data, orgId, user.id);
    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    if (error instanceof SubscriptionLimitError || error instanceof FeatureNotAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    // Every validation error TaskService.create can raise, mapped to 400.
    // Previously only "End time must be after start time" was handled, so the
    // other three reached the client as a 500 — a server-fault status for what
    // is squarely a bad request, and no usable message. The sibling PATCH on
    // tasks/[taskId] already caught its equivalents.
    //
    // Source: task.service.ts create() — lines 43, 50, 58, 61.
    if (
      error instanceof Error &&
      // A department from another tenant is reported as missing, not as
      // forbidden — the two must be indistinguishable, or the endpoint becomes
      // a way to test whether a foreign id exists.
      error.message === "Department not found"
    ) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof Error &&
      (error.message === "End time must be after start time" ||
        error.message === "Must provide both start and end time, or neither" ||
        error.message === "A recurring task must have a start and end time" ||
        error.message === "Invalid recurrence pattern")
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    /*
     * Membership alone was the whole check, so any staff member who typed the
     * URL got this list in full — while the sidebar hid the link. The menu was
     * right; the route was the half that had not been tightened. The readers
     * are the task board and the calendar.
     */
    const gate = await requireAnyPermission(user.id, orgId, TASK_LIST_READERS);
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    const { searchParams } = new URL(request.url);
    const filters = {
      status: searchParams.get("status") || undefined,
      departmentId: searchParams.get("departmentId") || undefined,
      priority: searchParams.get("priority") || undefined,
    };

    // Managers see only their department(s); company admins see everything.
    const tasks = await taskService.getByOrganization(
      orgId,
      filters,
      departmentScopeFor(membership),
      { id: membership.id, userId: membership.userId, role: membership.role }
    );
    return NextResponse.json(tasks);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
