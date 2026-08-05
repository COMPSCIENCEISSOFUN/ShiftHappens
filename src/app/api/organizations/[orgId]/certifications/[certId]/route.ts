/**
 * Single Certification API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/certifications/[certId] — Get details
 * PATCH /api/organizations/[orgId]/certifications/[certId] — Verify/reject
 * POST  /api/organizations/[orgId]/certifications/[certId] — Revoke a verified one
 * DELETE /api/organizations/[orgId]/certifications/[certId] — Withdraw (owner, pending only)
 *
 * PATCH and POST require admin/manager. DELETE is restricted to the member who
 * submitted it, and only while still pending: once a manager has acted, the
 * record is an audit artifact and is revoked rather than removed.
 */
import { NextRequest, NextResponse } from "next/server";
import { CertificationService } from "@/services/certification.service";
import {
  revokeCertificationSchema,
  verifyCertificationSchema,
} from "@/lib/validations";
import { validationErrorResponse } from "@/lib/api-utils";
import { getAuthenticatedUser, unauthorizedResponse, checkOrgSuspended } from "@/lib/auth-guard";
import { departmentScopeFor } from "@/lib/department-scope";
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";

const certService = new CertificationService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; certId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, certId } = await params;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Scoped like the listing endpoint next door. A certification id is not
    // a secret — they come back in dashboard and eligibility payloads — so an
    // unscoped read here reopened exactly what the list closed.
    const cert = await certService.getById(
      certId,
      orgId,
      departmentScopeFor(membership)
    );
    if (!cert) {
      return NextResponse.json({ error: "Certification not found" }, { status: 404 });
    }

    return NextResponse.json(cert);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; certId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, certId } = await params;

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "certifications:review");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const parsed = verifyCertificationSchema.safeParse(body);

    if (!parsed.success) return validationErrorResponse(parsed.error);

    const updated = await certService.updateStatus(
      certId,
      orgId,
      parsed.data.status,
      user.id,
      {
        rejectionReason: parsed.data.rejectionReason,
        rejectionNotes: parsed.data.rejectionNotes,
      },
      departmentScopeFor(gate.membership)
    );
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Certification not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (
        error.message.includes("Can only") ||
        error.message.includes("A reason is required")
      ) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Revoke a verified certification. Separate verb from PATCH because it is a
 * different transition with different preconditions — PATCH decides a pending
 * submission, POST withdraws one already honoured.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; certId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, certId } = await params;

    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const gate = await requirePermission(user.id, orgId, "certifications:review");
    if (!gate.ok) return gate.response;

    const body = await request.json();
    const parsed = revokeCertificationSchema.safeParse(body);

    if (!parsed.success) return validationErrorResponse(parsed.error);

    const updated = await certService.revoke(
      certId,
      orgId,
      user.id,
      {
        rejectionReason: parsed.data.rejectionReason,
        rejectionNotes: parsed.data.rejectionNotes,
      },
      departmentScopeFor(gate.membership)
    );
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Certification not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message.includes("Can only")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; certId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId, certId } = await params;

    // The remaining ungated write in this file. Ownership and status are
    // enforced in the service, so the exposure is small — but PATCH and POST
    // beside it are both gated and this was not.
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // The service verifies that the caller owns it and that it is still
    // pending. Previously ANY member of the org could delete ANY colleague's
    // verified certification, silently changing who was eligible for work.
    await certService.delete(certId, orgId, membership.id, user.id);
    return NextResponse.json({ message: "Certification withdrawn" });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Certification not found") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error.message === "Not authorized") {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      if (error.message.includes("Only a pending")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}