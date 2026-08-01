/**
 * Clock In API Endpoint (Boundary Layer)
 * POST /api/assignments/[assignmentId]/clock-in
 * 
 * Staff action — records start time for an active assignment.
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";

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

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const updated = await assignmentService.clockIn(assignmentId, membership.id);
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Assignment not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("Not authorized") || error.message.includes("Can only") || error.message.includes("Already")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}