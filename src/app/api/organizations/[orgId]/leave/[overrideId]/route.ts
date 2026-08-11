/**
 * Leave Review API Endpoint (Boundary Layer)
 * PATCH /api/organizations/[orgId]/leave/[overrideId] — approve, reject or
 * dismiss
 *
 * Body: { decision: "approved" | "rejected" | "dismissed" }
 *
 * Which verdicts are legal depends on the ROW, not on the request: a lapsed
 * request takes only "dismissed" and a live one takes only the other two. The
 * service decides, because a row lapses with the passage of time rather than
 * with anything the caller does.
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";
import type { LeaveVerdict } from "@/services/availability.service";

/*
 * Typed against the service's union rather than restated as three strings, so
 * a verdict added there without being accepted here is a compile error instead
 * of a 400 nobody expected.
 */
const VERDICTS: readonly LeaveVerdict[] = ["approved", "rejected", "dismissed"];

const availService = new AvailabilityService();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; overrideId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, overrideId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(
      user.id,
      orgId,
      "members:request_availability"
    );
    if (!gate.ok) return gate.response;

    const body = await request.json().catch(() => ({}));
    const decision = body?.decision;
    if (!VERDICTS.includes(decision)) {
      return NextResponse.json(
        { error: "decision must be 'approved', 'rejected' or 'dismissed'" },
        { status: 400 }
      );
    }

    /*
     * Ownership and department scope are proved in the SERVICE.
     *
     * They used to be proved here, which meant this route imported
     * `AvailabilityRepository` and `MembershipRepository` and read them
     * directly — Boundary reaching Entity, which the architecture forbids. The
     * rule about who may review whose leave is a business rule, so it belongs
     * where the business rules are; leaving it in the route made it a rule this
     * one endpoint happened to enforce.
     */
    const reviewed = await availService.reviewLeave(
      overrideId,
      decision,
      user.id,
      orgId,
      departmentScopeFor(gate.membership)
    );
    return NextResponse.json(reviewed);
  } catch (error) {
    /*
     * 403, not 400. The request is well-formed and the caller holds the
     * permission — what they lack is standing on this particular request, which
     * is what 403 means. A 400 would read as "you sent something malformed" and
     * send a manager looking for a typo.
     */
    if (error instanceof Error && error.message.includes("your own leave")) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof Error && error.message.includes("already been reviewed")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    /*
     * 400: the verdict does not fit the row's state. Handled on the handler
     * that can actually raise it rather than left to fall through to 500 — the
     * screen refreshes and shows the right buttons on a retry, which a 500
     * would not tell it to do.
     */
    if (
      error instanceof Error &&
      (error.message.includes("already passed") ||
        error.message.includes("must be approved or declined"))
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Error && error.message === "Leave request not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[Leave Review Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
