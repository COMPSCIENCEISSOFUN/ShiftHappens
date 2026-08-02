/**
 * Withdrawal Decision API Endpoint (Boundary Layer)
 * POST /api/assignments/[assignmentId]/withdrawal
 *
 * Manager/Admin action — approves or denies a staff member's pending
 * withdrawal request (US-76). Approve marks the preserved assignment row as
 * withdrawn; deny restores the pre-request active state. The staff member is
 * notified either way.
 *
 * Body: { decision: "approve" | "deny" }
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { withdrawalDecisionSchema } from "@/lib/validations";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { isAssignmentTaskInScope } from "@/lib/department-scope";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const assignmentService = new TaskAssignmentService();
const membershipRepo = new MembershipRepository();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { assignmentId } = await params;

    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) {
      return NextResponse.json({ error: "orgId required" }, { status: 400 });
    }

    // Only managers/admins can resolve withdrawal requests.
    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.TASKS_ASSIGN)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Managers can only resolve withdrawals for tasks in their department scope.
    if (!(await isAssignmentTaskInScope(assignmentId, membership))) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = withdrawalDecisionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await assignmentService.resolveWithdrawal(
      assignmentId,
      parsed.data.decision,
      user.id,
      orgId
    );
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Assignment not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("No pending withdrawal")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
