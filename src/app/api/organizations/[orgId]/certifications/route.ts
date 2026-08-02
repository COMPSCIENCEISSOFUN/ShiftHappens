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
import { getAuthenticatedUser, unauthorizedResponse } from "@/lib/auth-guard";
import { MembershipRepository } from "@/repositories/membership.repository";
import { CertificationDefinitionService } from "@/services/certification-definition.service";
import { departmentScopeFor } from "@/lib/department-scope";
import { hasPermission, PERMISSIONS } from "@/lib/permission-guard";

const certService = new CertificationService();
const membershipRepo = new MembershipRepository();
const definitionService = new CertificationDefinitionService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return unauthorizedResponse();

    const { orgId } = await params;

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
    if (!membership || !hasPermission(membership, PERMISSIONS.CERTIFICATIONS_READ)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || undefined;

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

    const membership = await membershipRepo.findByUserAndOrg(user.id, orgId);
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

    const name = await definitionService.resolveSubmissionName(
      orgId,
      parsed.data.name
    );
    const cert = await certService.create(membership.id, {
      ...parsed.data,
      name,
    });
    return NextResponse.json(cert, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Select an active certification definition"
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
