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
import { MembershipRepository } from "@/repositories/membership.repository";
import { isTaskInScope } from "@/lib/department-scope";

const taskService = new TaskService();
const membershipRepo = new MembershipRepository();

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

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !["company_admin", "manager"].includes(membership.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!(await isTaskInScope(taskId, membership))) {
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
      if (
        error.message.includes("headcount") ||
        error.message.includes("conflict") ||
        error.message.includes("cannot be assigned") ||
        error.message.includes("task department") ||
        error.message.includes("already has an assignment") ||
        error.message.includes("Duplicate staff")
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
