/**
 * Composition Annotations API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/tasks/[taskId]/composition
 *
 * The task's composition rules plus each candidate's attributes, so the assign
 * panel can say which person fills a gap and which one will be refused —
 * recomputed in the browser as selections change rather than one request per
 * tick.
 *
 * Sibling of the eligibility endpoint and gated the same way: same panel, same
 * moment, same question about who may work a shift. Deliberately separate from
 * it because composition is a property of the GROUP and eligibility of the
 * individual, and folding one into the other is the design mistake this whole
 * mechanism exists to avoid.
 */
import { NextRequest, NextResponse } from "next/server";
import { CompositionService } from "@/services/composition.service";
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";

const compositionService = new CompositionService();
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
      await compositionService.describeForTask(taskId, orgId)
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Task not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[Task Composition Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
