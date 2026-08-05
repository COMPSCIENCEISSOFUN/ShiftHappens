/**
 * Task Assignment API Endpoint (Boundary Layer)
 * POST /api/organizations/[orgId]/tasks/[taskId]/assign — Assign staff
 * 
 * Requires Admin or Manager role.
 * Validates headcount and scheduling conflicts.
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskService } from "@/services/task.service";
import { assignTaskSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";

const taskService = new TaskService();
const accessService = new AccessService();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; taskId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, taskId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "tasks:assign");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    if (!(await accessService.isTaskInScope(taskId, membership))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = assignTaskSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const assignments = await taskService.assignStaff(
      taskId,
      orgId,
      parsed.data.membershipIds,
      user.id
    );
    return NextResponse.json(assignments, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      // "already has a record on this task" is a conflict with existing state,
      // not bad input — the same 409 as a headcount breach.
      if (
        error.message.includes("headcount") ||
        error.message.includes("conflict") ||
        error.message.includes("already has a record on this task") ||
        error.message.includes("cannot be assigned")
      ) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error.message === "Task not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("does not belong to this organization")) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}