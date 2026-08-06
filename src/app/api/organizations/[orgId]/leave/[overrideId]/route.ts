/**
 * Leave Review API Endpoint (Boundary Layer)
 * PATCH /api/organizations/[orgId]/leave/[overrideId] — approve or reject
 *
 * Body: { decision: "approved" | "rejected" }
 */
import { NextRequest, NextResponse } from "next/server";
import { AvailabilityService } from "@/services/availability.service";
import { AvailabilityRepository } from "@/repositories/availability.repository";
import { MembershipRepository } from "@/repositories/membership.repository";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor, isDepartmentInScope } from "@/lib/department-scope";

const availService = new AvailabilityService();
const availRepo = new AvailabilityRepository();
const membershipRepo = new MembershipRepository();

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
    if (decision !== "approved" && decision !== "rejected") {
      return NextResponse.json(
        { error: "decision must be 'approved' or 'rejected'" },
        { status: 400 }
      );
    }

    const override = await availRepo.getOverrideById(overrideId);
    if (!override) {
      return NextResponse.json({ error: "Leave request not found" }, { status: 404 });
    }

    /*
     * Two guards, both answering 404.
     *
     * The request arrives with an id from a list the caller was shown, but an
     * id in a URL is a claim: it has to be proved to belong to THIS
     * organisation, and to a member inside the reviewer's department scope.
     * Without the second, a Kitchen manager could approve leave for Front of
     * House by id — the exact class of gap the 2026-08-05 audit found in four
     * reporting surfaces.
     */
    const subject = await membershipRepo.findById(override.membershipId);
    if (!subject || subject.organizationId !== orgId) {
      return NextResponse.json({ error: "Leave request not found" }, { status: 404 });
    }

    const scope = departmentScopeFor(gate.membership);
    if (scope !== null) {
      const subjectDepts = await membershipRepo.findByIdWithDetails(subject.id);
      const inScope = (subjectDepts?.departmentMemberships ?? []).some(
        (dm: { department: { id: string } }) =>
          isDepartmentInScope(dm.department.id, scope)
      );
      if (!inScope) {
        return NextResponse.json({ error: "Leave request not found" }, { status: 404 });
      }
    }

    const reviewed = await availService.reviewLeave(overrideId, decision, user.id);
    return NextResponse.json(reviewed);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already been reviewed")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Error && error.message === "Leave request not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[Leave Review Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
