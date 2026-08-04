/**
 * Rate Shift API Endpoint (Boundary Layer)
 * POST /api/assignments/[assignmentId]/rate?orgId=...
 *
 * Staff action — the assigned member's own 1–5 rating of a shift they worked,
 * with an optional comment. Only the assigned member may rate, and only a
 * shift that has been clocked out of or completed.
 *
 * Re-posting replaces the previous rating; the audit log keeps every
 * submission, so a correction does not erase what was first said.
 */
import { NextRequest, NextResponse } from "next/server";
import { TaskAssignmentService } from "@/services/task-assignment.service";
import { rateShiftSchema } from "@/lib/validations";
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

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    // The membership resolved here is the caller's membership in that org, and
    // the service refuses any assignment it does not own — so naming a
    // different org in the query string cannot reach someone else's shift.
    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = rateShiftSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await assignmentService.rate(
      assignmentId,
      membership.id,
      parsed.data.rating,
      parsed.data.comment
    );
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Assignment not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      // Every remaining known message is the caller asking for something the
      // rules forbid — wrong member, wrong status, out-of-range score. Left to
      // fall through, these would all be 500s, which reads as a broken server
      // rather than a refused request.
      if (
        error.message.includes("Not authorized") ||
        error.message.includes("Can only") ||
        error.message.includes("Rating must be")
      ) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
