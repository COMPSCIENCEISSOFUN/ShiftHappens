/**
 * Certifications API Endpoint (Boundary Layer)
 * GET /api/organizations/[orgId]/certifications — List org certifications
 * POST /api/organizations/[orgId]/certifications — Submit certification
 * 
 * GET requires admin/manager. POST is for the member's own certifications.
 */
import { NextRequest, NextResponse } from "next/server";
import { CertificationService } from "@/services/certification.service";
import { createCertificationSchema } from "@/lib/validations";
import {
  getAuthenticatedUser,
  unauthorizedResponse,
  checkOrgSuspended,
} from "@/lib/auth-guard";
import { AccessService } from "@/services/access.service";
import { requirePermission } from "@/lib/permission-guard";
import { departmentScopeFor } from "@/lib/department-scope";

const certService = new CertificationService();
const accessService = new AccessService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const gate = await requirePermission(user.id, orgId, "certifications:review");
    if (!gate.ok) return gate.response;
    const membership = gate.membership;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || undefined;

    // Managers see only their department(s)' staff; company admins see everyone.
    const certs = await certService.getByOrganization(
      orgId,
      status,
      departmentScopeFor(membership)
    );
    return NextResponse.json(certs);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;
    const suspended = await checkOrgSuspended(orgId);
    if (suspended) return suspended;

    const membership = await accessService.getMembership(user.id, orgId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createCertificationSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const cert = await certService.create(membership.id, parsed.data, {
      organizationId: orgId,
      userId: user.id,
    });
    return NextResponse.json(cert, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}