/**
 * Decline Decision API Endpoint (Boundary Layer)
 * POST /api/assignments/[assignmentId]/decline
 *
 * Manager/Admin action — approves or denies a FULL-TIME member's request to be
 * taken off a shift they were rostered onto but had not yet accepted.
 *
 * Approve frees the slot and records the rejection with the reason the member
 * gave. Deny returns the assignment to pending; the member is still rostered
 * and still owes an answer. The member is notified either way.
 *
 * Separate from the withdrawal endpoint because it resolves a different state
 * at a different point in the lifecycle — see `decline_requested` in
 * `src/lib/assignment-status.ts`.
 *
 * Body: { decision: "approve" | "deny" }
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { declineDecisionSchema } from "@/lib/validations";
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

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    // Only managers/admins can resolve decline requests.
    const gate = await requirePermission(user.id, orgId, "tasks:assign");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    // Managers can only resolve declines for tasks in their department scope.
    if (!(await accessService.isAssignmentTaskInScope(assignmentId, membership))) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = declineDecisionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await assignmentService.resolveDecline(
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
      // 403, not 400 — the caller holds the permission, just not over this
      // row. No change to the request can make it acceptable.
      if (error.message === "You cannot resolve your own decline request") {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      if (error.message.includes("No pending decline")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
