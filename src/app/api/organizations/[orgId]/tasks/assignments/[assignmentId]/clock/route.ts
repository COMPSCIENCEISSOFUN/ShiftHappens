/**
 * Clock Correction API Endpoint (Boundary Layer)
 * PATCH /api/organizations/[orgId]/tasks/assignments/[assignmentId]/clock
 *
 * A manager amends a recorded clock in or out time, with a reason.
 *
 * ## Its own permission
 *
 * `assignments:correct_clock`, not `tasks:assign`. Rostering somebody decides
 * the future; amending a clock time rewrites the record of what already
 * happened, on the field the hours totals are built from. An organisation may
 * reasonably grant one without the other — a shift lead who books people should
 * not necessarily be able to change how long they were paid for.
 *
 * ## Its own route, not a method on the sibling
 *
 * The file next door cancels an assignment on `tasks:assign`. Adding a PATCH
 * there would put two different authorities behind one path, and the route
 * manifest — which records one role per (path, method) — would be telling the
 * truth about half of it.
 */
import { NextRequest, NextResponse } from "next/server";

import { TaskAssignmentService } from "@/services/task-assignment.service";
import { AccessService } from "@/services/access.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { correctClockSchema } from "@/lib/validations";

const assignmentService = new TaskAssignmentService();
const accessService = new AccessService();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; assignmentId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, assignmentId } = await params;

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(
      user.id,
      orgId,
      "assignments:correct_clock"
    );
    if (!gate.ok) return gate.response;

    /*
     * A department-scoped manager may correct only their own department's
     * shifts. Same check the cancel route next door applies, for the same
     * reason: being able to reach an assignment is not the same as owning it.
     */
    if (
      !(await accessService.isAssignmentTaskInScope(assignmentId, gate.membership))
    ) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    const parsed = correctClockSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await assignmentService.correctClock(
      assignmentId,
      orgId,
      user.id,
      {
        clockInTime: parsed.data.clockInTime
          ? new Date(parsed.data.clockInTime)
          : null,
        clockOutTime: parsed.data.clockOutTime
          ? new Date(parsed.data.clockOutTime)
          : null,
        reason: parsed.data.reason,
      }
    );

    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Assignment not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    /*
     * Every rule the service states, mapped. Letting one fall through to a 500
     * would show a manager "Internal server error" for a clock-out they typed
     * before the clock-in — a mistake with an obvious fix, reported as a fault
     * in the system.
     */
    if (
      message.includes("reason is required") ||
      message.includes("must be after") ||
      message.includes("needs a clock in")
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
