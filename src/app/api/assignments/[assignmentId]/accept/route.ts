/**
 * Accept Assignment API Endpoint (Boundary Layer)
 * POST /api/assignments/[assignmentId]/accept
 * 
 * Staff action — accepts a pending task assignment.
 * Requires authentication. Only the assigned member can accept.
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";

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

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const updated = await assignmentService.accept(assignmentId, membership.id);
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Assignment not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("Not authorized") || error.message.includes("Can only")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}