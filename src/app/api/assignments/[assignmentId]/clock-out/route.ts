/**
 * Clock Out API Endpoint (Boundary Layer)
 * POST /api/assignments/[assignmentId]/clock-out
 *
 * Staff action — records end time and completes the assignment.
 *
 * DELIBERATELY NOT GUARDED BY checkOrgSuspended, unlike its six siblings.
 *
 * Suspension freezes a tenant's operations, and every other assignment action
 * (accept, reject, clock-in, complete, withdraw, withdrawal) either starts new
 * work or creates a new obligation, so all six refuse a suspended org. Clocking
 * out is the one action that only ENDS work already in progress. A member can
 * only reach it if they are already clocked in, and blocking it would strand
 * them mid-shift with no way to close the record — the hours they actually
 * worked would never be written, which is a payroll problem, not a billing
 * lever. The org can be suspended between clock-in and clock-out for reasons
 * the staff member has no control over.
 *
 * The suspension still bites: `complete` is guarded, so the assignment stops at
 * "clocked_out" until the org is reactivated. Nothing new is started.
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
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

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const updated = await assignmentService.clockOut(assignmentId, membership.id);
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Assignment not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("Not authorized") || error.message.includes("Must clock") || error.message.includes("Already")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}