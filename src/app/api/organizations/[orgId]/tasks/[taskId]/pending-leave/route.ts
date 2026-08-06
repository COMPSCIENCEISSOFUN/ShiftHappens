/**
 * Pending Leave For A Task API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/tasks/[taskId]/pending-leave
 *
 * Who has asked for the day(s) this shift runs on, and not yet been answered.
 *
 * The assign screen shows this beside a candidate so a manager does not roster
 * over an unanswered request without knowing. It is a WARNING, not a gate — the
 * chosen model is that leave binds on approval, and a manager who needs
 * somebody on a day they asked off may still say so.
 *
 * Gated like its neighbours `eligibility` and `composition`: same panel, same
 * moment, same question about who may work a shift.
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const availService = new AvailabilityService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; taskId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, taskId } = await params;

    const gate = await requirePermission(user.id, orgId, "eligibility:view");
    if (!gate.ok) return gate.response;

    if (!(await accessService.isTaskInScope(taskId, gate.membership))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    return NextResponse.json(
      await availService.getPendingLeaveForTask(
        taskId,
        orgId,
        departmentScopeFor(gate.membership)
      )
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Task not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[Task Pending Leave Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
