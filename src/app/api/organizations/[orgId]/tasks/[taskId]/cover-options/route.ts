/**
 * Cover Options API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/tasks/[taskId]/cover-options
 *
 * Who could take this shift, ranked. Read-only — it assigns nobody.
 *
 * Exists for the manager answering a withdrawal or a decline request. That
 * decision is "should I let them off", and the thing it turns on is whether
 * anybody else can do it — which the product made them go and find out
 * somewhere else, so in practice they answered without knowing.
 *
 * ## Why not the existing /suggest endpoint
 *
 * Two reasons, and both matter. `/suggest` calls the AI providers, and this is
 * opened while thinking rather than while acting — it must not cost a call each
 * time or fail when a provider is down. And it is gated on
 * `allocation:use_suggestions`, which is a different question from "may you
 * decide who works this shift": `tasks:assign` is what the decision itself
 * needs, and it is what the buttons beside this are gated on. An org that has
 * switched AI suggestions off for its managers has not thereby said they should
 * answer withdrawal requests blind.
 *
 * Rate limit tier: relaxed — it is a read, and a manager may open it repeatedly
 * while working through a queue.
 */
import { NextRequest, NextResponse } from "next/server";
import { AllocationService } from "@/services/allocation.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";
import { planRefusal } from "@/lib/api-utils";

const allocationService = new AllocationService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; taskId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, taskId } = await params;

    const gate = await requirePermission(user.id, orgId, "tasks:assign");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    // Department scope, same as every other per-task route. A manager must not
    // learn who is free in a department they cannot see.
    if (!(await accessService.isTaskInScope(taskId, membership))) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const options = await allocationService.coverOptions(taskId, orgId);
    return NextResponse.json({ options });
  } catch (error) {
    /*
     * `smart_suggestions`, enforced in `AllocationService.coverOptions` and
     * not by the guard above — which checks `tasks:assign`, a permission Free
     * keeps because deciding who works a shift IS the Free product. Only the
     * ranked shortlist behind the decision moved above Free.
     */
    const plan = planRefusal(error);
    if (plan) return plan;

    // Raised by buildCandidatePool for a task in another tenant. Answered as a
    // 404 rather than falling through to a 500, which is what the handler
    // beside this one does and what the route contract expects.
    if (error instanceof Error && error.message === "Task not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[Cover Options Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
