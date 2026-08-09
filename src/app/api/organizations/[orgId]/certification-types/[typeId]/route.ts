/**
 * Certification Type API Endpoint (Boundary Layer)
 * DELETE /api/organizations/[orgId]/certification-types/[typeId]
 *
 * There is no PATCH, deliberately. Nothing references a type by id — tasks and
 * member certificates both store NAMES — so a rename here would change what the
 * organisation offers without changing anything already written, leaving rows
 * pointing at a word the list no longer contains. Remove and add says the same
 * thing without the illusion.
 */
import { NextRequest, NextResponse } from "next/server";
import { CertificationTypeService } from "@/services/certification-type.service";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { requirePermission } from "@/lib/permission-guard";

const typeService = new CertificationTypeService();

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; typeId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, typeId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "certifications:review");
    if (!gate.ok) return gate.response;

    await typeService.remove(typeId, orgId, user.id);
    return NextResponse.json({ message: "Removed from the list" });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Certificate not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      /*
       * 409, and the message carries the count. The request is well formed and
       * the organisation's current state refuses it — the same answer the roles
       * endpoint gives for a role a work rule still targets, and for the same
       * reason: a 500 would discard the one sentence that says what to do.
       */
      if (error.message.startsWith("Cannot remove:")) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
