/**
 * Withdrawal Decision API Endpoint (Boundary Layer)
 * POST /api/assignments/[assignmentId]/withdrawal
 *
 * Manager/Admin action — approves or denies a staff member's pending
 * withdrawal request (US-76). Approve unassigns the staff member (frees the
 * slot); deny keeps them assigned. The staff member is notified either way.
 *
 * Body: { decision: "approve" | "deny" }
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { withdrawalDecisionSchema } from "@/lib/validations";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";

const assignmentService = new TaskAssignmentService();
const accessService = new AccessService();

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

    // Suspension is checked on the org from the query string, which is the same
    // org the assignment belongs to: the membership resolved below is the
    // caller's membership IN THAT ORG, and every service method here refuses an
    // assignment that membership does not own. Passing some other org's id
    // therefore cannot reach the assignment — it just fails ownership.
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    // Only managers/admins can resolve withdrawal requests.
    const gate = await requirePermission(user.id, orgId, "tasks:assign");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    // Managers can only resolve withdrawals for tasks in their department scope.
    if (!(await accessService.isAssignmentTaskInScope(assignmentId, membership))) {
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
      // 403, not 400 — the caller holds the permission, just not over this row.
      if (error.message === "You cannot resolve your own withdrawal request") {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      if (error.message.includes("No pending withdrawal")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
